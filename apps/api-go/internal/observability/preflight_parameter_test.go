package observability

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func parameterPreflight() *PreflightContext {
	return &PreflightContext{SchemaVersion: "1", CapabilityRef: "scail2-motion-transfer-v1", CapabilityVersion: "2", Issues: []PreflightIssue{{Field: "parameters", Reason: "PARAMETER_INVALID", Component: "PARAMETERS", ParameterPath: []any{"subjectMapping", 1, "referenceSubjectIndex"}, ParameterRule: "minimum"}}}
}

func TestPreflightParameterDiagnosticsKeepExactSafeFieldAndRule(t *testing.T) {
	url, alerts, _ := fakeWebhook(t)
	o, logs := testObserver(t, Config{WebhookURL: url})
	o.Generation(context.Background(), Generation{ActorID: "usr_a", ProjectID: "prj_a", NodeID: "node_a", Stage: "CLIENT_PREFLIGHT", State: "REJECTED", ErrorCode: "MODEL_PARAMETER_INVALID", Preflight: parameterPreflight(), Notify: true})
	closeObserver(t, o)
	for _, want := range []string{`"parameterPath":["subjectMapping",1,"referenceSubjectIndex"]`, `"parameterRule":"minimum"`, `"capability_version":"2"`} {
		if !strings.Contains(logs.String(), want) {
			t.Fatal("parameter locator missing from structured log", want, logs.String())
		}
	}
	for _, want := range []string{"人物配对[第2项] / 参考人物序号", "规则：低于范围下限", "model=scail2-motion-transfer-v1", "version=2"} {
		if !strings.Contains(alerts.String(), want) {
			t.Fatal("parameter locator missing from human notification", want, alerts.String())
		}
	}
	first := parameterPreflight().signature()
	p := parameterPreflight()
	p.Issues[0].ParameterPath[1] = 0
	if first == p.signature() {
		t.Fatal("different parameter locations share diagnostic signature")
	}
	p = parameterPreflight()
	p.Issues[0].ParameterRule = "maximum"
	if first == p.signature() {
		t.Fatal("different parameter rules share diagnostic signature")
	}
}

func TestPreflightParameterContextRejectsCallerKeysValuesAndInvalidPositions(t *testing.T) {
	for _, path := range [][]any{{"PRIVATE_USER_KEY"}, {"https://private.invalid"}, {"seed", -1}, {"seed", 10000}, {"seed", 0.5}, {"seed", true}, {"seed", map[string]any{"private": "value"}}, make([]any, 13)} {
		p := parameterPreflight()
		p.Issues[0].ParameterPath = path
		if p.Valid() {
			t.Fatal("unsafe parameter path accepted", path)
		}
	}
	p := parameterPreflight()
	p.Issues[0].ParameterRule = "PRIVATE_USER_VALUE"
	if p.Valid() {
		t.Fatal("free rule value accepted")
	}
	p = parameterPreflight()
	p.Issues[0].Field = "references.kind"
	if p.Valid() {
		t.Fatal("parameter metadata accepted on unrelated issue")
	}
	// Decoding the HTTP JSON representation changes integer interface values
	// into float64; the exact same bounded path remains valid.
	raw, _ := json.Marshal(parameterPreflight())
	var decoded PreflightContext
	if json.Unmarshal(raw, &decoded) != nil || !decoded.Valid() {
		t.Fatal("valid HTTP parameter path rejected")
	}
}

func TestPreflightParameterContractMatchesServerAllowlists(t *testing.T) {
	raw, err := os.ReadFile("../../../../contracts/generation-diagnostics-extension.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Defs struct {
			Issue struct {
				Properties struct {
					Path struct {
						Items struct {
							OneOf []struct{ Enum []string } `json:"oneOf"`
						} `json:"items"`
					} `json:"parameterPath"`
					Rule struct{ Enum []string } `json:"parameterRule"`
				} `json:"properties"`
			} `json:"preflightIssue"`
		} `json:"$defs"`
	}
	if json.Unmarshal(raw, &contract) != nil || len(contract.Defs.Issue.Properties.Path.Items.OneOf) != 2 {
		t.Fatal("invalid parameter diagnostic contract")
	}
	names, rules := contract.Defs.Issue.Properties.Path.Items.OneOf[0].Enum, contract.Defs.Issue.Properties.Rule.Enum
	if len(names) != len(preflightParameterNames) || len(rules) != len(preflightParameterRules) {
		t.Fatal("contract and server symbol counts differ")
	}
	for _, name := range names {
		if _, ok := preflightParameterNames[name]; !ok {
			t.Fatal("contract token unsupported by server", name)
		}
	}
	for _, rule := range rules {
		if _, ok := preflightParameterRules[rule]; !ok {
			t.Fatal("contract rule unsupported by server", rule)
		}
	}
}
