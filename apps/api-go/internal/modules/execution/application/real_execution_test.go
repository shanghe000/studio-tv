package application

import (
	"context"
	"encoding/json"
	"reflect"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"testing"
)

func TestRealRoutingKeepsEveryTextFeaturePreset(t *testing.T) {
	for _, data := range []string{`{"params":{"prompt":"写一个短故事"}}`, `{"params":{"prompt":"原稿"},"promptSelection":{"schemaVersion":"1","featureCode":"skill.optimize"}}`, `{"params":{"prompt":"剧本设定"},"promptSelection":{"schemaVersion":"1","featureCode":"prompt.enhance"}}`} {
		s, _, g := promptTestService(t, "LLM")
		baseline, err := promptCanvas(t, s, data)
		if err != nil {
			t.Fatal(err)
		}
		g.pages[""].Items[0].TestMode = false
		_, err = promptCanvas(t, s, data)
		faultCode(t, err, "MODEL_EXECUTION_DISABLED")
		s.WithRealExecution(true)
		real, err := promptCanvas(t, s, data)
		if err != nil {
			t.Fatal(err)
		}
		if real.TestMode || real.Plans[0].TestMode {
			t.Fatal("real execution labeled fixture")
		}
		if !reflect.DeepEqual(frozenRequest(t, baseline).PromptSpec, frozenRequest(t, real).PromptSpec) {
			t.Fatal("changing route altered authored prompt envelope")
		}
	}
}
func TestWorkerAcceptsRealReceiptOnlyForRealPlan(t *testing.T) {
	s, store, catalog := promptTestService(t, "LLM")
	catalog.pages[""].Items[0].TestMode = false
	s.WithRealExecution(true)
	g := &receiptModeGateway{promptTestGateway: catalog}
	s.gateway = g
	task, err := promptCanvas(t, s, `{"params":{"prompt":"write a story"}}`)
	if err != nil {
		t.Fatal(err)
	}
	s.execute(context.Background(), task, "lease")
	if store.task.State != "SUCCEEDED" || store.task.TestMode || g.submits != 1 || g.reads != 1 {
		t.Fatalf("unexpected real state %+v", store.task)
	}
}
func TestRealPolicyDoesNotAllowUnadvertisedCapability(t *testing.T) {
	s, _, _ := promptTestService(t, "LLM")
	s.WithRealExecution(true)
	if s.CanExecute(gateway.Capability{TestMode: false}) {
		t.Fatal("unavailable admitted")
	}
	for _, k := range []string{"GLOBAL", "CANVAS", "HF"} {
		template, ok := assistantTemplate(k)
		if !ok {
			t.Fatal(k)
		}
		raw, _ := json.Marshal(template.spec())
		if len(raw) == 0 {
			t.Fatal("missing assistant preset")
		}
	}
}
