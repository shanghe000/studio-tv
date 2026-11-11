package application

import (
	"context"
	"encoding/json"
	"math"
	"testing"

	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

func measured(value float64) *float64 { return &value }

func TestProgressPhaseChangesClearSamplerFractionAndDoNotInventCompletion(t *testing.T) {
	plan := domain.Plan{}
	sampl := gateway.Invocation{Progress: measured(.5), ProgressDetail: &gateway.ProgressDetail{Phase: "sampling", Scope: "SAMPLING"}}
	if !observePlanProgress(&plan, sampl) || observePlanProgress(&plan, sampl) {
		t.Fatal("duplicate observation caused a write")
	}
	if !observePlanProgress(&plan, gateway.Invocation{ProgressDetail: &gateway.ProgressDetail{Phase: "decoding", Scope: "SAMPLING"}}) || plan.Progress != nil || plan.ProgressDetail.Phase != "decoding" {
		t.Fatal("decoder inherited sampler percentage")
	}
	for _, value := range []float64{math.NaN(), math.Inf(1), -.1, 1.1} {
		observePlanProgress(&plan, gateway.Invocation{Progress: &value})
		if plan.Progress != nil {
			t.Fatal("invalid measurement accepted")
		}
	}
	completePlanProgress(&plan)
	if plan.Progress == nil || *plan.Progress != 1 || plan.ProgressDetail.Scope != "TASK" {
		t.Fatal("confirmed completion not reported")
	}
}

type progressRecordingStore struct {
	*promptTestStore
	observations []domain.Task
}

func (s *progressRecordingStore) Save(ctx context.Context, task domain.Task, lease string) (bool, error) {
	body, _ := json.Marshal(task)
	var copy domain.Task
	_ = json.Unmarshal(body, &copy)
	s.observations = append(s.observations, copy)
	return s.promptTestStore.Save(ctx, task, lease)
}

type progressSequenceGateway struct {
	*receiptModeGateway
	sequence []gateway.Invocation
	index    int
}

func (g *progressSequenceGateway) Invocation(ctx context.Context, actor gateway.Actor, ref string) (gateway.Invocation, error) {
	if g.index < len(g.sequence) {
		value := g.sequence[g.index]
		g.index++
		value.Ref = ref
		value.TestMode = true
		return value, nil
	}
	return g.receiptModeGateway.Invocation(ctx, actor, ref)
}

func TestWorkerPersistsMeasuredChangesAndCompletionWithoutResubmission(t *testing.T) {
	s, base, catalog := promptTestService(t, "LLM")
	store := &progressRecordingStore{promptTestStore: base}
	s.store = store
	observation := gateway.Invocation{State: "RUNNING", Progress: measured(.5), ProgressDetail: &gateway.ProgressDetail{Phase: "sampling", Scope: "SAMPLING"}}
	g := &progressSequenceGateway{receiptModeGateway: &receiptModeGateway{promptTestGateway: catalog, submitTestMode: true, readTestMode: true}, sequence: []gateway.Invocation{observation, observation, {State: "RUNNING", ProgressDetail: &gateway.ProgressDetail{Phase: "decoding", Scope: "SAMPLING"}}}}
	s.gateway = g
	task, err := promptCanvas(t, s, `{"params":{"prompt":"offline progress fixture"}}`)
	if err != nil {
		t.Fatal(err)
	}
	s.execute(context.Background(), task, "lease")
	var half, decode int
	for _, saved := range store.observations {
		p := saved.Plans[0]
		if p.ProgressDetail != nil && p.ProgressDetail.Phase == "sampling" {
			half++
		}
		if p.ProgressDetail != nil && p.ProgressDetail.Phase == "decoding" {
			decode++
			if p.Progress != nil {
				t.Fatal("decoder fraction fabricated")
			}
		}
	}
	if half != 1 || decode != 1 || g.submits != 1 || store.task.State != "SUCCEEDED" || store.task.Plans[0].Progress == nil || *store.task.Plans[0].Progress != 1 {
		t.Fatal("progress persistence or submission count", half, decode, g.submits, store.task)
	}
}

func TestWorkerFailedReceiptDoesNotReportOneHundredPercent(t *testing.T) {
	s, store, catalog := promptTestService(t, "LLM")
	g := &progressSequenceGateway{receiptModeGateway: &receiptModeGateway{promptTestGateway: catalog, submitTestMode: true, readTestMode: true}, sequence: []gateway.Invocation{{State: "FAILED", Progress: nil, ProgressDetail: &gateway.ProgressDetail{Phase: "failed", Scope: "SAMPLING"}}}}
	s.gateway = g
	task, err := promptCanvas(t, s, `{"params":{"prompt":"offline failed fixture"}}`)
	if err != nil {
		t.Fatal(err)
	}
	s.execute(context.Background(), task, "lease")
	if store.task.State != "FAILED" || store.task.Plans[0].Progress != nil {
		t.Fatal("failure fabricated completion", store.task)
	}
}
