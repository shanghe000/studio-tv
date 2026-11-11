package postgres

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"studiotv.local/service/api/internal/modules/execution/domain"
)

type promptPayloadRow struct {
	raw []byte
	now time.Time
}

func (r promptPayloadRow) Scan(dest ...any) error {
	*dest[0].(*string) = "task"
	*dest[1].(*string) = "owner"
	*dest[2].(*string) = "QUEUED"
	*dest[3].(*int64) = 1
	*dest[4].(*[]byte) = r.raw
	*dest[5].(*time.Time) = r.now
	*dest[6].(*time.Time) = r.now
	return nil
}

func TestFrozenPromptRequirementsSurvivePrivatePersistenceAndStayOutOfPublicPlan(t *testing.T) {
	now := time.Now().UTC()
	task := domain.Task{ID: "task", Plans: []domain.Plan{{NodeID: "node", Request: json.RawMessage(`{"promptSpec":{"schemaVersion":"1"}}`), PromptRequirements: &domain.PromptRequirements{RequireImage: true, StoryboardInputFrontier: true}}}}
	raw, err := encode(task)
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Task struct {
			Plans []map[string]any `json:"plans"`
		} `json:"task"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		t.Fatal("bad payload")
	}
	if _, visible := envelope.Task.Plans[0]["PromptRequirements"]; visible {
		t.Fatal("trusted private requirements exposed in public plan")
	}
	if _, visible := envelope.Task.Plans[0]["promptRequirements"]; visible {
		t.Fatal("trusted private requirements exposed in public plan")
	}
	if _, visible := envelope.Task.Plans[0]["storyboardInputFrontier"]; visible {
		t.Fatal("private storyboard input policy exposed in public plan")
	}
	reloaded, err := scan(promptPayloadRow{raw: raw, now: now})
	if err != nil || reloaded.Plans[0].PromptRequirements == nil || !reloaded.Plans[0].PromptRequirements.RequireImage || !reloaded.Plans[0].PromptRequirements.StoryboardInputFrontier {
		t.Fatalf("resumed task lost frozen template policy %v", err)
	}
}

func TestOldPrivatePromptRequirementsDoNotAcquireStoryboardProjection(t *testing.T) {
	task := domain.Task{ID: "task", Plans: []domain.Plan{{NodeID: "node", Request: json.RawMessage(`{"promptSpec":{"templateVersion":"studio-authored-1"}}`), PromptRequirements: &domain.PromptRequirements{RequireImage: true}}}}
	raw, err := encode(task)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "storyboardInputFrontier") {
		t.Fatal("legacy private policy was upgraded during persistence")
	}
	reloaded, err := scan(promptPayloadRow{raw: raw, now: time.Now().UTC()})
	if err != nil || reloaded.Plans[0].PromptRequirements == nil || reloaded.Plans[0].PromptRequirements.StoryboardInputFrontier {
		t.Fatal("old private receipt acquired new input semantics", err)
	}
}

func TestCatalogVideoRolePolicySurvivesPrivatePersistenceWithoutUpgradingOldTasks(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		task := domain.Task{ID: "task", Plans: []domain.Plan{{NodeID: "node", CatalogVideoRoles: enabled, VideoCancelUnsupported: enabled}}}
		raw, err := encode(task)
		if err != nil {
			t.Fatal(err)
		}
		public, err := json.Marshal(task)
		if err != nil || (strings.Contains(strings.ToLower(string(public)), "catalogvideo") || strings.Contains(strings.ToLower(string(public)), "videocancel")) {
			t.Fatal("private role policy exposed in the public task", err)
		}
		if !enabled {
			// A pre-feature receipt has no property at all. Replaying it must
			// preserve the original conditioning behavior after deployment.
			var p map[string]json.RawMessage
			if json.Unmarshal(raw, &p) != nil {
				t.Fatal("invalid envelope")
			}
			var plans []map[string]json.RawMessage
			if json.Unmarshal(p["private"], &plans) != nil {
				t.Fatal("invalid private plans")
			}
			delete(plans[0], "CatalogVideoRoles")
			delete(plans[0], "VideoCancelUnsupported")
			p["private"], _ = json.Marshal(plans)
			raw, _ = json.Marshal(p)
		}
		reloaded, err := scan(promptPayloadRow{raw: raw, now: time.Now().UTC()})
		if err != nil || (reloaded.Plans[0].CatalogVideoRoles != enabled || reloaded.Plans[0].VideoCancelUnsupported != enabled) {
			t.Fatal("resumed task changed its frozen video role policy", enabled, err)
		}
	}
}
