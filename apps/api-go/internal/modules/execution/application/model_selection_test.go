package application

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

func TestConversationModelEpochReuseSwitchFailureAndLegacy(t *testing.T) {
	a := promptCapability("text-a", "LLM")
	a.Model = &gateway.ModelDescriptor{ProviderRef: "supplier", ModelRef: "a", Version: "6.1"}
	b := a
	b.Ref = "text-b"
	first := routerConversationKey("conversation", "m1", a, ConversationInput{})
	if first == "conversation" || first != routerConversationKey("conversation", "m1", a, ConversationInput{}) {
		t.Fatal("new epoch must be deterministic and separate")
	}
	previous := ConversationInput{PreviousCapabilityRef: a.Ref, PreviousCapabilityVersion: a.Version, PreviousState: "SUCCEEDED", RouterConversationRef: first}
	if routerConversationKey("conversation", "m2", a, previous) != first {
		t.Fatal("same successful model lost native session")
	}
	second := routerConversationKey("conversation", "m2", b, previous)
	previous.PreviousCapabilityRef = b.Ref
	previous.RouterConversationRef = second
	third := routerConversationKey("conversation", "m3", a, previous)
	if third == first || third == second {
		t.Fatal("A to B to A reused a checkpoint with incompatible history")
	}
	for _, state := range []string{"FAILED", "CANCELED", "RUNNING", "WAITING_TOOL"} {
		previous.PreviousCapabilityRef = a.Ref
		previous.RouterConversationRef = first
		previous.PreviousState = state
		if routerConversationKey("conversation", "next", a, previous) == first {
			t.Fatalf("%s predecessor reused potentially blocked checkpoint", state)
		}
	}
	legacy := a
	legacy.Model = nil
	if routerConversationKey("conversation", "m1", legacy, ConversationInput{}) != "conversation" {
		t.Fatal("first legacy binding changed")
	}
	if routerConversationKey("conversation", "m2", legacy, ConversationInput{PreviousCapabilityRef: a.Ref, PreviousCapabilityVersion: a.Version, PreviousState: "SUCCEEDED"}) != "conversation" {
		t.Fatal("old persisted generic session cannot continue")
	}
	previous = ConversationInput{PreviousCapabilityRef: a.Ref, PreviousCapabilityVersion: "old", PreviousState: "SUCCEEDED", RouterConversationRef: first}
	if routerConversationKey("conversation", "m2", a, previous) == first {
		t.Fatal("version change reused epoch")
	}
}

func TestAssistantVisionSelectionPreservesOriginalTemplateAndHistory(t *testing.T) {
	s, store, g := promptTestService(t, "LLM")
	s.WithRealExecution(true)
	text := promptCapability("text", "LLM")
	text.TestMode = false
	text.ExecutionKind = "AGENT"
	text.InputKinds = []string{"TEXT", "STRUCTURED"}
	text.Model = &gateway.ModelDescriptor{ProviderRef: "supplier", ModelRef: "text", Version: "5.6"}
	vision := text
	vision.Ref = "vision"
	vision.Kind = "IMAGE_UNDERSTANDING"
	vision.InputKinds = []string{"TEXT", "STRUCTURED", "IMAGE"}
	vision.Model = &gateway.ModelDescriptor{ProviderRef: "supplier", ModelRef: "vision", Version: "6.1"}
	g.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{text, vision}}
	store.conversation = ConversationInput{Kind: "GLOBAL", Revision: 3, Content: json.RawMessage(`[{"type":"TEXT","text":"continue"}]`), Context: json.RawMessage(`{"schemaVersion":"1","messages":[{"role":"USER","content":[{"type":"ASSET","assetId":"img"}]},{"role":"ASSISTANT","content":[{"type":"TEXT","text":"prior"}]},{"role":"USER","content":[{"type":"TEXT","text":"continue"}]}]}`)}
	cmd := AssistantCommand{CapabilityRef: text.Ref, CapabilityVersion: "1", MessageID: "m", Parameters: json.RawMessage(`{}`)}
	_, err := s.Assistant(context.Background(), "owner", "c", uuid.NewString(), cmd)
	if err == nil || store.creates != 0 {
		t.Fatal("text-only model accepted image history")
	}
	cmd.CapabilityRef = vision.Ref
	task, err := s.Assistant(context.Background(), "owner", "c", uuid.NewString(), cmd)
	if err != nil {
		t.Fatal(err)
	}
	req := frozenRequest(t, task)
	if req.Correlation == nil || req.Correlation.ConversationRef != task.Plans[0].RouterConversationRef || req.Correlation.ConversationRef == "c" || task.ConversationID == nil || *task.ConversationID != "c" {
		t.Fatal("Router session correlation diverged from its frozen epoch or changed product conversation")
	}
	if req.Capability.Ref != vision.Ref || !strings.Contains(string(req.ContextSnapshot), `"assetId":"img"`) || len(req.Attachments) != 1 || req.PromptSpec == nil || req.PromptSpec.TemplateVersion != "studio-authored-1" || len(req.PromptSpec.Instructions) != 2 || req.PromptSpec.Instructions[0].Role != "SYSTEM" || req.PromptSpec.Instructions[1].Role != "DEVELOPER" {
		t.Fatal("selected vision profile changed authored contract or full image history")
	}
	public, _ := json.Marshal(task)
	if strings.Contains(string(public), task.Plans[0].RouterConversationRef) || strings.Contains(string(public), "RouterConversationRef") {
		t.Fatal("private epoch leaked publicly")
	}
}

func TestRealModelJSONContractAcceptsValidatedTextWithoutChangingStoryboardSchema(t *testing.T) {
	s, _, g := promptTestService(t, "LLM")
	s.WithRealExecution(true)
	cap := promptCapability("real-text", "LLM")
	cap.TestMode = false
	cap.Model = &gateway.ModelDescriptor{ProviderRef: "supplier", ModelRef: "text", Version: "6.1"}
	cap.InputKinds = []string{"TEXT", "STRUCTURED"}
	cap.OutputKinds = []string{"TEXT"}
	g.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
	task, err := promptCanvas(t, s, `{"capabilityRef":"real-text","sceneCode":"storyboard-prompt-film","params":{"prompt":"two shots","scene":"film"}}`)
	if err != nil {
		t.Fatal(err)
	}
	req := frozenRequest(t, task)
	original, ok := sceneTemplate("storyboard-prompt-film")
	if !ok || req.PromptSpec == nil || req.PromptSpec.OutputContract == nil {
		t.Fatal("storyboard fixture missing")
	}
	originalBytes, _ := json.Marshal(original.spec())
	var want gateway.PromptSpec
	_ = json.Unmarshal(originalBytes, &want)
	if req.PromptSpec.TemplateSHA256 != want.TemplateSHA256 || string(req.PromptSpec.OutputContract.Schema) != string(want.OutputContract.Schema) {
		t.Fatal("selected model changed original schema or privileged instruction digest")
	}
	cap.OutputKinds = []string{"IMAGE"}
	g.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
	_, err = promptCanvas(t, s, `{"capabilityRef":"real-text","params":{"prompt":"text only"}}`)
	faultCode(t, err, "PROMPT_CAPABILITY_MISMATCH")
}
