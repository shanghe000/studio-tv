package postgres

import (
	"encoding/json"
	"testing"
	"time"

	"studiotv.local/service/api/internal/modules/execution/domain"
)

func TestMeasuredProgressAndTrustedFrontierSurvivePersistence(t *testing.T) {
	value := .25
	task := domain.Task{ID: "task", Plans: []domain.Plan{{NodeID: "node", MediaInputFrontier: true, Progress: &value, ProgressDetail: &domain.ProgressDetail{Phase: "sampling", Scope: "SAMPLING"}}}}
	body, err := encode(task)
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := scan(promptPayloadRow{raw: body, now: time.Now().UTC()})
	if err != nil || !reloaded.Plans[0].MediaInputFrontier || reloaded.Plans[0].Progress == nil || *reloaded.Plans[0].Progress != value || reloaded.Plans[0].ProgressDetail.Scope != "SAMPLING" {
		t.Fatal("restart lost observation/policy", err)
	}
	public, _ := json.Marshal(task)
	var v map[string]any
	_ = json.Unmarshal(public, &v)
	plan := v["plans"].([]any)[0].(map[string]any)
	if _, present := plan["MediaInputFrontier"]; present {
		t.Fatal("private policy exposed")
	}
}

func TestCanvasProgressChangesWithoutStateChangeAndKeepsUnknownNullable(t *testing.T) {
	value := .5
	plan := domain.Plan{NodeID: "node", State: "RUNNING", Progress: &value, ProgressDetail: &domain.ProgressDetail{Phase: "sampling", Scope: "SAMPLING"}}
	graph := json.RawMessage(`{"nodes":[{"id":"node","data":{"progress":null,"progressDetail":null}}],"edges":[]}`)
	if canvasProgressMatches(graph, plan) {
		t.Fatal("same state masked new sampler progress")
	}
	next, err := patchCanvasNode(graph, "node", canvasProgressPatch(plan))
	if err != nil || !canvasProgressMatches(next, plan) {
		t.Fatal("observation could not converge", err)
	}
	plan.Progress = nil
	plan.ProgressDetail = &domain.ProgressDetail{Phase: "decoding", Scope: "SAMPLING"}
	if canvasProgressMatches(next, plan) {
		t.Fatal("phase change was hidden")
	}
	patch := canvasProgressPatch(plan)
	if patch["progress"] != nil {
		t.Fatal("decode inherited sample fraction")
	}
	plan.State = "FAILED"
	if canvasProgressPatch(plan)["progress"] != nil {
		t.Fatal("failed progress invented")
	}
	plan.State = "SUCCEEDED"
	if canvasProgressPatch(plan)["progress"] != 100.0 {
		t.Fatal("confirmed success not complete")
	}
}
