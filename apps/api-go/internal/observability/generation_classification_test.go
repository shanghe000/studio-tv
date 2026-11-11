package observability

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/httpapi"
)

func TestGenerationAlertMeaningFollowsTerminalStateAndSubmissionStage(t *testing.T) {
	for _, row := range []struct {
		name, stage, state, code, title, explanation, level string
	}{
		{"upstream retry", "UPSTREAM_RETRY", "RETRY_PENDING", "TRANSPORT_UNAVAILABLE", "Studio TV 任务自动重试", "任务未终止", "WARN"},
		{"retry stage", "UPSTREAM_RETRY", "RUNNING", "RATE_LIMITED", "Studio TV 任务自动重试", "请勿重复提交", "WARN"},
		{"pending state", "TASK_UPDATED", "RETRY_PENDING", "PROVIDER_BUSY", "Studio TV 任务自动重试", "请勿重复提交", "WARN"},
		{"draft conflict", "CLIENT_PREFLIGHT", "REJECTED", "LOCAL_DRAFT_CONFLICT", "Studio TV 画布同步待完成", "生成尚未提交，画布同步检查未通过；本地修改已保留。", "WARN"},
		{"other preflight", "CLIENT_PREFLIGHT", "REJECTED", "MEDIA_INPUT_INVALID", "Studio TV 提交未通过", "本次生成尚未提交", "WARN"},
		{"other rejection", "ACCEPTANCE", "REJECTED", "MODEL_UNAVAILABLE", "Studio TV 提交未通过", "本次生成尚未提交", "WARN"},
		{"real failure", "TASK_UPDATED", "FAILED", "COMFY_GENERATION_FAILED", "Studio TV 生成失败", "任务已终止", "ERROR"},
		{"timeout", "TASK_UPDATED", "TIMED_OUT", "DEADLINE_EXCEEDED", "Studio TV 生成失败", "任务已终止", "ERROR"},
		{"terminal failure wins over retry stage", "UPSTREAM_RETRY", "FAILED", "PROVIDER_FAILED", "Studio TV 生成失败", "任务已终止", "ERROR"},
		{"success with stale notify", "UPSTREAM_RETRY", "SUCCEEDED", "PROVIDER_BUSY", "", "", "INFO"},
		{"cancellation wins over retry stage", "UPSTREAM_RETRY", "CANCELED", "", "Studio TV 任务已取消", "任务已取消", "INFO"},
	} {
		t.Run(row.name, func(t *testing.T) {
			var received []postLocale
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var message struct {
					Content postContent `json:"content"`
				}
				if err := json.NewDecoder(r.Body).Decode(&message); err != nil {
					t.Error(err)
				}
				received = append(received, message.Content.Post["zh_cn"])
				_, _ = w.Write([]byte(`{"code":0}`))
			}))
			defer endpoint.Close()
			o, logs := testObserver(t, Config{WebhookURL: endpoint.URL})
			lookups := 0
			o.SetActorNameResolver(func(context.Context, string) (string, error) { lookups++; return "协作成员", nil })
			g := Generation{TaskID: "tsk_classification", ActorID: "usr_actor", ProjectID: "prj_classification", NodeID: "node_test", ExecutionID: "exe_test", InvocationRef: "inv_test", CapabilityRef: "h3-motion-transfer-v1", CapabilityVersion: "2", Stage: row.stage, State: row.state, ErrorCode: row.code, Notify: true}
			before := g
			o.Generation(WithLogID(context.Background(), "request_classification"), g)
			if err := o.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			if g != before {
				t.Fatal("observability mutated the task observation")
			}
			var lifecycle map[string]any
			if err := json.Unmarshal([]byte(strings.Split(logs.String(), "\n")[0]), &lifecycle); err != nil {
				t.Fatal(err)
			}
			if lifecycle["state"] != row.state || lifecycle["level"] != row.level || lifecycle["log_id"] != TaskLogID(g.TaskID) || lifecycle["request_id"] != "request_classification" {
				t.Fatal("lifecycle evidence changed meaning", lifecycle)
			}
			if row.title == "" {
				if len(received) != 0 || lookups != 0 {
					t.Fatal("successful task produced a failure/retry alert", received)
				}
				return
			}
			if len(received) != 1 || received[0].Title != row.title {
				t.Fatal("wrong lifecycle notification", received)
			}
			raw, _ := json.Marshal(received[0])
			for _, want := range []string{row.explanation, "usr_actor", "协作成员", TaskLogID(g.TaskID), "prj_classification", "node_test", "exe_test", "inv_test", row.stage, row.state} {
				if !strings.Contains(string(raw), want) {
					t.Fatalf("lost %q from notification %s", want, raw)
				}
			}
		})
	}
}

func TestDraftConflictDeduplicatesByActorAndProjectWithoutSuppressingFailures(t *testing.T) {
	var received []string
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var message struct {
			Content postContent `json:"content"`
		}
		_ = json.NewDecoder(r.Body).Decode(&message)
		received = append(received, message.Content.Post["zh_cn"].Title)
		_, _ = w.Write([]byte(`{"code":0}`))
	}))
	defer endpoint.Close()
	var seconds atomic.Int64
	seconds.Store(100)
	o, logs := testObserver(t, Config{WebhookURL: endpoint.URL, RateWindow: time.Minute, Clock: func() time.Time { return time.Unix(seconds.Load(), 0) }})
	g := Generation{ActorID: "usr_actor", ProjectID: "prj_a", Stage: "CLIENT_PREFLIGHT", State: "REJECTED", ErrorCode: "LOCAL_DRAFT_CONFLICT", Notify: true}
	o.Generation(WithLogID(context.Background(), "request_a"), g)
	g.NodeID, g.SceneCode = "node_b", "scene_b"
	o.Generation(WithLogID(context.Background(), "request_b"), g) // same actor/project, another node
	g.ProjectID = "prj_b"
	o.Generation(context.Background(), g)
	g.ProjectID, g.ActorID = "prj_a", "usr_other"
	o.Generation(context.Background(), g)
	g.ActorID = "usr_actor"
	g.TaskID, g.Stage, g.State, g.ErrorCode = "tsk_a", "UPSTREAM_RETRY", "RETRY_PENDING", "PROVIDER_FAILED"
	o.Generation(context.Background(), g)
	g.Stage, g.State = "TASK_UPDATED", "FAILED"
	o.Generation(context.Background(), g) // same task/error still needs a terminal failure notification
	g.TaskID, g.Stage, g.State, g.ErrorCode = "", "CLIENT_PREFLIGHT", "REJECTED", "LOCAL_DRAFT_CONFLICT"
	seconds.Store(161)
	o.Generation(context.Background(), g) // window elapsed; an unresolved conflict becomes visible again
	if err := o.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if stats := o.Stats(); stats.Sent != 6 || stats.Suppressed != 1 || stats.Dropped != 0 {
		t.Fatal("incorrect conflict/failure deduplication", stats)
	}
	if strings.Count(strings.Join(received, "|"), "Studio TV 画布同步待完成") != 4 || strings.Count(strings.Join(received, "|"), "Studio TV 生成失败") != 1 || strings.Count(strings.Join(received, "|"), "Studio TV 任务自动重试") != 1 {
		t.Fatal("real retry or failure was suppressed", received)
	}
	if strings.Count(logs.String(), `"msg":"generation lifecycle"`) != 7 || !strings.Contains(logs.String(), `"request_id":"request_b"`) {
		t.Fatal("deduplication removed lifecycle evidence", logs.String())
	}
}

func TestClassifiedNoticesKeepUntrustedMetadataOutOfLogsAndWebhook(t *testing.T) {
	var received string
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body any
		_ = json.NewDecoder(r.Body).Decode(&body)
		raw, _ := json.Marshal(body)
		received = string(raw)
		_, _ = w.Write([]byte(`{"code":0}`))
	}))
	defer endpoint.Close()
	o, logs := testObserver(t, Config{WebhookURL: endpoint.URL})
	unsafe := "https://private.invalid/?token=secret-sentinel"
	o.Generation(context.Background(), Generation{ActorID: unsafe, ProjectID: unsafe, NodeID: unsafe, InvocationRef: unsafe, Stage: "CLIENT_PREFLIGHT", State: "REJECTED", ErrorCode: "LOCAL_DRAFT_CONFLICT", Notify: true})
	if err := o.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(received, "Studio TV 画布同步待完成") || strings.Contains(received+logs.String(), "secret-sentinel") || strings.Contains(received+logs.String(), "private.invalid") {
		t.Fatal("untrusted metadata escaped classified diagnostics")
	}
}

func TestSubmissionHTTPRejectionDoesNotRelabelServerFailuresOrPanics(t *testing.T) {
	for _, row := range []struct {
		name, route, title string
		status             int
		panics             bool
	}{
		{"generation validation", "/api/v2/canvas-runs", "Studio TV 提交未通过", 422, false},
		{"generation server failure", "/api/v2/canvas-runs", "Studio TV 接口错误", 500, false},
		{"ordinary server failure", "/api/v2/projects", "Studio TV 接口错误", 503, false},
		{"generation panic", "/api/v2/canvas-runs", "Studio TV 恐慌告警", 500, true},
	} {
		t.Run(row.name, func(t *testing.T) {
			var received []postLocale
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body struct {
					Content postContent `json:"content"`
				}
				_ = json.NewDecoder(r.Body).Decode(&body)
				received = append(received, body.Content.Post["zh_cn"])
				_, _ = w.Write([]byte(`{"code":0}`))
			}))
			defer endpoint.Close()
			o, _ := testObserver(t, Config{WebhookURL: endpoint.URL, ErrorCode: httpapi.ErrorCode})
			router := chi.NewRouter()
			router.Use(httpapi.RequestContext, o.Middleware)
			router.Post(row.route, httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
				if row.panics {
					panic("private panic sentinel")
				}
				return httpapi.Fail(row.status, "SUBMISSION_TEST", "private response sentinel")
			}))
			w := httptest.NewRecorder()
			router.ServeHTTP(w, httptest.NewRequest("POST", row.route, nil))
			if err := o.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			if len(received) != 1 || received[0].Title != row.title {
				t.Fatal("HTTP server error classification changed", received)
			}
			raw, _ := json.Marshal(received[0])
			if strings.Contains(string(raw), "private") || !strings.Contains(string(raw), w.Header().Get("X-Log-ID")) {
				t.Fatal("HTTP diagnostics lost correlation or exposed private values", string(raw))
			}
		})
	}
}
