package application

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"reflect"
	"strings"
	"testing"
)

type testCanvasReader struct {
	calls int
	t     *testing.T
	err   error
}

func (r *testCanvasReader) ReadCanvasContext(_ context.Context, owner, project string) (json.RawMessage, error) {
	r.calls++
	if owner != "owner" || project != "owned-project" {
		r.t.Fatal("wrong actor or project")
	}
	return json.RawMessage(`{"schemaVersion":"STUDIO_CANVAS_CONTEXT_V1","projectId":"owned-project","graphRevision":8,"nodes":[{"id":"stored-node","type":"rh-text","text":"已保存剧本"}],"edges":[],"truncated":false,"toolExecutionAvailable":false}`), r.err
}
func TestCanvasAssistantFreezesContextWithoutChangingPreset(t *testing.T) {
	s, store, _ := promptTestService(t, "LLM")
	pid := "owned-project"
	store.conversation = ConversationInput{Kind: "CANVAS", ProjectID: &pid, Content: json.RawMessage(`[{"type":"TEXT","text":"继续剧本"}]`), Context: json.RawMessage(`{"schemaVersion":"1","messages":[{"role":"USER","content":[{"type":"TEXT","text":"继续剧本"}]}]}`)}
	reader := &testCanvasReader{t: t}
	s.WithCanvasContext(reader)
	task, err := s.Assistant(context.Background(), "owner", "conversation", uuid.NewString(), AssistantCommand{CapabilityRef: "mock", CapabilityVersion: "1", MessageID: "message", Parameters: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatal(err)
	}
	request := frozenRequest(t, task)
	baseline, _ := assistantTemplate("CANVAS")
	if !reflect.DeepEqual(request.PromptSpec.Instructions, baseline.spec().Instructions) {
		t.Fatal("changed authored instructions")
	}
	if reader.calls != 1 || len(request.Input) != 2 || !strings.Contains(*request.Input[1].Text, "stored-node") || !strings.Contains(*request.Input[1].Text, `"graphRevision":8`) {
		t.Fatal("missing frozen canvas snapshot")
	}
	if !reflect.DeepEqual(request.PromptSpec.Messages[0].InputIndexes, []int{0, 1}) || request.PromptSpec.Messages[0].Role != "USER" {
		t.Fatal("context acquired elevated instruction role")
	}
	if request.Correlation.ProjectRef != pid {
		t.Fatal("wrong project correlation")
	}
}

func TestCanvasContextSecondTurnStartsNewSessionWithAuthoritativeHistory(t *testing.T) {
	s, store, _ := promptTestService(t, "LLM")
	pid := "owned-project"
	reader := &testCanvasReader{t: t}
	s.WithCanvasContext(reader)
	store.conversation = ConversationInput{Kind: "CANVAS", ProjectID: &pid, Content: json.RawMessage(`[{"type":"TEXT","text":"first turn"}]`), Context: json.RawMessage(`{"schemaVersion":"1","messages":[{"role":"USER","content":[{"type":"TEXT","text":"first turn"}]}]}`)}
	first, err := s.Assistant(context.Background(), "owner", "conversation", uuid.NewString(), AssistantCommand{CapabilityRef: "mock", CapabilityVersion: "1", MessageID: "first", Parameters: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatal(err)
	}
	firstRequest := frozenRequest(t, first)
	store.conversation = ConversationInput{Kind: "CANVAS", ProjectID: &pid, PreviousCapabilityRef: "mock", PreviousCapabilityVersion: "1", PreviousState: "SUCCEEDED", RouterConversationRef: firstRequest.Correlation.ConversationRef, Content: json.RawMessage(`[{"type":"TEXT","text":"second turn"}]`), Context: json.RawMessage(`{"schemaVersion":"1","messages":[{"role":"USER","content":[{"type":"TEXT","text":"first turn"}]},{"role":"ASSISTANT","content":[{"type":"TEXT","text":"prior saved answer"}]},{"role":"USER","content":[{"type":"TEXT","text":"second turn"}]}]}`)}
	command := AssistantCommand{CapabilityRef: "mock", CapabilityVersion: "1", MessageID: "second", Parameters: json.RawMessage(`{}`)}
	second, err := s.Assistant(context.Background(), "owner", "conversation", uuid.NewString(), command)
	if err != nil {
		t.Fatal("second turn rejected", err)
	}
	req := frozenRequest(t, second)
	if req.Correlation.ConversationRef == firstRequest.Correlation.ConversationRef || second.Plans[0].RouterConversationRef != req.Correlation.ConversationRef {
		t.Fatal("native checkpoint reused despite changed historical canvas parts")
	}
	if len(req.PromptSpec.Messages) != 3 || req.PromptSpec.Messages[0].Role != "USER" || req.PromptSpec.Messages[1].Role != "ASSISTANT" || req.PromptSpec.Messages[2].Role != "USER" || !reflect.DeepEqual(req.PromptSpec.Messages[2].InputIndexes, []int{2, 3}) || *req.Input[1].Text != "prior saved answer" || reader.calls != 2 {
		t.Fatal("authoritative roleful history or current snapshot lost")
	}
	replay, err := s.Assistant(context.Background(), "owner", "conversation", uuid.NewString(), command)
	if err != nil || frozenRequest(t, replay).Correlation.ConversationRef != req.Correlation.ConversationRef {
		t.Fatal("same accepted turn did not retain stable router session key", err)
	}
}

func TestCanvasContextDoesNotAlterGlobalHFSessionPolicy(t *testing.T) {
	for _, kind := range []string{"GLOBAL", "HF"} {
		t.Run(kind, func(t *testing.T) {
			s, store, _ := promptTestService(t, "LLM")
			reader := &testCanvasReader{t: t}
			s.WithCanvasContext(reader)
			store.conversation = ConversationInput{Kind: kind, PreviousCapabilityRef: "mock", PreviousCapabilityVersion: "1", PreviousState: "SUCCEEDED", RouterConversationRef: "existing-native-session", Content: json.RawMessage(`[{"type":"TEXT","text":"continue"}]`), Context: json.RawMessage(`{"schemaVersion":"1","messages":[{"role":"USER","content":[{"type":"TEXT","text":"continue"}]}]}`)}
			task, err := s.Assistant(context.Background(), "owner", "conversation", uuid.NewString(), AssistantCommand{CapabilityRef: "mock", CapabilityVersion: "1", MessageID: "message", Parameters: json.RawMessage(`{}`)})
			if err != nil {
				t.Fatal(err)
			}
			req := frozenRequest(t, task)
			if reader.calls != 0 || len(req.Input) != 1 || req.Correlation.ConversationRef != "existing-native-session" {
				t.Fatal("GLOBAL/HF session changed")
			}
		})
	}
}
