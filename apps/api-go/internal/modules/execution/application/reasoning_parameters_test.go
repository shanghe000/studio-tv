package application

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"reflect"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"testing"
)

func TestReasoningSchema2KeepsNativeNodeParametersAndFreezesCanonicalEffort(t *testing.T) {
	for _, vision := range []bool{false, true} {
		for _, effort := range []string{"low", "high"} {
			t.Run(effort+map[bool]string{true: "-vision", false: "-text"}[vision], func(t *testing.T) {
				s, _, catalog := promptTestService(t, "LLM")
				ref := "codex-6-1-text-v1"
				if vision {
					ref = "codex-6-1-vision-text-v1"
				}
				cap := imageParseCapability(ref, vision)
				cap.Version, cap.ParameterSchemaVersion = "2", "2"
				cap.ParameterSchema, _ = json.Marshal(map[string]any{"type": "object", "properties": map[string]any{"reasoningEffort": map[string]any{"type": "string", "enum": []string{"low", "high"}, "default": "low"}}, "additionalProperties": false})
				catalog.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
				s.WithRealExecution(true)
				native := map[string]any{"prompt": "user template unchanged", "reasoning_effort": effort}
				if vision {
					native["imageUrls"] = []string{"rhtv-asset:img"}
				}
				graph, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"id": "node", "type": "rh-text", "data": map[string]any{"capabilityRef": ref, "capabilityVersion": "2", "params": native, "routerParameters": map[string]any{"reasoningEffort": effort}}}}, "edges": []any{}})
				task, err := s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: "NODE", TargetID: "node", Graph: graph})
				if err != nil {
					t.Fatal(err)
				}
				request := frozenRequest(t, task)
				var parameters map[string]any
				_ = json.Unmarshal(request.Parameters, &parameters)
				if request.Capability.Version != "2" || request.ParameterSchemaVersion != "2" || !reflect.DeepEqual(parameters, map[string]any{"reasoningEffort": effort}) || request.Input[0].Text == nil || *request.Input[0].Text != "user template unchanged" {
					t.Fatal("canonical effort or USER prompt changed")
				}
				original, _ := defaultTemplate("LLM")
				if request.PromptSpec.TemplateSHA256 != original.spec().TemplateSHA256 {
					t.Fatal("reasoning changed authored prompt/hash")
				}
				var snapshot map[string]any
				_ = json.Unmarshal(task.Plans[0].NodeSnapshot, &snapshot)
				if snapshot["data"].(map[string]any)["params"].(map[string]any)["reasoning_effort"] != effort {
					t.Fatal("native selected value lost")
				}
			})
		}
	}
}
func TestReasoningExactSchemaRejectsAliasInvalidValueAndVersion1Parameters(t *testing.T) {
	cap := promptCapability("text", "LLM")
	cap.Version, cap.ParameterSchemaVersion = "2", "2"
	cap.ParameterSchema, _ = json.Marshal(map[string]any{"type": "object", "properties": map[string]any{"reasoningEffort": map[string]any{"type": "string", "enum": []string{"low", "high"}, "default": "low"}}, "additionalProperties": false})
	for _, bad := range []map[string]any{{"reasoning_effort": "high"}, {"reasoningEffort": "High"}, {"reasoningEffort": nil}, {"reasoningEffort": 5}, {"reasoningEffort": "medium"}} {
		raw, _ := json.Marshal(bad)
		if err := validateParameters(cap, raw); err == nil {
			t.Fatalf("bad effort accepted: %s", raw)
		}
	}
	old := promptCapability("text", "LLM")
	raw, _ := json.Marshal(map[string]any{"reasoningEffort": "high"})
	if err := validateParameters(old, raw); err == nil {
		t.Fatal("version1 accepted version2 reasoning schema")
	}
}
