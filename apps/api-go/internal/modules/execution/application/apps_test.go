package application

import (
	"encoding/json"
	"testing"
)

func TestAppInputsRejectForeignFieldsURLsAndNumericBounds(t *testing.T) {
	for _, test := range []struct {
		field AppField
		raw   string
	}{
		{AppField{Type: "IMAGE"}, `"https://vendor.invalid/image.png"`},
		{AppField{Type: "IMAGE"}, `"file:///etc/passwd"`},
		{AppField{Type: "INT", Data: `["INT",{"min":1,"max":4}]`}, `0`},
		{AppField{Type: "INT"}, `1.5`},
		{AppField{Type: "INT"}, `"null"`},
		{AppField{Type: "NUMBER"}, `"null"`},
		{AppField{Type: "NUMBER"}, `"NaN"`},
		{AppField{Type: "NUMBER"}, `"+Inf"`},
		{AppField{Type: "LIST", Data: `[["A","B"],{}]`}, `"X"`},
	} {
		if _, _, e := validateAppValue(test.field, json.RawMessage(test.raw)); e == nil {
			t.Fatalf("invalid app input accepted %s", test.raw)
		}
	}
	_, asset, e := validateAppValue(AppField{Type: "IMAGE"}, json.RawMessage(`"rhtv-asset:ast_owned"`))
	if e != nil || asset != "ast_owned" {
		t.Fatal("owned reference rejected", e)
	}
}
