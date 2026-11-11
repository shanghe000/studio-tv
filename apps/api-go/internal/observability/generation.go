package observability

import (
	"context"
	"fmt"
	"github.com/google/uuid"
	"log/slog"
	"regexp"
	"strings"
	"time"
	"unicode"
)

// IDs are derived from persisted task identities, stable across retries/restarts.
// Acceptance records link the HTTP request_id to the task's log_id.
func TaskLogID(id string) string {
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte("studiotv-generation/"+id)).String()
}
func WithLogID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, logIDContextKey{}, id)
}

type Generation struct {
	// ActorID comes from the verified caller or persisted initiator, never the graph.
	ActorID                                                                                                                           string
	TaskID, ProjectID, NodeID, ExecutionID, Kind, CapabilityRef, CapabilityVersion, SceneCode, InvocationRef, State, ErrorCode, Stage string
	CreatedAt                                                                                                                         time.Time
	Outputs                                                                                                                           int
	Notify                                                                                                                            bool
	Preflight                                                                                                                         *PreflightContext
	ClientSnapshot                                                                                                                    *ClientSnapshot
	RelatedRequestID                                                                                                                  string
}

// SetActorNameResolver installs the application's local user-directory lookup.
// Only alerts look up a name; normal lifecycle events need no extra DB query.
func (o *Observer) SetActorNameResolver(resolve func(context.Context, string) (string, error)) {
	o.mu.Lock()
	o.actorName = resolve
	o.mu.Unlock()
}

func (o *Observer) generationActorName(ctx context.Context, actorID string) string {
	if actorID == "" {
		return ""
	}
	o.mu.Lock()
	resolve := o.actorName
	o.mu.Unlock()
	if resolve == nil {
		return ""
	}
	// A canceled request must not hide the initiator of its persisted task.
	// Lookup failure/timeout never replaces the original generation failure.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 250*time.Millisecond)
	defer cancel()
	name, err := resolve(ctx, actorID)
	if err != nil {
		return ""
	}
	return safeActorName(name)
}

func safeActorName(name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return ' '
		}
		if unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, name)
	runes := []rune(strings.Join(strings.Fields(name), " "))
	if len(runes) > 80 {
		runes = runes[:80]
	}
	return string(runes)
}

var metadataID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$`)

func safeID(s string) string {
	if metadataID.MatchString(s) {
		return s
	}
	return ""
}

type generationNotice struct {
	title, explanation, kind string
	level                    slog.Level
	notify                   bool
}

// Classify observations without changing the persisted execution state. A
// terminal failure wins over a stale retry stage; success never becomes failure
// merely because a caller carried Notify forward from an earlier observation.
func generationNoticeFor(stage, state, code string, requested bool) generationNotice {
	switch state {
	case "SUCCEEDED":
		return generationNotice{kind: "SUCCEEDED", level: slog.LevelInfo}
	case "CANCELED":
		return generationNotice{title: "Studio TV 任务已取消", explanation: "任务已取消，请按当前任务记录确认后续操作。", kind: "CANCELED", level: slog.LevelInfo, notify: requested}
	case "FAILED", "TIMED_OUT":
		return generationNotice{title: "Studio TV 生成失败", explanation: "任务已终止，请根据错误码检查原因后再重试。", kind: "FAILURE", level: slog.LevelError, notify: requested}
	}
	if stage == "CLIENT_PREFLIGHT" && code == "LOCAL_DRAFT_CONFLICT" {
		return generationNotice{title: "Studio TV 画布同步待完成", explanation: "生成尚未提交，画布同步检查未通过；本地修改已保留。", kind: "DRAFT_CONFLICT", level: slog.LevelWarn, notify: requested}
	}
	if stage == "UPSTREAM_RETRY" || state == "RETRY_PENDING" {
		return generationNotice{title: "Studio TV 任务自动重试", explanation: "任务未终止，系统正在自动重试；请勿重复提交。", kind: "RETRY", level: slog.LevelWarn, notify: requested}
	}
	if stage == "CLIENT_PREFLIGHT" || state == "REJECTED" {
		return generationNotice{title: "Studio TV 提交未通过", explanation: "本次生成尚未提交，请根据错误码调整输入或恢复同步后重新提交。", kind: "SUBMISSION_REJECTED", level: slog.LevelWarn, notify: requested}
	}
	if requested {
		return generationNotice{title: "Studio TV 任务状态提醒", explanation: "请根据当前任务状态和错误码检查处理，避免重复提交。", kind: "STATE_NOTICE", level: slog.LevelWarn, notify: true}
	}
	return generationNotice{kind: "LIFECYCLE", level: slog.LevelInfo}
}

func (o *Observer) Generation(ctx context.Context, g Generation) {
	if o == nil {
		return
	}
	id := LogID(ctx)
	if g.TaskID != "" {
		id = TaskLogID(g.TaskID)
	}
	if id == "" {
		id = uuid.NewString()
	}
	elapsed := int64(0)
	if !g.CreatedAt.IsZero() {
		elapsed = time.Since(g.CreatedAt).Milliseconds()
		if elapsed < 0 {
			elapsed = 0
		}
	}
	code := safeCode(g.ErrorCode)
	state := safeCode(g.State)
	stage := safeCode(g.Stage)
	var preflight *PreflightContext
	clientReport := stage == "CLIENT_PREFLIGHT" || stage == "CLIENT_SUBMISSION_SNAPSHOT"
	if clientReport && g.Preflight.Valid() {
		preflight = g.Preflight
		g.CapabilityRef, g.CapabilityVersion = preflight.CapabilityRef, preflight.CapabilityVersion
	}
	notice := generationNoticeFor(stage, state, code, g.Notify)
	actorID := safeID(g.ActorID)
	actorName := ""
	if notice.notify {
		actorName = o.generationActorName(ctx, actorID)
	}
	fields := []any{"log_id", id, "request_id", LogID(ctx), "task_id", safeID(g.TaskID), "project_id", safeID(g.ProjectID), "node_id", safeID(g.NodeID), "execution_id", safeID(g.ExecutionID), "kind", safeID(g.Kind), "capability_ref", safeID(g.CapabilityRef), "capability_version", safeID(g.CapabilityVersion), "scene_code", safeID(g.SceneCode), "invocation_ref", safeID(g.InvocationRef), "stage", stage, "state", state, "error_code", code, "elapsed_ms", elapsed, "output_count", g.Outputs}
	fields = append(fields, "actor_id", actorID)
	if clientReport && g.ClientSnapshot.Valid() {
		fields = append(fields, "client_snapshot", g.ClientSnapshot)
		// Keep the request ID server-controlled. The browser-provided join key
		// is unverified, and is never treated as an authoritative log identity.
		if prior, err := uuid.Parse(g.RelatedRequestID); err == nil && prior.String() == g.RelatedRequestID {
			fields = append(fields, "related_request_id", prior.String())
		}
	}
	if preflight != nil {
		fields = append(fields, "preflight_source", "client", "preflight", preflight)
	}
	if notice.notify {
		fields = append(fields, "actor_name", actorName)
	}
	o.logger.Log(ctx, notice.level, "generation lifecycle", fields...)
	if notice.notify {
		detail := fmt.Sprintf("%s task_id=%s project_id=%s node_id=%s execution_id=%s model=%s version=%s scene=%s invocation=%s state=%s error_code=%s elapsed_ms=%d", notice.explanation, safeID(g.TaskID), safeID(g.ProjectID), safeID(g.NodeID), safeID(g.ExecutionID), safeID(g.CapabilityRef), safeID(g.CapabilityVersion), safeID(g.SceneCode), safeID(g.InvocationRef), state, code, elapsed)
		if preflight != nil {
			detail += "\n" + preflight.summary()
		}
		key := "GENERATION|" + notice.kind + "|" + safeID(g.TaskID) + "|" + actorID + "|" + safeID(g.SceneCode) + "|" + code
		if notice.kind == "SUBMISSION_REJECTED" && stage == "CLIENT_PREFLIGHT" {
			// Different nodes, model choices, and input failures remain distinct;
			// repeated clicks on the same unchanged failure stay bounded.
			key += "|" + safeID(g.ProjectID) + "|" + safeID(g.NodeID) + "|" + preflight.signature()
		}
		if notice.kind == "DRAFT_CONFLICT" && safeID(g.ProjectID) != "" {
			// One project conflict can be discovered by several node buttons. Keep
			// every lifecycle log while bounding duplicate alerts in the existing
			// configured rate window; another actor/project or real failure differs.
			key = "GENERATION|DRAFT_CONFLICT|" + actorID + "|" + safeID(g.ProjectID)
		}
		_ = o.enqueue(notification{title: notice.title, id: id, operation: stage, detail: detail, key: key, showActor: true, actorID: actorID, actorName: actorName})
	}
}
func generationRoute(method, path string) bool {
	if method != "POST" {
		return false
	}
	switch path {
	case "/api/v2/canvas-runs", "/api/v2/app-runs", "/api/v2/media-jobs", "/api/v2/sketch-runs", "/api/v2/studio-renders", "/api/v2/prompts/optimize":
		return true
	}
	switch path {
	case "/api/v2/projects/{projectId}/canvas-executions", "/api/v2/conversations/{cid}/runs", "/api/v2/assistant/conversations/{cid}/runs", "/api/v2/conversations/{id}/agent-runs", "/api/v2/studio/projects/{projectId}/render":
		return true
	}
	return false
}
