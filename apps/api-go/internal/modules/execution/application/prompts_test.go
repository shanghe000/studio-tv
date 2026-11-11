package application

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

type promptTestStore struct {
	Store
	task         domain.Task
	creates      int
	assets       map[string]Asset
	conversation ConversationInput
}

func (s *promptTestStore) Create(_ context.Context, t domain.Task, _, _ string, _ []Grant) (domain.Task, error) {
	s.task = t
	s.creates++
	return t, nil
}
func (s *promptTestStore) Assets(_ context.Context, _ string, ids []string) ([]Asset, error) {
	result := []Asset{}
	for _, id := range ids {
		a, ok := s.assets[id]
		if !ok {
			return nil, domain.ErrNotFound
		}
		result = append(result, a)
	}
	return result, nil
}
func (s *promptTestStore) Conversation(context.Context, string, string, string) (ConversationInput, error) {
	return s.conversation, nil
}

func (s *promptTestStore) Save(_ context.Context, task domain.Task, _ string) (bool, error) {
	s.task = task
	return true, nil
}
func (s *promptTestStore) Get(context.Context, string, string) (domain.Task, error) {
	return s.task, nil
}
func (s *promptTestStore) BindInputs(context.Context, domain.Task, string, []Grant) (bool, error) {
	return true, nil
}

type promptTestGateway struct {
	gateway.Unconfigured
	pages   map[string]gateway.CapabilityPage
	queries []gateway.CapabilityQuery
}

func (g *promptTestGateway) Capabilities(_ context.Context, a gateway.Actor, q gateway.CapabilityQuery) (gateway.CapabilityPage, error) {
	if a.SubjectRef != "owner" {
		return gateway.CapabilityPage{}, domain.ErrNotFound
	}
	g.queries = append(g.queries, q)
	return g.pages[q.Cursor], nil
}

type promptTestImporter struct{ AssetImporter }

func promptCapability(ref, kind string) gateway.Capability {
	return gateway.Capability{Ref: ref, Version: "1", Kind: kind, Available: true, TestMode: true, ParameterSchemaVersion: "1", ParameterSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`), InputKinds: []string{"TEXT", "STRUCTURED", "IMAGE", "VIDEO", "AUDIO", "FILE"}, OutputKinds: []string{"TEXT", "STRUCTURED", "IMAGE"}}
}
func promptTestService(t *testing.T, kind string) (*Service, *promptTestStore, *promptTestGateway) {
	t.Helper()
	store := &promptTestStore{assets: map[string]Asset{"img": {ID: "img", Kind: "IMAGE", MimeType: "image/png", ByteSize: 2048, Version: "sha256:a", SHA256: strings.Repeat("a", 64)}, "last": {ID: "last", Kind: "IMAGE", MimeType: "image/png", ByteSize: 2048, Version: "sha256:b", SHA256: strings.Repeat("b", 64)}, "video": {ID: "video", Kind: "VIDEO", Version: "sha256:c", SHA256: strings.Repeat("c", 64)}}}
	g := &promptTestGateway{pages: map[string]gateway.CapabilityPage{"": {Items: []gateway.Capability{promptCapability("mock", kind)}}}}
	s, e := New(store, g, &promptTestImporter{})
	if e != nil {
		t.Fatal(e)
	}
	return s, store, g
}
func promptCanvas(t *testing.T, s *Service, data string) (domain.Task, error) {
	t.Helper()
	var object map[string]any
	if json.Unmarshal([]byte(data), &object) != nil {
		t.Fatal("invalid test input")
	}
	if _, exists := object["capabilityRef"]; !exists {
		object["capabilityRef"] = "mock"
	}
	frozen, _ := json.Marshal(object)
	data = string(frozen)
	graph := json.RawMessage(`{"nodes":[{"id":"node","type":"rh-image","data":` + data + `}],"edges":[]}`)
	return s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: "NODE", TargetID: "node", Graph: graph})
}
func frozenRequest(t *testing.T, task domain.Task) gateway.InvocationRequest {
	t.Helper()
	var req gateway.InvocationRequest
	if len(task.Plans) != 1 || json.Unmarshal(task.Plans[0].Request, &req) != nil {
		t.Fatal("request was not frozen")
	}
	return req
}
func faultCode(t *testing.T, err error, want string) {
	t.Helper()
	var fault *gateway.Fault
	if !errors.As(err, &fault) || fault.Code != want {
		t.Fatalf("fault=%v want=%s", err, want)
	}
}

func TestCanvasPromptSpecKeepsStudioSceneNativeConditionsAndImageBinding(t *testing.T) {
	s, _, _ := promptTestService(t, "IMAGE_TO_IMAGE")
	task, err := promptCanvas(t, s, `{"capabilityRef":"mock","sceneCode":"canvas-image-quick-create-cinematic-lighting-rembrandt","params":{"prompt":"keep this character","negativePrompt":"no extra fingers","imageUrls":["rhtv-asset:img"],"camera":{"azimuth":45,"elevation":20},"lighting":{"power":0.8}},"routerParameters":{}}`)
	if err != nil {
		t.Fatal(err)
	}
	req := frozenRequest(t, task)
	if req.PromptSpec == nil || !strings.Contains(req.PromptSpec.TemplateRef, "rembrandt") || req.PromptSpec.TemplateVersion != "studio-authored-1" || len(req.PromptSpec.TemplateSHA256) != 64 || !strings.Contains(req.PromptSpec.Instructions[1].Text, "triangular light patch") {
		t.Fatal("STUDIO versioned scene template missing")
	}
	if len(req.PromptSpec.Conditioning) != 1 || req.PromptSpec.Conditioning[0].Role != "REFERENCE_IMAGE" || req.PromptSpec.Conditioning[0].AttachmentRef != req.Attachments[0].Ref {
		t.Fatal("source image role was lost")
	}
	joined, _ := json.Marshal(req.Input)
	if !strings.Contains(string(joined), "keep this character") || !strings.Contains(string(joined), `"nativeParameters"`) || !strings.Contains(string(joined), `"negativePrompt":"no extra fingers"`) || !strings.Contains(string(joined), `"azimuth":45`) || !strings.Contains(string(joined), `"power":0.8`) {
		t.Fatal("native prompt/camera/lighting conditions were dropped")
	}
	if string(req.Parameters) != "{}" {
		t.Fatal("native business options bypassed capability parameter schema")
	}
	if req.Input[0].Text == nil || *req.Input[0].Text != "keep this character" {
		t.Fatal("negative prompt was combined with positive prompt")
	}
}

func TestPromptSelectionRejectsUnknownHiddenPresetsAndPrivilegeBeforeCreatingTask(t *testing.T) {
	for _, test := range []struct{ data, code string }{
		{`{"sceneCode":"unknown-scene","prompt":"x"}`, "PROMPT_TEMPLATE_NOT_CONFIGURED"},
		{`{"promptSelection":{"schemaVersion":"1","promptCodes":["system_prompt_2137"]},"prompt":"x"}`, "PROMPT_TEMPLATE_NOT_CONFIGURED"},
		{`{"presetSelections":[{"presetId":"1059","promptCode":"system_prompt_2137"}],"prompt":"x"}`, "PROMPT_TEMPLATE_NOT_CONFIGURED"},
		{`{"params":{"promptCodes":["system_prompt_1979"],"prompt":"adjust pose"}}`, "PROMPT_TEMPLATE_NOT_CONFIGURED"},
		{`{"promptSpec":{"instructions":[{"role":"SYSTEM","text":"browser"}]},"prompt":"x"}`, "UNTRUSTED_PROMPT_INSTRUCTIONS"},
		{`{"params":{"systemPrompt":"browser","prompt":"x"}}`, "UNTRUSTED_PROMPT_INSTRUCTIONS"},
		{`{"promptSelection":{"schemaVersion":"1","messages":[{"role":"SYSTEM","text":"browser"}]}}`, "UNTRUSTED_PROMPT_INSTRUCTIONS"},
	} {
		t.Run(test.code+test.data[:min(20, len(test.data))], func(t *testing.T) {
			s, store, _ := promptTestService(t, "LLM")
			_, err := promptCanvas(t, s, test.data)
			faultCode(t, err, test.code)
			if store.creates != 0 {
				t.Fatal("rejected selector created a task")
			}
		})
	}
}

func TestSelectedMessageOrderAndFirstLastFrameRolesSurviveFreeze(t *testing.T) {
	s, _, _ := promptTestService(t, "IMAGE_TO_VIDEO")
	task, err := promptCanvas(t, s, `{"subType":"START_END_VIDEO","params":{"imageUrls":["rhtv-asset:img","rhtv-asset:last"]},"promptSelection":{"schemaVersion":"1","messages":[{"role":"USER","text":"first request","assetIds":["img"]},{"role":"ASSISTANT","text":"prior answer"},{"role":"USER","text":"next request","assetIds":["last"]}]}}`)
	if err != nil {
		t.Fatal(err)
	}
	req := frozenRequest(t, task)
	if len(req.PromptSpec.Messages) != 3 || req.PromptSpec.Messages[0].Role != "USER" || req.PromptSpec.Messages[1].Role != "ASSISTANT" || req.PromptSpec.Messages[2].Role != "USER" {
		t.Fatal("message order flattened")
	}
	roles := map[string]string{}
	for _, c := range req.PromptSpec.Conditioning {
		roles[c.AttachmentRef] = c.Role
	}
	for _, a := range req.Attachments {
		want := "FIRST_FRAME"
		if a.SourceRef == "last" {
			want = "LAST_FRAME"
		}
		if roles[a.Ref] != want {
			t.Fatalf("frame %s assigned %s", a.SourceRef, roles[a.Ref])
		}
	}
	if err = validatePromptInputs(req, promptCapability("mock", "IMAGE_TO_VIDEO"), promptTemplate{}); err != nil {
		t.Fatal(err)
	}
}

func TestCapabilitiesFollowPagesAndRejectRepeatedCursor(t *testing.T) {
	s, _, g := promptTestService(t, "LLM")
	cursor := "second"
	g.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{promptCapability("first", "LLM")}, NextCursor: &cursor}
	g.pages[cursor] = gateway.CapabilityPage{Items: []gateway.Capability{promptCapability("second", "TEXT_TO_IMAGE")}}
	page, err := s.capabilities(context.Background(), "owner", "")
	if err != nil || len(page.Items) != 2 || len(g.queries) != 2 || g.queries[1].Cursor != "second" {
		t.Fatal("capability page lost", err)
	}
	g.pages[cursor] = gateway.CapabilityPage{Items: []gateway.Capability{promptCapability("second", "LLM")}, NextCursor: &cursor}
	_, err = s.capabilities(context.Background(), "owner", "")
	faultCode(t, err, "PROTOCOL_MISMATCH")
}

func TestAssistantTrustsStoredBusinessAndRetainsAllHistoricalRolesAndMedia(t *testing.T) {
	s, store, _ := promptTestService(t, "LLM")
	store.conversation = ConversationInput{Kind: "HF", Content: json.RawMessage(`[{"type":"TEXT","text":"continue"}]`), Context: json.RawMessage(`{"schemaVersion":"1","messages":[{"role":"USER","content":[{"type":"TEXT","text":"analyze this"},{"type":"ASSET","assetId":"img"}]},{"role":"ASSISTANT","content":[{"type":"TEXT","text":"prior result"}]},{"role":"TOOL","content":[{"type":"TEXT","text":"read observation"}]},{"role":"USER","content":[{"type":"TEXT","text":"continue"}]}]}`)}
	task, err := s.Assistant(context.Background(), "owner", "conversation", uuid.NewString(), AssistantCommand{CapabilityRef: "mock", CapabilityVersion: "1", MessageID: "message", Parameters: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatal(err)
	}
	req := frozenRequest(t, task)
	if req.PromptSpec.TemplateRef != "studio-tv/assistant/hf" || len(req.PromptSpec.Messages) != 4 || len(req.Attachments) != 1 || req.PromptSpec.Messages[1].Role != "ASSISTANT" || req.PromptSpec.Messages[2].Role != "USER" {
		t.Fatal("business/role/media trust boundary lost")
	}
	if req.Input[4].Text == nil || !strings.Contains(*req.Input[4].Text, "continue") {
		t.Fatal("current message duplicated or dropped")
	}
}

func TestStrictFeatureOutputRejectsGenericMockSuccess(t *testing.T) {
	template, _ := featureTemplate("skill.optimize")
	request := gateway.InvocationRequest{PromptSpec: template.spec()}
	text := "[TEST MODE] generic fixture"
	err := validatePromptOutput(request, gateway.Invocation{TestMode: true, OutputParts: []gateway.OutputPart{{Type: "TEXT", Text: &text}}})
	faultCode(t, err, "PROMPT_OUTPUT_INVALID")
	text = `{"optimized_content":"# Use owned files"}`
	if err = validatePromptOutput(request, gateway.Invocation{TestMode: true, OutputParts: []gateway.OutputPart{{Type: "TEXT", Text: &text}}}); err != nil {
		t.Fatal(err)
	}
	text = `{"optimized_content":"","unexpected":"x"}`
	faultCode(t, validatePromptOutput(request, gateway.Invocation{OutputParts: []gateway.OutputPart{{Type: "TEXT", Text: &text}}}), "PROMPT_OUTPUT_INVALID")
}

type receiptModeGateway struct {
	*promptTestGateway
	submitTestMode bool
	readTestMode   bool
	submits        int
	reads          int
	cancels        int
}

func (g *receiptModeGateway) Submit(context.Context, gateway.Actor, gateway.Submission) (gateway.Invocation, error) {
	g.submits++
	return gateway.Invocation{Ref: "private-receipt", State: "RUNNING", TestMode: g.submitTestMode}, nil
}
func (g *receiptModeGateway) Invocation(context.Context, gateway.Actor, string) (gateway.Invocation, error) {
	g.reads++
	text := "must never become a test result"
	return gateway.Invocation{Ref: "private-receipt", State: "SUCCEEDED", TestMode: g.readTestMode, OutputParts: []gateway.OutputPart{{Type: "TEXT", Text: &text}}}, nil
}
func (g *receiptModeGateway) Cancel(context.Context, gateway.Actor, string, gateway.CancelRequest) (gateway.Invocation, error) {
	g.cancels++
	return gateway.Invocation{Ref: "private-receipt", State: "CANCELED"}, nil
}

func TestWorkerRejectsChangedTestModeWithoutPublishingOrResubmitting(t *testing.T) {
	for _, phase := range []string{"submit", "read", "resume"} {
		t.Run(phase, func(t *testing.T) {
			s, store, catalog := promptTestService(t, "LLM")
			g := &receiptModeGateway{promptTestGateway: catalog, submitTestMode: phase != "submit"}
			s.gateway = g
			task, err := promptCanvas(t, s, `{"params":{"prompt":"write a story"}}`)
			if err != nil {
				t.Fatal(err)
			}
			if phase == "resume" {
				ref := "private-receipt"
				task.Plans[0].InvocationRef = &ref
			}
			s.execute(context.Background(), task, "lease")
			got := store.task
			if got.State != "FAILED" || got.ErrorCode == nil || *got.ErrorCode != "MODEL_RECEIPT_MODE_MISMATCH" || got.Plans[0].InvocationRef == nil || *got.Plans[0].InvocationRef != "private-receipt" || len(got.Plans[0].Outputs) != 0 || g.cancels != 1 {
				t.Fatalf("mismatched receipt was published or lost: state=%s cancel=%d", got.State, g.cancels)
			}
			wantSubmits := 1
			if phase == "resume" {
				wantSubmits = 0
			}
			if g.submits != wantSubmits || phase == "submit" && g.reads != 0 {
				t.Fatal("unexpected generation or receipt read")
			}
		})
	}
}

func TestCurrentNativeTextWinsAndEmptyParametersDoNotResurrectOldOutput(t *testing.T) {
	for _, test := range []struct{ params, want string }{
		{`{"prompt":"","text":"read this actual dialogue","negativePrompt":"no whisper"}`, "read this actual dialogue"},
		{`{"prompt":"","text":"","content":"","positivePrompt":""}`, ""},
	} {
		s, _, _ := promptTestService(t, "TEXT_TO_AUDIO")
		task, err := promptCanvas(t, s, `{"text":"stale previous output","params":`+test.params+`}`)
		if err != nil {
			t.Fatal(err)
		}
		req := frozenRequest(t, task)
		joined, _ := json.Marshal(req.Input)
		if strings.Contains(string(joined), "stale previous output") {
			t.Fatal("old display output restored as current prompt")
		}
		text := ""
		for _, part := range req.Input {
			if part.Type == "TEXT" && part.Text != nil {
				text += *part.Text
			}
		}
		if text != test.want {
			t.Fatalf("current text=%q want=%q", text, test.want)
		}
	}
}

func TestExplicitStyleKeepsDerivedFirstAndLastFrames(t *testing.T) {
	s, store, _ := promptTestService(t, "IMAGE_TO_VIDEO")
	store.assets["style"] = Asset{ID: "style", Kind: "IMAGE", MimeType: "image/png", ByteSize: 2048, Version: "sha256:d", SHA256: strings.Repeat("d", 64)}
	task, err := promptCanvas(t, s, `{"subType":"START_END_VIDEO","params":{"prompt":"animate","imageUrls":["rhtv-asset:img","rhtv-asset:last"]},"promptSelection":{"schemaVersion":"1","referenceBindings":[{"assetId":"style","role":"STYLE"}]}}`)
	if err != nil {
		t.Fatal(err)
	}
	req := frozenRequest(t, task)
	byRef := map[string]string{}
	for _, a := range req.Attachments {
		byRef[a.Ref] = a.SourceRef
	}
	roles := map[string]string{}
	for _, c := range req.PromptSpec.Conditioning {
		roles[byRef[c.AttachmentRef]] = c.Role
	}
	if roles["img"] != "FIRST_FRAME" || roles["last"] != "LAST_FRAME" || roles["style"] != "STYLE" {
		t.Fatalf("mixed role mapping=%v", roles)
	}
}

func TestUpstreamMediaRequiresProvenSpecialSlotsAndUpdatesPromptManifest(t *testing.T) {
	s, _, _ := promptTestService(t, "IMAGE_TO_VIDEO")
	first, last := "img", "last"
	graph := json.RawMessage(`{"nodes":[{"id":"a","type":"rh-image"},{"id":"b","type":"rh-image"},{"id":"target","type":"rh-video","data":{"subType":"START_END_VIDEO"}}],"edges":[{"source":"a","target":"target","conditioningRole":"FIRST_FRAME"},{"source":"b","target":"target","targetHandle":"LAST_FRAME"}]}`)
	task := domain.Task{OwnerID: "owner", Kind: "CANVAS", Snapshot: graph, Plans: []domain.Plan{{NodeID: "a", State: "SUCCEEDED", Outputs: []domain.Output{{Type: "ASSET", AssetID: &first}}}, {NodeID: "b", State: "SUCCEEDED", Outputs: []domain.Output{{Type: "ASSET", AssetID: &last}}}, {NodeID: "target"}}}
	template, _ := defaultTemplate("IMAGE_TO_VIDEO")
	request := gateway.InvocationRequest{Input: []gateway.InputPart{}, Attachments: []gateway.Attachment{}, PromptSpec: template.spec()}
	grants, err := s.bindUpstream(context.Background(), task, 2, &request)
	if err != nil || len(grants) != 2 || len(request.Input) != 2 || len(request.PromptSpec.Messages) != 2 || request.PromptSpec.Conditioning[0].Role != "FIRST_FRAME" || request.PromptSpec.Conditioning[1].Role != "LAST_FRAME" {
		t.Fatalf("fresh upstream binding lost %v", err)
	}
	var parsed domain.Graph
	_ = json.Unmarshal(graph, &parsed)
	parsed.Edges[0].ConditioningRole = ""
	role, err := upstreamConditioning(parsed, "a", "target", "IMAGE")
	if err != nil || role != "" {
		t.Fatal("ordinary images should resolve temporal roles after all inputs are ordered", err)
	}
	parsed.Edges[0].ConditioningRole = "SOURCE_VIDEO"
	_, err = upstreamConditioning(parsed, "a", "target", "IMAGE")
	faultCode(t, err, "PROMPT_CONDITIONING_INVALID")
}
