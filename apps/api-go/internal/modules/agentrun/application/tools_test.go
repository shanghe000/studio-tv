package application

import (
	"encoding/json"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/agentrun/domain"
	"testing"
)

func TestTypedToolsRejectAuthorityAndMalformedFields(t *testing.T) {
	run := domain.Run{ID: "agr_abc", ProjectID: "project_a"}
	for _, test := range []struct{ name, args string }{
		{"shell", `{}`}, {"studio_canvas_read", `{"ownerId":"other"}`}, {"studio_canvas_read", `{"projectId":null}`}, {"studio_node_run", `{"nodeId":"../x","expectedRevision":1}`}, {"studio_node_run", `{"nodeId":"x","expectedRevision":1,"graph":{"nodes":[]}}`}, {"studio_canvas_patch", `{"expectedRevision":1,"operations":[{"type":"node.updateInputs","nodeId":"x","inputSchemaVersion":"1","inputs":{"status":"SUCCEEDED"}}]}`}, {"studio_task_read", `{"taskId":"x","waitSeconds":21}`}, {"studio_task_cancel", `{"taskId":"x","waitSeconds":1}`},
	} {
		if _, _, err := ToolHTTP(run, RuntimeToolCall{Name: test.name, CallID: "native", Arguments: json.RawMessage(test.args)}); err == nil {
			t.Fatalf("accepted privileged or invalid tool %s %s", test.name, test.args)
		}
	}
}
func TestToolKeysAndRequestHashesFreezeRevisionAndCall(t *testing.T) {
	r := domain.Run{ID: "agr_abc", ProjectID: "project_a"}
	call := RuntimeToolCall{Name: "studio_node_run", CallID: "native", Arguments: json.RawMessage(`{"nodeId":"text","expectedRevision":1}`)}
	a, canonical, err := ToolHTTP(r, call)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := uuid.Parse(a.IdempotencyKey); err != nil {
		t.Fatal("key must be stable UUID", err)
	}
	call.Arguments = json.RawMessage(`{"expectedRevision":1,"nodeId":"text"}`)
	b, c2, err := ToolHTTP(r, call)
	if err != nil || string(canonical) != string(c2) || requestHash(a) != requestHash(b) {
		t.Fatal("object ordering changed canonical request")
	}
	call.Arguments = json.RawMessage(`{"nodeId":"text","expectedRevision":2}`)
	c, _, _ := ToolHTTP(r, call)
	if c.IdempotencyKey != a.IdempotencyKey || requestHash(c) == requestHash(a) {
		t.Fatal("same call lost frozen CAS/hash")
	}
	if OperationKey(r.ID, "another") == a.IdempotencyKey {
		t.Fatal("different call collided")
	}
}
func TestExactAgentModelVersionParameters(t *testing.T) {
	base := CreateCommand{CapabilityRef: CapabilityRef, CapabilityVersion: CapabilityVersion}
	for _, bad := range []string{`null`, `[]`, `{"reasoningEffort":null}`, `{"reasoningEffort":"ultra"}`, `{"model":"gpt-other"}`, `{"reasoning_effort":"high"}`} {
		base.Parameters = json.RawMessage(bad)
		if _, err := selectModel(base); err == nil {
			t.Fatal("accepted invalid exact selection", bad)
		}
	}
	base.Parameters = json.RawMessage(`{}`)
	if e, err := selectModel(base); err != nil || e != "low" {
		t.Fatal("default low", e, err)
	}
	base.Parameters = json.RawMessage(`{"reasoningEffort":"high"}`)
	if e, err := selectModel(base); err != nil || e != "high" {
		t.Fatal(e, err)
	}
	base.CapabilityVersion = "1"
	if _, err := selectModel(base); err == nil {
		t.Fatal("silently rewrote old capability version")
	}
}
func TestAllToolSchemasCompileAndWaitIsBounded(t *testing.T) {
	for _, tool := range Tools() {
		var schema map[string]any
		if json.Unmarshal(tool.InputSchema, &schema) != nil {
			t.Fatal(tool.Name)
		}
		if required, ok := schema["required"].([]any); !ok || required == nil {
			t.Fatal("required must be array", tool.Name)
		}
	}
	request, _, err := ToolHTTP(domain.Run{ID: "agr_x", ProjectID: "project_a"}, RuntimeToolCall{Name: "studio_task_read", CallID: "call", Arguments: json.RawMessage(`{"taskId":"task"}`)})
	if err != nil || request.WaitSeconds != 10 {
		t.Fatal(request, err)
	}
}
