package domain

import (
	"encoding/json"
	"testing"
)

func TestCapabilityCommandRequiresServerResolutionAndPreservesResults(t *testing.T) {
	c := parseTestCommand(t, `[{"type":"node.selectCapability","nodeId":"text","capabilityRef":"text-v1","capabilityVersion":"2","parameters":{"reasoningEffort":"high"}}]`)
	if _, _, err := ApplyCommands(json.RawMessage(commandGraph), c); err == nil {
		t.Fatal("unresolved model accepted")
	}
	c.Operations[0].Capability.Kind = "LLM"
	c.Operations[0].Capability.ParameterSchemaVersion = "2"
	g, _, err := ApplyCommands(json.RawMessage(commandGraph), c)
	if err != nil {
		t.Fatal(err)
	}
	nodes, _, _ := indexedGraphElements(g["nodes"])
	data := nodes["text"]["data"].(map[string]any)
	if data["generatedText"] != "server output" || data["taskId"] != "persisted-task" || data["capabilityVersion"] != "2" || data["params"].(map[string]any)["prompt"] != "old prompt" {
		t.Fatal("selection overwrote result/prompt")
	}
	c.Operations[0].Capability.Kind = "TEXT_TO_IMAGE"
	if _, _, err = ApplyCommands(json.RawMessage(commandGraph), c); err == nil {
		t.Fatal("cross-kind model accepted")
	}
	raw := json.RawMessage(`{"schemaVersion":"1","operations":[{"type":"node.selectCapability","nodeId":"text","capabilityRef":"fake","capabilityVersion":"2","parameters":{},"kind":"LLM"}]}`)
	if _, err = ParseCommand(raw); err == nil {
		t.Fatal("caller supplied trusted model metadata")
	}
}
