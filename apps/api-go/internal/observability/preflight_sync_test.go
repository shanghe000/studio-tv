package observability

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func syncPreflight() *PreflightContext {
	generation := int64(17)
	return &PreflightContext{SchemaVersion: "1", CapabilityRef: "h3-video-reference-v1", CapabilityVersion: "4", Sync: &PreflightSync{BlockedReason: "MERGE_CONFLICT", Generation: &generation, Conflicts: []PreflightSyncConflict{{Reason: "MODEL_PARAMETERS", Component: "MODEL", SourceNodeID: "node_target"}, {Reason: "FIELD_CHANGED", Component: "TOPOLOGY", SourceNodeID: "node_source"}}}}
}

func TestPreflightSyncLogsAndAlertsLocateBlockedInput(t *testing.T) {
	url, alerts, _ := fakeWebhook(t)
	o, logs := testObserver(t, Config{WebhookURL: url})
	o.Generation(context.Background(), Generation{ActorID: "usr_a", ProjectID: "prj_a", NodeID: "node_target", Stage: "CLIENT_PREFLIGHT", State: "REJECTED", ErrorCode: "LOCAL_DRAFT_CONFLICT", Preflight: syncPreflight(), Notify: true})
	closeObserver(t, o)
	for _, want := range []string{`"blockedReason":"MERGE_CONFLICT"`, `"generation":17`, `"reason":"MODEL_PARAMETERS"`, `"component":"TOPOLOGY"`, `"sourceNodeId":"node_source"`, `"capability_ref":"h3-video-reference-v1"`, `"capability_version":"4"`} {
		if !strings.Contains(logs.String(), want) {
			t.Fatalf("sync locator missing %s: %s", want, logs.String())
		}
	}
	for _, want := range []string{"修改合并冲突（MERGE_CONFLICT）", "同步检查序号=17", "同步冲突·模型：模型与参数组合发生变更（MODEL_PARAMETERS）", "同步冲突·连线：同一内容发生变更（FIELD_CHANGED）", "source_node_id=node_source", "model=h3-video-reference-v1", "version=4"} {
		if !strings.Contains(alerts.String(), want) {
			t.Fatalf("sync explanation missing %s: %s", want, alerts.String())
		}
	}
	p := syncPreflight()
	first := p.signature()
	p.Sync.Conflicts[0].Component = "PARAMETERS"
	if first == p.signature() {
		t.Fatal("distinct conflict components share diagnostic signature")
	}
	p = syncPreflight()
	p.Sync.BlockedReason = "CAS_UNCERTAIN"
	if first == p.signature() {
		t.Fatal("distinct sync blocks share diagnostic signature")
	}
}

func TestPreflightSyncRejectsUnsafeAndUnboundedClaims(t *testing.T) {
	for _, row := range []struct {
		name string
		edit func(*PreflightSync)
	}{
		{"missing block reason", func(s *PreflightSync) { s.BlockedReason = "" }},
		{"free block reason", func(s *PreflightSync) { s.BlockedReason = "PRIVATE_VALUE" }},
		{"negative generation", func(s *PreflightSync) { value := int64(-1); s.Generation = &value }},
		{"imprecise generation", func(s *PreflightSync) { value := int64(9007199254740992); s.Generation = &value }},
		{"too many conflicts", func(s *PreflightSync) { s.Conflicts = make([]PreflightSyncConflict, 17) }},
		{"missing conflict reason", func(s *PreflightSync) { s.Conflicts[0].Reason = "" }},
		{"free conflict reason", func(s *PreflightSync) { s.Conflicts[0].Reason = "PRIVATE_VALUE" }},
		{"missing component", func(s *PreflightSync) { s.Conflicts[0].Component = "" }},
		{"free component", func(s *PreflightSync) { s.Conflicts[0].Component = "PRIVATE_VALUE" }},
		{"unsafe source", func(s *PreflightSync) { s.Conflicts[0].SourceNodeID = "https://private.invalid/?token=PRIVATE_VALUE" }},
	} {
		t.Run(row.name, func(t *testing.T) {
			p := syncPreflight()
			if !p.Valid() {
				t.Fatal("valid sync claim rejected")
			}
			row.edit(p.Sync)
			if p.Valid() || p.summary() != "" || p.signature() != "" {
				t.Fatal("invalid sync claim accepted")
			}
			o, logs := testObserver(t, Config{})
			o.Generation(context.Background(), Generation{Stage: "CLIENT_PREFLIGHT", State: "REJECTED", Preflight: p})
			closeObserver(t, o)
			if strings.Contains(logs.String(), `"preflight"`) || strings.Contains(logs.String(), "PRIVATE_VALUE") {
				t.Fatal("invalid sync claim reached log boundary", logs.String())
			}
		})
	}
	for _, block := range []string{"MERGE_CONFLICT", "BASE_UNKNOWN", "CAS_UNCERTAIN"} {
		p := &PreflightContext{SchemaVersion: "1", Sync: &PreflightSync{BlockedReason: block}}
		if !p.Valid() {
			t.Fatal("sync claim without optional locators rejected", block)
		}
		for _, number := range []int64{0, 9007199254740991} {
			p.Sync.Generation = &number
			if !p.Valid() {
				t.Fatal("bounded generation rejected", number)
			}
		}
	}
	for _, raw := range []string{`{"schemaVersion":"1","sync":{"blockedReason":"CAS_UNCERTAIN","generation":0.5}}`, `{"schemaVersion":"1","sync":{"blockedReason":"CAS_UNCERTAIN","generation":9223372036854775808}}`} {
		var p PreflightContext
		if json.Unmarshal([]byte(raw), &p) == nil {
			t.Fatal("noninteger or overflowing generation decoded", raw)
		}
	}
}

func TestPreflightSyncContractMatchesServerAllowlists(t *testing.T) {
	raw, err := os.ReadFile("../../../../contracts/generation-diagnostics-extension.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Defs map[string]struct {
			Properties map[string]struct {
				Enum     []string `json:"enum"`
				Maximum  int64    `json:"maximum"`
				MaxItems int      `json:"maxItems"`
			} `json:"properties"`
		} `json:"$defs"`
	}
	if json.Unmarshal(raw, &contract) != nil {
		t.Fatal("invalid sync diagnostic contract")
	}
	for _, row := range []struct {
		def, field string
		allowed    map[string]string
	}{{"preflightSync", "blockedReason", preflightSyncBlockedReasons}, {"preflightSyncConflict", "reason", preflightSyncConflictReasons}, {"preflightSyncConflict", "component", preflightComponents}} {
		enum := contract.Defs[row.def].Properties[row.field].Enum
		if len(enum) != len(row.allowed) {
			t.Fatal("contract and server symbol counts differ", row.def, row.field)
		}
		for _, value := range enum {
			if _, ok := row.allowed[value]; !ok {
				t.Fatal("contract token unsupported by server", value)
			}
		}
	}
	if contract.Defs["preflightSync"].Properties["generation"].Maximum != 9007199254740991 || contract.Defs["preflightSync"].Properties["conflicts"].MaxItems != 16 {
		t.Fatal("contract numeric bounds differ from server")
	}
}
