package observability

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func preflightFloat(value float64) *float64 { return &value }
func preflightIndex(value int) *int         { return &value }

func examplePreflight() *PreflightContext {
	return &PreflightContext{SchemaVersion: "1", CapabilityRef: "h3-motion-transfer-v1", CapabilityVersion: "2", RequestedKind: "IMAGE_TO_VIDEO", InputKinds: []string{"IMAGE", "VIDEO"}, Issues: []PreflightIssue{{Field: "media.durationMs", Reason: "MAXIMUM_EXCEEDED", InputKind: "VIDEO", InputIndex: preflightIndex(1), AssetID: "ast_reference", SourceNodeID: "node_source", Actual: preflightFloat(55519), Maximum: preflightFloat(30000)}}}
}

func TestPreflightContextRejectsUnsafeOrUnboundedMetadata(t *testing.T) {
	for _, row := range []struct {
		name string
		edit func(*PreflightContext)
	}{
		{"unknown schema", func(p *PreflightContext) { p.SchemaVersion = "2" }},
		{"model URL", func(p *PreflightContext) { p.CapabilityRef = "https://private.invalid/?token=value" }},
		{"long version", func(p *PreflightContext) { p.CapabilityVersion = strings.Repeat("a", 101) }},
		{"free requested kind", func(p *PreflightContext) { p.RequestedKind = "private prompt" }},
		{"unknown input kind", func(p *PreflightContext) { p.InputKinds = []string{"SECRET"} }},
		{"duplicate kinds", func(p *PreflightContext) { p.InputKinds = []string{"IMAGE", "IMAGE"} }},
		{"many issues", func(p *PreflightContext) { p.Issues = make([]PreflightIssue, 17) }},
		{"null issue", func(p *PreflightContext) { p.Issues = []PreflightIssue{{}} }},
		{"free field", func(p *PreflightContext) { p.Issues[0].Field = "prompt" }},
		{"free component", func(p *PreflightContext) { p.Issues[0].Component = "private prompt" }},
		{"free reason", func(p *PreflightContext) { p.Issues[0].Reason = "private prompt" }},
		{"free input kind", func(p *PreflightContext) { p.Issues[0].InputKind = "private prompt" }},
		{"negative index", func(p *PreflightContext) { p.Issues[0].InputIndex = preflightIndex(-1) }},
		{"large index", func(p *PreflightContext) { p.Issues[0].InputIndex = preflightIndex(10000) }},
		{"asset URL", func(p *PreflightContext) { p.Issues[0].AssetID = "https://private.invalid" }},
		{"source line break", func(p *PreflightContext) { p.Issues[0].SourceNodeID = "node\nprivate" }},
		{"negative fact", func(p *PreflightContext) { p.Issues[0].Actual = preflightFloat(-1) }},
		{"infinite fact", func(p *PreflightContext) { p.Issues[0].Actual = preflightFloat(math.Inf(1)) }},
		{"NaN fact", func(p *PreflightContext) { p.Issues[0].Actual = preflightFloat(math.NaN()) }},
		{"imprecise fact", func(p *PreflightContext) { p.Issues[0].Actual = preflightFloat(9007199254740992) }},
		{"inverted range", func(p *PreflightContext) { p.Issues[0].Minimum = preflightFloat(40000) }},
		{"unknown expected kind", func(p *PreflightContext) { p.Issues[0].ExpectedKinds = []string{"PRIVATE"} }},
	} {
		t.Run(row.name, func(t *testing.T) {
			p := examplePreflight()
			if !p.Valid() {
				t.Fatal("valid fixture rejected")
			}
			row.edit(p)
			if p.Valid() {
				t.Fatal("unsafe metadata accepted")
			}
		})
	}
	if (*PreflightContext)(nil).Valid() || (&PreflightContext{SchemaVersion: "1"}).Valid() != true {
		t.Fatal("optional context handling changed")
	}
}

func TestPreflightLogsAndAlertsExplainExactInputWithoutFreeText(t *testing.T) {
	url, alerts, _ := fakeWebhook(t)
	o, logs := testObserver(t, Config{WebhookURL: url})
	p := examplePreflight()
	o.Generation(WithLogID(context.Background(), "log_preflight"), Generation{ActorID: "usr_a", ProjectID: "prj_a", NodeID: "node_target", Stage: "CLIENT_PREFLIGHT", State: "REJECTED", ErrorCode: "MEDIA_INPUT_INVALID", Preflight: p, Notify: true})
	closeObserver(t, o)
	var record map[string]any
	if err := json.Unmarshal([]byte(strings.Split(logs.String(), "\n")[0]), &record); err != nil {
		t.Fatal(err)
	}
	if record["preflight_source"] != "client" || record["capability_ref"] != p.CapabilityRef || record["capability_version"] != "2" || record["log_id"] != "log_preflight" {
		t.Fatal("lost selected model or client provenance", record)
	}
	metadata := record["preflight"].(map[string]any)
	issue := metadata["issues"].([]any)[0].(map[string]any)
	if issue["sourceNodeId"] != "node_source" || issue["assetId"] != "ast_reference" || issue["inputIndex"] != float64(1) || issue["actual"] != float64(55519) || issue["maximum"] != float64(30000) {
		t.Fatal("lost affected input facts", issue)
	}
	for _, want := range []string{"Studio TV 提交未通过", "model=h3-motion-transfer-v1", "version=2", "第2项素材时长(视频)", "实际55519毫秒", "上限30000毫秒", "ast_reference", "node_source"} {
		if !strings.Contains(alerts.String(), want) {
			t.Fatalf("alert lost %q: %s", want, alerts.String())
		}
	}
	unsafe := examplePreflight()
	unsafe.Issues[0].Field = "private-prompt"
	o2, logs2 := testObserver(t, Config{})
	o2.Generation(context.Background(), Generation{Stage: "CLIENT_PREFLIGHT", State: "REJECTED", Preflight: unsafe})
	if strings.Contains(logs2.String(), "private-prompt") || strings.Contains(logs2.String(), `"preflight"`) {
		t.Fatal("logging boundary retained invalid metadata")
	}
}

func TestPreflightDifferentInputsDoNotSuppressEachOther(t *testing.T) {
	url, _, calls := fakeWebhook(t)
	o, logs := testObserver(t, Config{WebhookURL: url})
	g := Generation{ActorID: "usr_a", ProjectID: "prj_a", NodeID: "node_a", Stage: "CLIENT_PREFLIGHT", State: "REJECTED", ErrorCode: "MODEL_INPUT_UNSUPPORTED", Preflight: examplePreflight(), Notify: true}
	o.Generation(context.Background(), g)
	o.Generation(context.Background(), g)
	g.NodeID = "node_b"
	o.Generation(context.Background(), g)
	g.Preflight.CapabilityVersion = "3"
	o.Generation(context.Background(), g)
	g.Preflight.Issues[0].Actual = preflightFloat(60000)
	o.Generation(context.Background(), g)
	closeObserver(t, o)
	if calls.Load() != 4 || o.Stats().Suppressed != 1 || strings.Count(logs.String(), `"msg":"generation lifecycle"`) != 5 {
		t.Fatal("distinct rejected inputs lost evidence", calls.Load(), o.Stats(), logs.String())
	}
}

func TestPreflightFileEvidenceSurvivesObserverRestart(t *testing.T) {
	dir := t.TempDir()
	for _, id := range []string{"first_restart", "second_restart"} {
		o, _ := testObserver(t, Config{LogDirectory: dir})
		o.Generation(WithLogID(context.Background(), id), Generation{Stage: "CLIENT_PREFLIGHT", State: "REJECTED", ErrorCode: "MEDIA_INPUT_INVALID", Preflight: examplePreflight()})
		closeObserver(t, o)
	}
	data, err := os.ReadFile(filepath.Join(dir, "generation.log"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"first_restart", "second_restart", `"actual":55519`, `"maximum":30000`, `"capability_version":"2"`} {
		if !strings.Contains(string(data), want) {
			t.Fatalf("persistent generation log lost %s", want)
		}
	}
}

func TestPreflightConsistencyFailureKeepsStageComponentAndModel(t *testing.T) {
	url, alerts, _ := fakeWebhook(t)
	o, logs := testObserver(t, Config{WebhookURL: url})
	for _, row := range []struct{ field, reason, component string }{
		{"inputs.command", "COMMAND_MISMATCH", "PARAMETERS"},
		{"inputs.snapshot", "INPUT_CHANGED", "REFERENCES"},
	} {
		p := &PreflightContext{SchemaVersion: "1", CapabilityRef: "h3-video-reference-v1", CapabilityVersion: "4", Issues: []PreflightIssue{{Field: row.field, Reason: row.reason, Component: row.component, SourceNodeID: "node_target"}}}
		o.Generation(context.Background(), Generation{ActorID: "usr_a", ProjectID: "prj_a", NodeID: "node_target", Stage: "CLIENT_PREFLIGHT", State: "REJECTED", ErrorCode: "STALE_EXECUTION_INPUT", Preflight: p, Notify: true})
	}
	closeObserver(t, o)
	for _, want := range []string{`"component":"PARAMETERS"`, `"component":"REFERENCES"`, `"capability_version":"4"`, `"field":"inputs.command"`, `"field":"inputs.snapshot"`} {
		if !strings.Contains(logs.String(), want) {
			t.Fatalf("missing consistency context %s", want)
		}
	}
	for _, want := range []string{"Studio TV 提交未通过", "生成命令输入·生成参数", "画布当前输入·参考素材", "model=h3-video-reference-v1", "version=4"} {
		if !strings.Contains(alerts.String(), want) {
			t.Fatalf("missing explanation %s", want)
		}
	}
}
