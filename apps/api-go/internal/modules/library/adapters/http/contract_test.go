package http_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestLibraryContractInventoryAndLocalReferences(t *testing.T) {
	raw, e := os.ReadFile("../../../../../../../contracts/library-extension.json")
	if e != nil {
		t.Fatal(e)
	}
	yaml, e := os.ReadFile("../../../../../../../contracts/library-extension.yaml")
	if e != nil {
		t.Fatal(e)
	}
	if string(raw) != string(yaml) {
		t.Fatal("JSON/YAML 1.2 JSON-subset contracts differ")
	}
	var doc map[string]any
	if e = json.Unmarshal(raw, &doc); e != nil {
		t.Fatal(e)
	}
	var walk func(any)
	walk = func(v any) {
		switch value := v.(type) {
		case map[string]any:
			if ref, ok := value["$ref"].(string); ok {
				if !strings.HasPrefix(ref, "#/") {
					t.Fatal("external contract reference")
				}
				var target any = doc
				for _, part := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
					object, ok := target.(map[string]any)
					if !ok {
						t.Fatal("invalid contract reference")
					}
					target, ok = object[part]
					if !ok {
						t.Fatal("dangling contract reference")
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
	walk(doc)
	implemented, reserved := 0, 0
	for _, path := range doc["paths"].(map[string]any) {
		for _, raw := range path.(map[string]any) {
			op := raw.(map[string]any)
			switch op["x-implementation-status"] {
			case "IMPLEMENTED":
				implemented++
			case "RESERVED":
				reserved++
				if _, ok := op["responses"].(map[string]any)["501"]; !ok {
					t.Fatal("reserved route lacks501")
				}
			default:
				t.Fatal("unmarked operation")
			}
		}
	}
	if implemented != 21 || reserved != 0 {
		t.Fatalf("inventory mismatch %d/%d", implemented, reserved)
	}
}
