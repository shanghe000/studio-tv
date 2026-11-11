package http_test

import (
	"bytes"
	"encoding/json"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"os"
	"strings"
	"testing"
)

func TestResourcesContractReferencesAndImplementedInventory(t *testing.T) {
	raw, e := os.ReadFile("../../../../../../../contracts/resources-extension.json")
	if e != nil {
		t.Fatal(e)
	}
	yaml, e := os.ReadFile("../../../../../../../contracts/resources-extension.yaml")
	if e != nil || !bytes.Equal(raw, yaml) {
		t.Fatal("YAML1.2 differs")
	}
	var doc map[string]any
	if e = json.Unmarshal(raw, &doc); e != nil {
		t.Fatal(e)
	}
	compiler := jsonschema.NewCompiler()
	if e = compiler.AddResource("https://rhtv.local/resources.json", doc); e != nil {
		t.Fatal(e)
	}
	for name := range doc["components"].(map[string]any)["schemas"].(map[string]any) {
		if _, e = compiler.Compile("https://rhtv.local/resources.json#/components/schemas/" + name); e != nil {
			t.Fatal(name, e)
		}
	}
	implemented, reserved := 0, 0
	for p, methods := range doc["paths"].(map[string]any) {
		if !strings.HasPrefix(p, "/api/v2/") {
			t.Fatal(p)
		}
		for _, v := range methods.(map[string]any) {
			op := v.(map[string]any)
			switch op["x-implementation-status"] {
			case "IMPLEMENTED":
				implemented++
			case "RESERVED":
				reserved++
				if _, ok := op["responses"].(map[string]any)["501"]; !ok {
					t.Fatal("missing501", p)
				}
			default:
				t.Fatal("unmarked", p)
			}
		}
	}
	if implemented != 87 || reserved != 5 {
		t.Fatal("inventory", implemented, reserved)
	}
}
