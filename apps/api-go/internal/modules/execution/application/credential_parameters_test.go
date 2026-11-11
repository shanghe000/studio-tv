package application

import (
	"encoding/json"
	"testing"
)

func TestCredentialMaterialIsRejectedBeforeModelTaskPersists(t *testing.T) {
	for _, key := range []string{"apiKey", "API_KEY", "provider-api-key", "AUTHORIZATION", "Credential_Ref"} {
		for _, location := range []string{"params", "routerParameters", "promptSelection"} {
			s, store, _ := promptTestService(t, "LLM")
			data := map[string]any{"params": map[string]any{"prompt": "TEST MODE safe text"}, "routerParameters": map[string]any{}}
			private := map[string]any{"nested": []any{map[string]any{key: "TEST_ONLY_private"}}}
			switch location {
			case "params":
				data["params"].(map[string]any)["native"] = private
			case "routerParameters":
				data["routerParameters"] = private
			case "promptSelection":
				data["promptSelection"] = map[string]any{"schemaVersion": "1", "conditions": private}
			}
			raw, _ := json.Marshal(data)
			_, err := promptCanvas(t, s, string(raw))
			faultCode(t, err, "PROVIDER_CREDENTIAL_PARAMETER_FORBIDDEN")
			if store.creates != 0 {
				t.Fatal("private credential entered a stored task")
			}
		}
	}
}

func TestCredentialParameterGuardKeepsPromptTextAndSubjectLabels(t *testing.T) {
	s, store, _ := promptTestService(t, "LLM")
	_, err := promptCanvas(t, s, `{"params":{"prompt":"Describe a sign that says apiKey","subjectRef":"person-left"},"subjectRef":"canvas-display-label","routerParameters":{}}`)
	if err != nil || store.creates != 1 {
		t.Fatal("non-authentication subject labels or prompt text were rejected", err)
	}
}
