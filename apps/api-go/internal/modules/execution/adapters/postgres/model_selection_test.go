package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/database"
	assistantPG "studiotv.local/service/api/internal/modules/assistant/adapters/postgres"
	assistant "studiotv.local/service/api/internal/modules/assistant/application"
	adomain "studiotv.local/service/api/internal/modules/assistant/domain"
	executionPG "studiotv.local/service/api/internal/modules/execution/adapters/postgres"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	studioPG "studiotv.local/service/api/internal/modules/studioassistant/adapters/postgres"
	studio "studiotv.local/service/api/internal/modules/studioassistant/application"
	"studiotv.local/service/api/internal/testdb"
)

type selectionCatalog struct{ gateway.Unconfigured }

func (selectionCatalog) Capabilities(context.Context, gateway.Actor, gateway.CapabilityQuery) (gateway.CapabilityPage, error) {
	items := []gateway.Capability{}
	for _, ref := range []string{"model-a", "model-b", "legacy"} {
		c := gateway.Capability{Ref: ref, Version: "1", Kind: "LLM", ExecutionKind: "AGENT", Available: true, ParameterSchemaVersion: "1", ParameterSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`), InputKinds: []string{"TEXT", "STRUCTURED"}, OutputKinds: []string{"TEXT", "STRUCTURED"}}
		if ref != "legacy" {
			c.Model = &gateway.ModelDescriptor{ProviderRef: "fixture-supplier", ModelRef: ref, Title: ref, Version: "6.1"}
		}
		items = append(items, c)
	}
	return gateway.CapabilityPage{Items: items}, nil
}

func TestPostgresHFExplicitModelSelectionAndUnknownChoiceDoNotChangeHistory(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testdb.New(t).Open(t)
	if err := database.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO public.users(id,email,display_name) VALUES('hf-model-owner','hf-model@example.test','HF models')`); err != nil {
		t.Fatal(err)
	}
	uow, _ := assistantPG.New(pool)
	history, _ := assistant.New(uow)
	actor := adomain.VerifiedActor{OwnerID: "hf-model-owner"}
	hash, _ := assistant.CreationHash(map[string]any{"kind": "HF", "title": "HF models"})
	c, err := history.Create(ctx, actor, assistant.CreateCommand{Input: adomain.Create{Kind: adomain.HF, Title: "HF models"}, IdempotencyKey: uuid.NewString(), RequestHash: hash})
	if err != nil {
		t.Fatal(err)
	}
	store, _ := executionPG.New(pool)
	exec, _ := execution.New(store, selectionCatalog{}, selectionImporter{})
	exec.WithRealExecution(true)
	commands, _ := studioPG.New(pool)
	service, err := studio.New(commands, history, exec, selectionCatalog{})
	if err != nil {
		t.Fatal(err)
	}
	id, err := service.Agent(ctx, actor.OwnerID, c.ID, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	key := uuid.NewString()
	cmd := studio.Command{AgentID: id, Message: "HF synthetic acceptance fixture", CapabilityRef: "model-b", CapabilityVersion: "1"}
	task, err := service.Run(ctx, actor.OwnerID, c.ID, key, cmd)
	if err != nil {
		t.Fatal(err)
	}
	if task.Plans[0].CapabilityRef != "model-b" || task.Plans[0].RouterConversationRef == "" {
		t.Fatal("HF displayed choice did not freeze its selected capability and epoch")
	}
	var request gateway.InvocationRequest
	if json.Unmarshal(task.Plans[0].Request, &request) != nil || request.Capability.Ref != "model-b" || request.PromptSpec.TemplateRef != "studio-tv/assistant/hf" {
		t.Fatal("HF selection changed authored template or provider request")
	}
	replay, err := service.Run(ctx, actor.OwnerID, c.ID, key, cmd)
	if err != nil || replay.ID != task.ID || replay.Plans[0].RouterConversationRef != task.Plans[0].RouterConversationRef {
		t.Fatal("HF retry changed frozen choice", err)
	}
	cmd.CapabilityRef = "not-configured"
	if _, err = service.Run(ctx, actor.OwnerID, c.ID, uuid.NewString(), cmd); err == nil {
		t.Fatal("unknown HF model was silently replaced")
	}
	var messages, receipts int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM assistant.messages WHERE conversation_id=$1`, c.ID).Scan(&messages); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM assistant.hf_commands WHERE conversation_id=$1`, c.ID).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if messages != 1 || receipts != 1 {
		t.Fatal("replay or rejected model appended messages/reservations")
	}
}

type selectionImporter struct{ execution.AssetImporter }

// Acceptance and persistence fixtures only: no worker or provider is invoked.
// Completed turns are saved with an explicitly synthetic text result.
func TestPostgresModelSelectionEpochPersistenceConcurrencyAndReplay(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testdb.New(t).Open(t)
	if err := database.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO public.users(id,email,display_name) VALUES('model-owner','selection@example.test','Selection'),('other-owner','other-selection@example.test','Other')`); err != nil {
		t.Fatal(err)
	}
	uow, _ := assistantPG.New(pool)
	history, _ := assistant.New(uow)
	actor := adomain.VerifiedActor{OwnerID: "model-owner"}
	hash, _ := assistant.CreationHash(map[string]any{"kind": "GLOBAL", "title": "Model epochs"})
	c, err := history.Create(ctx, actor, assistant.CreateCommand{Input: adomain.Create{Kind: adomain.Global, Title: "Model epochs"}, IdempotencyKey: uuid.NewString(), RequestHash: hash})
	if err != nil {
		t.Fatal(err)
	}
	newService := func() (*execution.Service, *executionPG.Store) {
		t.Helper()
		store, _ := executionPG.New(pool)
		s, e := execution.New(store, selectionCatalog{}, selectionImporter{})
		if e != nil {
			t.Fatal(e)
		}
		s.WithRealExecution(true)
		return s, store
	}
	s, store := newService()
	appendUser := func(text string) string {
		t.Helper()
		detail, e := history.Detail(ctx, actor, c.ID)
		if e != nil {
			t.Fatal(e)
		}
		parts, _ := json.Marshal([]map[string]string{{"type": "TEXT", "text": text}})
		result, e := history.AppendMessage(ctx, actor, c.ID, assistant.AppendMessageCommand{Content: parts, ExpectedRevision: detail.Revision, IdempotencyKey: uuid.NewString()})
		if e != nil {
			t.Fatal(e)
		}
		return result.Message.ID
	}
	accept := func(ref, mid, key string) domain.Task {
		t.Helper()
		task, e := s.Assistant(ctx, actor.OwnerID, c.ID, key, execution.AssistantCommand{CapabilityRef: ref, CapabilityVersion: "1", MessageID: mid, Parameters: json.RawMessage(`{}`)})
		if e != nil {
			t.Fatal(e)
		}
		return task
	}
	finish := func(task domain.Task, state string) {
		t.Helper()
		lease := uuid.NewString()
		claimed, ok, e := store.Claim(ctx, lease)
		if e != nil || !ok || claimed.ID != task.ID {
			t.Fatal("fixture claim failed", e)
		}
		claimed.State = state
		claimed.Plans[0].State = state
		if state == "SUCCEEDED" {
			text := "synthetic persistence fixture"
			claimed.Plans[0].Outputs = []domain.Output{{ID: "fixture-" + task.ID, Type: "TEXT", Text: &text, TestMode: true}}
		}
		ok, e = store.Save(ctx, claimed, lease)
		if e != nil || !ok {
			t.Fatal("fixture save failed", e)
		}
	}
	firstKey := uuid.NewString()
	firstMid := appendUser("first user turn")
	first := accept("model-a", firstMid, firstKey)
	epoch := first.Plans[0].RouterConversationRef
	if epoch == "" || epoch == c.ID {
		t.Fatal("model epoch was not frozen")
	}
	finish(first, "SUCCEEDED")
	s, store = newService() // Independent constructor simulates an application restart.
	second := accept("model-a", appendUser("second user turn"), uuid.NewString())
	if second.Plans[0].RouterConversationRef != epoch {
		t.Fatal("same model did not restore its persisted epoch")
	}
	finish(second, "SUCCEEDED")
	third := accept("model-b", appendUser("third user turn"), uuid.NewString())
	if third.Plans[0].RouterConversationRef == epoch {
		t.Fatal("changed model reused native session")
	}
	finish(third, "SUCCEEDED")
	fourth := accept("model-a", appendUser("fourth user turn"), uuid.NewString())
	if fourth.Plans[0].RouterConversationRef == epoch || fourth.Plans[0].RouterConversationRef == third.Plans[0].RouterConversationRef {
		t.Fatal("A to B to A reused an old checkpoint")
	}
	var req gateway.InvocationRequest
	if json.Unmarshal(fourth.Plans[0].Request, &req) != nil || !strings.Contains(string(req.ContextSnapshot), "first user turn") || !strings.Contains(string(req.ContextSnapshot), "third user turn") || len(req.PromptSpec.Messages) != 7 {
		t.Fatal("rotation discarded full role history")
	}
	finish(fourth, "FAILED")
	fifth := accept("model-a", appendUser("recover after failure"), uuid.NewString())
	if fifth.Plans[0].RouterConversationRef == fourth.Plans[0].RouterConversationRef {
		t.Fatal("failed checkpoint permanently blocked continued conversation")
	}
	finish(fifth, "SUCCEEDED")
	replay := accept("model-a", firstMid, firstKey)
	if replay.ID != first.ID || replay.Plans[0].RouterConversationRef != epoch {
		t.Fatal("later model changes mutated original receipt/binding")
	}
	if _, e := store.Get(ctx, "other-owner", first.ID); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("task binding leaked across owners", e)
	}
	if _, e := store.Conversation(ctx, "other-owner", c.ID, firstMid); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("predecessor binding leaked across owners", e)
	}
	public, _ := json.Marshal(replay)
	if strings.Contains(string(public), epoch) {
		t.Fatal("private epoch leaked in public task")
	}
	// Two accepted model choices race on the same latest USER message. The
	// conversation lock admits exactly one; neither can rewrite the winner.
	mid := appendUser("concurrent choice")
	var wg sync.WaitGroup
	results := make(chan error, 2)
	tasks := make(chan domain.Task, 2)
	for _, ref := range []string{"model-a", "model-b"} {
		wg.Add(1)
		go func(ref string) {
			defer wg.Done()
			local, _ := newService()
			task, e := local.Assistant(ctx, actor.OwnerID, c.ID, uuid.NewString(), execution.AssistantCommand{CapabilityRef: ref, CapabilityVersion: "1", MessageID: mid, Parameters: json.RawMessage(`{}`)})
			results <- e
			if e == nil {
				tasks <- task
			}
		}(ref)
	}
	wg.Wait()
	close(results)
	close(tasks)
	success, busy := 0, 0
	for e := range results {
		if e == nil {
			success++
		} else if errors.Is(e, domain.ErrBusy) {
			busy++
		} else {
			t.Fatal(e)
		}
	}
	if success != 1 || busy != 1 {
		t.Fatalf("race admitted %d winners and %d busy results", success, busy)
	}
	for winner := range tasks {
		if winner.Plans[0].RouterConversationRef == "" {
			t.Fatal("concurrent winner lost binding")
		}
		finish(winner, "SUCCEEDED")
	}
	legacy := accept("legacy", appendUser("legacy first"), uuid.NewString())
	finish(legacy, "SUCCEEDED")
	// Simulate a pre-upgrade private plan, whose logical session used the cid.
	if _, err = pool.Exec(ctx, `UPDATE execution.tasks SET payload=payload #- '{private,0,RouterConversationRef}' WHERE id=$1`, legacy.ID); err != nil {
		t.Fatal(err)
	}
	legacyNext := accept("legacy", appendUser("legacy continuation"), uuid.NewString())
	if legacyNext.Plans[0].RouterConversationRef != c.ID {
		t.Fatal("old generic native session cannot continue")
	}
}
