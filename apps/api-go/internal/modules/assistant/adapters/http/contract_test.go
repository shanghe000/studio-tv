package http_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestAssistantContractImplementationInventoryAndSelfContainedRefs(t *testing.T) {
	jsonBytes, err := os.ReadFile("../../../../../../../contracts/assistant-extension.json")
	if err != nil {
		t.Fatal(err)
	}
	yamlBytes, err := os.ReadFile("../../../../../../../contracts/assistant-extension.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if string(jsonBytes) != string(yamlBytes) {
		t.Fatal("JSON/YAML 1.2 JSON-subset assistant copies differ")
	}
	var spec map[string]any
	if err = json.Unmarshal(jsonBytes, &spec); err != nil {
		t.Fatal(err)
	}
	if spec["openapi"] != "3.1.0" {
		t.Fatal("assistant contract version changed")
	}
	var walk func(any)
	walk = func(item any) {
		switch value := item.(type) {
		case map[string]any:
			if ref, ok := value["$ref"].(string); ok {
				if !strings.HasPrefix(ref, "#/") {
					t.Fatalf("assistant contract relies on old/external schema: %s", ref)
				}
				var target any = spec
				for _, part := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
					object, ok := target.(map[string]any)
					if !ok {
						t.Fatalf("invalid schema ref: %s", ref)
					}
					target, ok = object[part]
					if !ok {
						t.Fatalf("dangling schema ref: %s", ref)
					}
				}
			}
			for _, child := range value {
				walk(child)
			}
		case []any:
			for _, child := range value {
				walk(child)
			}
		}
	}
	walk(spec)
	implemented, reserved := 0, 0
	for path, raw := range spec["paths"].(map[string]any) {
		for _, operation := range raw.(map[string]any) {
			op := operation.(map[string]any)
			switch op["x-implementation-status"] {
			case "IMPLEMENTED":
				implemented++
			case "RESERVED":
				reserved++
				if _, ok := op["responses"].(map[string]any)["501"]; !ok {
					t.Fatalf("reserved operation lacks honest501: %s", path)
				}
			default:
				t.Fatalf("unmarked assistant operation: %s", path)
			}
		}
	}
	if implemented != 9 || reserved != 5 {
		t.Fatalf("actual operation inventory changed: implemented=%d reserved=%d", implemented, reserved)
	}
}
