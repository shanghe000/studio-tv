package application

import (
	"encoding/json"
	"github.com/google/uuid"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"testing"
)

func TestMediaBoundaryRejectsURLsAndCanonicalHash(t *testing.T) {
	for _, raw := range []string{`{"imageUrl":"https://vendor.invalid/file"}`, `{"url":"file:///etc/passwd"}`, `{"images":[{"url":"blob:other"}]}`} {
		var body map[string]json.RawMessage
		_ = json.Unmarshal([]byte(raw), &body)
		if _, err := mediaIDs(body); err == nil {
			t.Fatalf("URL allowed %s", raw)
		}
	}
	var body map[string]json.RawMessage
	_ = json.Unmarshal([]byte(`{"images":[{"url":"rhtv-asset:ast_owned"}],"assetId":"ast_owned"}`), &body)
	ids, err := mediaIDs(body)
	if err != nil || len(ids) != 1 || ids[0] != "ast_owned" {
		t.Fatalf("IDs %#v %v", ids, err)
	}
	key := uuid.NewString()
	_, one, err := keyHash(key, json.RawMessage(`{"graph":{"b":2,"a":1}}`))
	if err != nil {
		t.Fatal(err)
	}
	_, two, err := keyHash(key, json.RawMessage(`{ "graph" : {"a":1,"b":2} }`))
	if err != nil || one != two {
		t.Fatal("canonical retry hash differs")
	}
}
func TestImmutableCapabilitySchemaValidation(t *testing.T) {
	cap := gateway.Capability{ParameterSchema: json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{"count":{"type":"integer","minimum":1,"maximum":4}}}`)}
	for _, raw := range []string{`null`, `{"count":0}`, `{"count":1.5}`, `{"count":5}`, `{"hiddenVendorKey":"x"}`} {
		if validateParameters(cap, json.RawMessage(raw)) == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	if err := validateParameters(cap, json.RawMessage(`{"count":2}`)); err != nil {
		t.Fatal(err)
	}
}
