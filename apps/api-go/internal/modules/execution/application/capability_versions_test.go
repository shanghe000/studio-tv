package application

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

type versionTestGateway struct {
	*receiptModeGateway
	exact       map[string]gateway.Capability
	exactCalls  int
	actor       gateway.Actor
	ref, ver    string
	exactErr    error
	wrongPair   bool
	submissions []gateway.InvocationRequest
}

func (g *versionTestGateway) CapabilityVersion(_ context.Context, actor gateway.Actor, ref, version string) (gateway.Capability, error) {
	g.exactCalls++
	g.actor, g.ref, g.ver = actor, ref, version
	if actor.SubjectRef != "owner" {
		return gateway.Capability{}, domain.ErrNotFound
	}
	if g.exactErr != nil {
		return gateway.Capability{}, g.exactErr
	}
	cap, ok := g.exact[ref+"/"+version]
	if !ok {
		return gateway.Capability{}, &gateway.Fault{Code: "CAPABILITY_NOT_FOUND"}
	}
	if g.wrongPair {
		cap.Version = "2"
	}
	return cap, nil
}

func (g *versionTestGateway) Submit(ctx context.Context, actor gateway.Actor, cmd gateway.Submission) (gateway.Invocation, error) {
	g.submissions = append(g.submissions, cmd.Request)
	return g.receiptModeGateway.Submit(ctx, actor, cmd)
}

func (g *versionTestGateway) EnsureSession(_ context.Context, actor gateway.Actor, ref string) (gateway.Session, error) {
	if actor.SubjectRef != "owner" {
		return gateway.Session{}, domain.ErrNotFound
	}
	return gateway.Session{Ref: "session", ConversationRef: ref}, nil
}

func versionTestService(t *testing.T) (*Service, *promptTestStore, *versionTestGateway) {
	t.Helper()
	s, store, catalog := promptTestService(t, "LLM")
	old := catalog.pages[""].Items[0]
	latest := old
	latest.Version, latest.ParameterSchemaVersion = "2", "2"
	latest.ParameterSchema = json.RawMessage(`{"type":"object","additionalProperties":false,"required":["reasoningEffort"],"properties":{"reasoningEffort":{"type":"string","enum":["low","high"],"default":"low"}}}`)
	catalog.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{latest}}
	g := &versionTestGateway{receiptModeGateway: &receiptModeGateway{promptTestGateway: catalog, submitTestMode: true, readTestMode: true}, exact: map[string]gateway.Capability{"mock/1": old, "mock/2": latest}}
	s.gateway = g
	store.conversation = ConversationInput{Kind: "GLOBAL", Content: json.RawMessage(`[{"type":"TEXT","text":"write a story"}]`), Context: json.RawMessage(`{"schemaVersion":"1","messages":[]}`)}
	return s, store, g
}

func TestCanvasExactOldVersionKeepsEmptyParametersAndLatestDoesNotQueryExact(t *testing.T) {
	s, _, g := versionTestService(t)
	task, err := promptCanvas(t, s, `{"capabilityVersion":"1","params":{"prompt":"write a story"},"routerParameters":{}}`)
	if err != nil {
		t.Fatal(err)
	}
	req := frozenRequest(t, task)
	if req.Capability.Version != "1" || req.ParameterSchemaVersion != "1" || string(req.Parameters) != "{}" || g.exactCalls != 1 || g.actor.SubjectRef != "owner" || g.ref != "mock" || g.ver != "1" {
		t.Fatal("old selection silently upgraded")
	}
	latest, err := promptCanvas(t, s, `{"capabilityVersion":"2","params":{"prompt":"write a story"},"routerParameters":{"reasoningEffort":"high"}}`)
	if err != nil {
		t.Fatal(err)
	}
	latestRequest := frozenRequest(t, latest)
	if latestRequest.Capability.Version != "2" || latestRequest.ParameterSchemaVersion != "2" || string(latestRequest.Parameters) != `{"reasoningEffort":"high"}` || g.exactCalls != 1 {
		t.Fatal("latest selection or reasoning value changed")
	}
}

func TestAssistantExactOldVersionAndUnknownFailClosedBeforeCreatingTask(t *testing.T) {
	s, store, g := versionTestService(t)
	cmd := AssistantCommand{CapabilityRef: "mock", CapabilityVersion: "1", MessageID: "message", Parameters: json.RawMessage(`{}`)}
	task, err := s.Assistant(context.Background(), "owner", "conversation", uuid.NewString(), cmd)
	if err != nil {
		t.Fatal(err)
	}
	req := frozenRequest(t, task)
	if req.Capability.Version != "1" || req.ParameterSchemaVersion != "1" || string(req.Parameters) != "{}" || g.exactCalls != 1 || g.actor.SubjectRef != "owner" {
		t.Fatal("assistant old schema lost")
	}
	cmd.CapabilityVersion, cmd.Parameters = "2", json.RawMessage(`{"reasoningEffort":"high"}`)
	if _, err = s.Assistant(context.Background(), "owner", "conversation", uuid.NewString(), cmd); err != nil || g.exactCalls != 1 {
		t.Fatal("matching latest made exact query", err)
	}
	creates := store.creates
	cmd.CapabilityVersion = "unknown"
	_, err = s.Assistant(context.Background(), "owner", "conversation", uuid.NewString(), cmd)
	faultCode(t, err, "CAPABILITY_NOT_FOUND")
	if store.creates != creates {
		t.Fatal("unknown assistant version created task")
	}
	_, err = s.Assistant(context.Background(), "foreign_owner", "conversation", uuid.NewString(), cmd)
	if !errors.Is(err, domain.ErrNotFound) || store.creates != creates {
		t.Fatal("cross-owner assistant created task")
	}
}

func TestExplicitVersionMissingFromLatestUsesExactAndNeverDefaultsUnknown(t *testing.T) {
	for _, test := range []string{"missing_latest_ref", "unknown", "wrong_pair", "unavailable"} {
		t.Run(test, func(t *testing.T) {
			s, store, g := versionTestService(t)
			switch test {
			case "missing_latest_ref":
				g.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{}}
			case "unknown":
				delete(g.exact, "mock/1")
			case "wrong_pair":
				g.wrongPair = true
			case "unavailable":
				cap := g.exact["mock/1"]
				cap.Available = false
				g.exact["mock/1"] = cap
			}
			_, err := promptCanvas(t, s, `{"capabilityVersion":"1","params":{"prompt":"write a story"},"routerParameters":{}}`)
			if test == "missing_latest_ref" {
				if err != nil || store.creates != 1 {
					t.Fatal("known old version requires latest ref", err)
				}
				return
			}
			want := map[string]string{"unknown": "CAPABILITY_NOT_FOUND", "wrong_pair": "PROTOCOL_MISMATCH", "unavailable": "CAPABILITY_UNAVAILABLE"}[test]
			faultCode(t, err, want)
			if store.creates != 0 || g.submits != 0 {
				t.Fatal("rejected exact version created or submitted task")
			}
		})
	}
}

func TestWorkerExactFrozenVersionUsesOriginalSchemaForCanvasAndAssistant(t *testing.T) {
	for _, mode := range []string{"canvas", "assistant"} {
		t.Run(mode, func(t *testing.T) {
			s, store, g := versionTestService(t)
			var task domain.Task
			var err error
			if mode == "canvas" {
				task, err = promptCanvas(t, s, `{"capabilityVersion":"1","params":{"prompt":"write a story"},"routerParameters":{}}`)
			} else {
				task, err = s.Assistant(context.Background(), "owner", "conversation", uuid.NewString(), AssistantCommand{CapabilityRef: "mock", CapabilityVersion: "1", MessageID: "message", Parameters: json.RawMessage(`{}`)})
			}
			if err != nil {
				t.Fatal(err)
			}
			queries := len(g.queries)
			s.execute(context.Background(), task, "lease")
			if store.task.State != "SUCCEEDED" || g.exactCalls != 2 || len(g.queries) != queries || g.submits != 1 || len(g.submissions) != 1 || g.actor.SubjectRef != task.OwnerID {
				t.Fatalf("worker did not use exact metadata: state=%s exact=%d submit=%d", store.task.State, g.exactCalls, g.submits)
			}
			req := g.submissions[0]
			if req.Capability.Version != "1" || req.ParameterSchemaVersion != "1" || string(req.Parameters) != "{}" {
				t.Fatal("worker upgraded @1 {} to latest reasoning schema")
			}
		})
	}
}

func TestWorkerUnknownWrongPairAndForgedFrozenMetadataCannotSubmit(t *testing.T) {
	for _, mode := range []string{"unknown", "wrong_pair", "request_pair", "schema_version", "old_parameters", "unavailable", "owner"} {
		t.Run(mode, func(t *testing.T) {
			s, store, g := versionTestService(t)
			task, err := promptCanvas(t, s, `{"capabilityVersion":"1","params":{"prompt":"write a story"},"routerParameters":{}}`)
			if err != nil {
				t.Fatal(err)
			}
			req := frozenRequest(t, task)
			switch mode {
			case "unknown":
				delete(g.exact, "mock/1")
			case "wrong_pair":
				g.wrongPair = true
			case "request_pair":
				req.Capability.Version = "2"
			case "schema_version":
				req.ParameterSchemaVersion = "2"
			case "old_parameters":
				req.Parameters = json.RawMessage(`{"reasoningEffort":"high"}`)
			case "unavailable":
				cap := g.exact["mock/1"]
				cap.Available = false
				g.exact["mock/1"] = cap
			case "owner":
				task.OwnerID = "foreign_owner"
			}
			task.Plans[0].Request, _ = json.Marshal(req)
			s.execute(context.Background(), task, "lease")
			if store.task.State != "FAILED" || g.submits != 0 || g.reads != 0 {
				t.Fatalf("bad frozen metadata submitted: %s %+v", mode, store.task)
			}
		})
	}
}
