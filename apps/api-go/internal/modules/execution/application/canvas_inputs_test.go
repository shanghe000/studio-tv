package application

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

func requestAssetIDs(request gateway.InvocationRequest) []string {
	ids := []string{}
	for _, a := range request.Attachments {
		ids = append(ids, a.SourceRef)
	}
	return ids
}

func requestMediaIDs(request gateway.InvocationRequest) []string {
	byRef := map[string]string{}
	for _, a := range request.Attachments {
		byRef[a.Ref] = a.SourceRef
	}
	ids := []string{}
	for _, part := range request.Input {
		if part.AttachmentRef != nil {
			ids = append(ids, byRef[*part.AttachmentRef])
		}
	}
	return ids
}

func requestRoles(request gateway.InvocationRequest) map[string]string {
	byRef := map[string]string{}
	for _, a := range request.Attachments {
		byRef[a.Ref] = a.SourceRef
	}
	roles := map[string]string{}
	for _, c := range request.PromptSpec.Conditioning {
		roles[byRef[c.AttachmentRef]] = c.Role
	}
	return roles
}

func TestCanvasMediaOrderIsStableSortAcrossModalitiesAndKeepsUnlistedInputs(t *testing.T) {
	s, store, _ := promptTestService(t, "OMNI_REFERENCE")
	for _, row := range []struct{ id, kind string }{{"middle", "IMAGE"}, {"v2", "VIDEO"}, {"a1", "AUDIO"}, {"a2", "AUDIO"}, {"a3", "AUDIO"}} {
		store.assets[row.id] = Asset{ID: row.id, Kind: row.kind, Version: "sha256:" + row.id, SHA256: strings.Repeat("d", 64)}
	}
	data := `{"prompt":"ordered fixture","params":{"zNested":{"imageUrl":"rhtv-asset:last"},"images":[{"_key":"middle-key","url":"rhtv-asset:middle"}],"aNested":{"imageUrl":"rhtv-asset:img"},"videoUrls":["rhtv-asset:video","rhtv-asset:v2"],"audioUrls":["rhtv-asset:a1","rhtv-asset:a2","rhtv-asset:a3"]},"imageOrder":["stale-entry","middle-key","node::rhtv-asset:last"],"videoOrder":["rhtv-asset:v2"],"audioOrder":["a2"],"output":[{"assetId":"forged-output"}],"history":[{"assetId":"forged-history"}],"nodeOutputHistory":[{"assetId":"forged-native-history"}],"executionOutputHistory":[{"url":"https://invalid-history.test"}]}`
	var baseline []string
	for i := 0; i < 80; i++ {
		task, err := promptCanvas(t, s, data)
		if err != nil {
			t.Fatal(err)
		}
		request := frozenRequest(t, task)
		ids := requestAssetIDs(request)
		if i == 0 {
			baseline = ids
		} else if !reflect.DeepEqual(ids, baseline) {
			t.Fatalf("map-dependent order: first=%v got=%v", baseline, ids)
		}
		byKind := map[string][]string{}
		for _, a := range request.Attachments {
			byKind[a.Kind] = append(byKind[a.Kind], a.SourceRef)
		}
		if !reflect.DeepEqual(byKind["IMAGE"], []string{"middle", "last", "img"}) || !reflect.DeepEqual(byKind["VIDEO"], []string{"v2", "video"}) || !reflect.DeepEqual(byKind["AUDIO"], []string{"a2", "a1", "a3"}) {
			t.Fatalf("sort became filtering or reordered unlisted media: %v", byKind)
		}
		if !reflect.DeepEqual(requestMediaIDs(request), ids) || len(task.Plans[0].InputReferences) != len(ids) {
			t.Fatal("transport input and frozen references disagree")
		}
		public, _ := json.Marshal(task)
		if strings.Contains(string(public), "InputReferences") || strings.Contains(string(public), "AssetVersion") {
			t.Fatal("private reference manifest leaked")
		}
	}
}

func TestFirstLastUsesFirstAndFinalSortedImageAndKeepsStyleRoles(t *testing.T) {
	s, store, _ := promptTestService(t, "IMAGE_TO_VIDEO")
	store.assets["middle"] = Asset{ID: "middle", Kind: "IMAGE", MimeType: "image/png", ByteSize: 2048, Version: "sha256:middle"}
	store.assets["style"] = Asset{ID: "style", Kind: "IMAGE", MimeType: "image/png", ByteSize: 2048, Version: "sha256:style"}
	task, err := promptCanvas(t, s, `{"subType":"START_END_VIDEO","params":{"imageUrls":["rhtv-asset:img","rhtv-asset:middle","rhtv-asset:last"]},"imageOrder":["rhtv-asset:last"],"promptSelection":{"schemaVersion":"1","referenceBindings":[{"assetId":"style","role":"STYLE"}]}}`)
	if err != nil {
		t.Fatal(err)
	}
	roles := requestRoles(frozenRequest(t, task))
	if roles["last"] != "FIRST_FRAME" || roles["middle"] != "LAST_FRAME" || roles["img"] != "REFERENCE_IMAGE" || roles["style"] != "STYLE" {
		t.Fatalf("first/last incorrectly used the first two or consumed style: %v", roles)
	}
}

type selectedHistoryStore struct {
	*promptTestStore
	read   func(string, HistoryInputQuery) (HistoryInput, error)
	detail func(string, string) (History, error)
}

func (s *selectedHistoryStore) HistoryDetail(_ context.Context, owner, eid string) (History, error) {
	if s.detail == nil {
		return History{}, domain.ErrNotFound
	}
	return s.detail(owner, eid)
}

func (s *selectedHistoryStore) ResolveHistoryInput(_ context.Context, owner string, q HistoryInputQuery) (HistoryInput, error) {
	return s.read(owner, q)
}

func TestCanvasSelectedHistoryUsesAuthoritativeOutputAndWinsOverCurrentRun(t *testing.T) {
	s, store, catalog := promptTestService(t, "IMAGE_TO_IMAGE")
	asset := "img"
	history := &selectedHistoryStore{promptTestStore: store, read: func(owner string, q HistoryInputQuery) (HistoryInput, error) {
		if owner != "owner" || q.ProjectID != "project" || q.NodeID != "source" || q.OutputID != "owned-old-output" {
			t.Fatal("history not scoped to actor/project/source/output", q)
		}
		return HistoryInput{TaskID: "old-task", ExecutionID: "old-execution", Output: domain.Output{ID: q.OutputID, Type: "ASSET", AssetID: &asset}}, nil
	}}
	s.store = history
	page := catalog.pages[""]
	page.Items = append(page.Items, promptCapability("source-model", "TEXT_TO_IMAGE"))
	catalog.pages[""] = page
	graph := json.RawMessage(`{"nodes":[{"id":"source","type":"rh-image","data":{"capabilityRef":"source-model","prompt":"generate new source","selectedHistoryOutputId":"owned-old-output","taskId":"forged-task","status":"finished","output":[{"id":"owned-old-output","assetId":"last"}],"assetIds":["last"],"sourceObjects":["rhtv-asset:last"],"imageUrl":"rhtv-asset:last","nodeOutputHistory":[{"assetId":"last"}]}},{"id":"target","type":"rh-image","data":{"capabilityRef":"mock","prompt":"use chosen history"}}],"edges":[{"source":"source","target":"target"}]}`)
	task, err := s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: "CANVAS", Graph: graph})
	if err != nil || len(task.Plans) != 2 {
		t.Fatal("acceptance failed", err)
	}
	var request gateway.InvocationRequest
	_ = json.Unmarshal(task.Plans[1].Request, &request)
	if !reflect.DeepEqual(requestAssetIDs(request), []string{"img"}) || len(task.Plans[1].InputReferences) != 1 || task.Plans[1].InputReferences[0].HistoryTaskID != "old-task" || task.Plans[1].InputReferences[0].HistoryOutputSHA256 == "" {
		t.Fatal("graph output spoof replaced selected historical authority")
	}
	newAsset := "last"
	task.Plans[0].State = "SUCCEEDED"
	task.Plans[0].Outputs = []domain.Output{{ID: "new-output", Type: "ASSET", AssetID: &newAsset}}
	grants, err := s.bindUpstream(context.Background(), task, 1, &request)
	if err != nil || len(grants) != 0 || !reflect.DeepEqual(requestAssetIDs(request), []string{"img"}) {
		t.Fatal("new upstream output overrode frozen user choice", err)
	}
}

func TestCanvasMissingSelectedHistoryFailsWithoutDisplayFallback(t *testing.T) {
	for _, selector := range []string{`"selectedHistoryOutputId":"missing"`, `"selectedOutputHistoryId":"old-execution","selectedOutputHistoryIndex":1`} {
		s, store, _ := promptTestService(t, "LLM")
		s.store = &selectedHistoryStore{promptTestStore: store, read: func(string, HistoryInputQuery) (HistoryInput, error) { return HistoryInput{}, domain.ErrNotFound }}
		graph := json.RawMessage(`{"nodes":[{"id":"source","type":"rh-image","data":{` + selector + `,"text":"forged stale text","output":[{"assetId":"img"}]}},{"id":"target","type":"rh-text","data":{"capabilityRef":"mock","prompt":"analyze"}}],"edges":[{"source":"source","target":"target"}]}`)
		_, err := s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: "NODE", TargetID: "target", Graph: graph})
		if !errors.Is(err, domain.ErrNotFound) || store.creates != 0 {
			t.Fatal("unavailable history fell back to graph/latest", err)
		}
	}
}

func TestCurrentHistoryProvenanceResolvesFullAuthoritativeBatchWithoutGraphOutputs(t *testing.T) {
	s, store, _ := promptTestService(t, "LLM")
	project, image, other, text := "project", "img", "last", "authoritative generated text"
	s.store = &selectedHistoryStore{promptTestStore: store, detail: func(owner, eid string) (History, error) {
		if owner != "owner" || eid != "current-execution" {
			t.Fatal("current history did not use STUDIO-owned historyStorage locator")
		}
		return History{TaskID: "current-task", ExecutionID: eid, ProjectID: &project, NodeID: "source", Outputs: []domain.Output{{ID: "text-result", Type: "TEXT", Text: &text}, {ID: "json-result", Type: "STRUCTURED", SchemaVersion: "1", Data: json.RawMessage(`{"scene":"authoritative structure"}`)}, {ID: "image-result", Type: "ASSET", AssetID: &image}, {ID: "other-image-result", Type: "ASSET", AssetID: &other}}}, nil
	}}
	graph := json.RawMessage(`{"nodes":[{"id":"source","type":"rh-script","data":{"historyStorage":{"source":"remote","historyId":"current-execution","resultCount":99},"params":{"prompt":"original generation instruction","imageUrls":["rhtv-asset:img"]},"output":[{"text":"forged text"},{"assetId":"forged image"}],"structuredOutput":{"text":"forged structure"}}},{"id":"target","type":"rh-text","data":{"capabilityRef":"mock","prompt":"use current batch"}}],"edges":[{"source":"source","target":"target"}]}`)
	task, err := s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: "NODE", TargetID: "target", Graph: graph})
	if err != nil {
		t.Fatal(err)
	}
	request := frozenRequest(t, task)
	input, _ := json.Marshal(request.Input)
	if len(task.Plans[0].InputReferences) != 4 || !reflect.DeepEqual(requestAssetIDs(request), []string{"img", "last"}) || !strings.Contains(string(input), text) || !strings.Contains(string(input), "authoritative structure") || strings.Contains(string(input), "forged") || strings.Contains(string(input), "original generation instruction") {
		t.Fatal("default current provenance guessed index0, trusted display data, or dropped a real output", string(input))
	}
}

func TestCurrentHistoryProvenancePreservesEditedTextAndReplacedMedia(t *testing.T) {
	for _, test := range []struct {
		name, kind, data, text string
		assets                 []string
	}{
		{"edited text", "rh-text", `"text":"edited current text","content":"old generated text","params":{"prompt":"old generation prompt","imageUrls":["rhtv-asset:img"]}`, "edited current text", nil},
		{"cleared text", "rh-text", `"text":"","params":{"prompt":"old generation prompt"}`, "", nil},
		{"replaced image", "rh-image", `"imageUrl":"rhtv-asset:last","params":{"imageUrls":["rhtv-asset:img"]}`, "", []string{"last"}},
		{"replaced video", "rh-video", `"videoUrl":"rhtv-asset:video","params":{"imageUrls":["rhtv-asset:img"]}`, "", []string{"video"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, store, _ := promptTestService(t, "LLM")
			s.store = &selectedHistoryStore{promptTestStore: store, detail: func(string, string) (History, error) {
				if test.kind == "rh-text" {
					t.Fatal("edited current text unexpectedly resurrected history")
				}
				return History{}, domain.ErrNotFound
			}}
			graph := json.RawMessage(`{"nodes":[{"id":"source","type":"` + test.kind + `","data":{"historyStorage":{"source":"remote","historyId":"old-execution"},"output":[{"text":"stale output"}],` + test.data + `}},{"id":"target","type":"rh-text","data":{"capabilityRef":"mock","prompt":"target request"}}],"edges":[{"source":"source","target":"target"}]}`)
			task, err := s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: "NODE", TargetID: "target", Graph: graph})
			if err != nil {
				t.Fatal(err)
			}
			request := frozenRequest(t, task)
			ids := requestAssetIDs(request)
			if len(ids) != len(test.assets) || len(ids) > 0 && !reflect.DeepEqual(ids, test.assets) {
				t.Fatal("retained generation refs entered edited current media", ids)
			}
			body, _ := json.Marshal(request.Input)
			if strings.Contains(string(body), "old generated text") || strings.Contains(string(body), "old generation prompt") || strings.Contains(string(body), "stale output") || test.text != "" && !strings.Contains(string(body), test.text) {
				t.Fatal("edited or empty text was replaced by stale history/config", string(body))
			}
		})
	}
}

func TestDefaultCurrentHistoryDoesNotOverrideNewPlannedUpstreamOutput(t *testing.T) {
	s, store, _ := promptTestService(t, "LLM")
	s.store = &selectedHistoryStore{promptTestStore: store, detail: func(string, string) (History, error) {
		t.Fatal("planned source loaded old current history")
		return History{}, domain.ErrNotFound
	}}
	graph := json.RawMessage(`{"nodes":[{"id":"source","type":"rh-text","data":{"capabilityRef":"mock","prompt":"make fresh text","historyStorage":{"historyId":"old-execution"}}},{"id":"target","type":"rh-text","data":{"capabilityRef":"mock","prompt":"use fresh text"}}],"edges":[{"source":"source","target":"target"}]}`)
	task, err := s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: "CANVAS", Graph: graph})
	if err != nil || len(task.Plans) != 2 {
		t.Fatal("planned current source was rejected", err)
	}
	text := "fresh current-run result"
	task.Plans[0].State = "SUCCEEDED"
	task.Plans[0].Outputs = []domain.Output{{ID: "fresh", Type: "TEXT", Text: &text}}
	var request gateway.InvocationRequest
	_ = json.Unmarshal(task.Plans[1].Request, &request)
	if _, err = s.bindUpstream(context.Background(), task, 1, &request); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(request.Input)
	if !strings.Contains(string(body), text) || strings.Contains(string(body), "old-execution") {
		t.Fatal("old default current history replaced newly executed upstream", string(body))
	}
}

func TestDefaultCurrentBatchKeepsAllAutomaticAudioAndVideoResults(t *testing.T) {
	for _, modality := range []string{"AUDIO", "VIDEO"} {
		t.Run(modality, func(t *testing.T) {
			s, store, _ := promptTestService(t, "LLM")
			project, first, second, replacement := "project", "first-result", "second-result", "replacement"
			for _, id := range []string{first, second, replacement} {
				store.assets[id] = Asset{ID: id, Kind: modality, Version: "sha256:" + id}
			}
			s.store = &selectedHistoryStore{promptTestStore: store, detail: func(string, string) (History, error) {
				return History{TaskID: "current-task", ExecutionID: "current-execution", ProjectID: &project, NodeID: "source", Outputs: []domain.Output{{ID: "first-output", Type: "ARTIFACT", AssetID: &first}, {ID: "second-output", Type: "ASSET", AssetID: &second}}}, nil
			}}
			for _, displayed := range []string{first, replacement} {
				graph := json.RawMessage(`{"nodes":[{"id":"source","type":"rh-` + strings.ToLower(modality) + `","data":{"historyStorage":{"historyId":"current-execution"},"` + strings.ToLower(modality) + `Url":"rhtv-asset:` + displayed + `","output":[{"assetId":"forged"}]}},{"id":"target","type":"rh-text","data":{"capabilityRef":"mock","prompt":"use current media"}}],"edges":[{"source":"source","target":"target"}]}`)
				task, err := s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: "NODE", TargetID: "target", Graph: graph})
				if err != nil {
					t.Fatal(err)
				}
				want := []string{first, second}
				if displayed == replacement {
					want = []string{replacement}
				}
				if ids := requestAssetIDs(frozenRequest(t, task)); !reflect.DeepEqual(ids, want) {
					t.Fatal("automatic firstURL filtered batch or hand replacement resurrected it", ids)
				}
			}
		})
	}
}

func TestDynamicUnorderedUpstreamUsesSameCollectionOrderAsReadableSource(t *testing.T) {
	s, _, _ := promptTestService(t, "IMAGE_TO_VIDEO")
	graph := json.RawMessage(`{"nodes":[{"id":"source","type":"rh-image","data":{"imageUrl":"rhtv-asset:img"}},{"id":"target","type":"rh-video","data":{"capabilityRef":"mock","subType":"START_END_VIDEO","params":{"imageUrls":["rhtv-asset:last"]}}}],"edges":[{"source":"source","target":"target"}]}`)
	static, err := s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: "NODE", TargetID: "target", Graph: graph})
	if err != nil {
		t.Fatal(err)
	}
	template, _ := defaultTemplate("IMAGE_TO_VIDEO")
	ref, image := "existing", "img"
	request := gateway.InvocationRequest{PromptSpec: template.spec(), Input: []gateway.InputPart{}, Attachments: []gateway.Attachment{{Ref: ref, SourceRef: "last", Kind: "IMAGE"}}}
	appendUserInput(&request, gateway.InputPart{Type: "MEDIA", AttachmentRef: &ref})
	dynamic := domain.Task{OwnerID: "owner", Kind: "CANVAS", Snapshot: graph, Plans: []domain.Plan{{NodeID: "source", State: "SUCCEEDED", Outputs: []domain.Output{{ID: "upstream", Type: "ASSET", AssetID: &image}}}, {NodeID: "target", InputReferences: []domain.InputReference{{SourceNodeID: "target", AssetID: "last", Modality: "IMAGE", Keys: mediaKeys("target", "last", "")}}}}}
	if _, err := s.bindUpstream(context.Background(), dynamic, 1, &request); err != nil {
		t.Fatal(err)
	}
	staticRequest := frozenRequest(t, static)
	if !reflect.DeepEqual(requestAssetIDs(request), requestAssetIDs(staticRequest)) || !reflect.DeepEqual(requestMediaIDs(request), requestMediaIDs(staticRequest)) || !reflect.DeepEqual(requestRoles(request), requestRoles(staticRequest)) || requestRoles(request)["img"] != "FIRST_FRAME" || requestRoles(request)["last"] != "LAST_FRAME" {
		t.Fatal("dynamic append reversed unordered first/last relative to readable source", requestAssetIDs(request), requestRoles(request))
	}
}

type wireArrayGateway struct{ *receiptModeGateway }

func (g wireArrayGateway) Submit(ctx context.Context, actor gateway.Actor, submission gateway.Submission) (gateway.Invocation, error) {
	// The real Router schema requires arrays even when there are no media
	// conditions. A permissive in-memory gateway previously missed JSON null.
	if submission.Request.PromptSpec == nil || submission.Request.PromptSpec.Conditioning == nil || submission.Request.Attachments == nil {
		return gateway.Invocation{}, &gateway.Fault{Code: "INVALID_REQUEST"}
	}
	return g.receiptModeGateway.Submit(ctx, actor, submission)
}

func TestWorkerBindingWithoutMediaRetainsRequiredRouterWireArrays(t *testing.T) {
	s, store, catalog := promptTestService(t, "LLM")
	g := &receiptModeGateway{promptTestGateway: catalog, submitTestMode: true, readTestMode: true}
	s.gateway = wireArrayGateway{g}
	task, err := promptCanvas(t, s, `{"prompt":"preserve empty wire arrays"}`)
	if err != nil {
		t.Fatal(err)
	}
	s.execute(context.Background(), task, "lease")
	if store.task.State != "SUCCEEDED" || g.submits != 1 {
		t.Fatal("no-media task stopped satisfying Router wire schema", store.task.State)
	}
	var request map[string]any
	_ = json.Unmarshal(store.task.Plans[0].Request, &request)
	if _, ok := request["promptSpec"].(map[string]any)["conditioning"].([]any); !ok {
		t.Fatal("persisted bound request serialized required conditioning as null")
	}
}

func TestHistorySelectorRetainsExecutionDisambiguationWithoutChangingOutput(t *testing.T) {
	var node domain.Node
	_ = json.Unmarshal([]byte(`{"id":"source","data":{"selectedHistoryOutputId":"vendor-output","selectedOutputHistoryId":"exact-execution","selectedOutputHistoryIndex":9}}`), &node)
	query, chosen, err := historySelection(node, "project")
	if err != nil || !chosen || query.OutputID != "vendor-output" || query.ExecutionID != "exact-execution" || query.OutputIndex != nil {
		t.Fatal("output identity lost execution disambiguation or changed to index", query, err)
	}
}

func TestHistoryOutputFingerprintSurvivesJSONBFormattingWithoutRoundingNumbers(t *testing.T) {
	one := domain.Output{ID: "structured", Type: "STRUCTURED", SchemaVersion: "1", Data: json.RawMessage(`{"z":1e3,"a":9007199254740993}`)}
	two := one
	two.Data = json.RawMessage(`{ "a": 9007199254740993, "z": 1000.0 }`)
	if HistoryOutputSHA256(one) != HistoryOutputSHA256(two) {
		t.Fatal("JSONB normalized object/numeric formatting invalidated the same exact output")
	}
	for _, data := range []string{`{"a":9007199254740992,"z":1000}`, `{"a":"9007199254740993","z":1000}`} {
		two.Data = json.RawMessage(data)
		if HistoryOutputSHA256(one) == HistoryOutputSHA256(two) {
			t.Fatal("content fingerprint rounded a large number or lost its type")
		}
	}
}

func TestDynamicUpstreamAndEmbeddedReferencesSortTogetherBeforeFrameAssignment(t *testing.T) {
	s, store, _ := promptTestService(t, "IMAGE_TO_VIDEO")
	store.assets["middle"] = Asset{ID: "middle", Kind: "IMAGE", MimeType: "image/png", ByteSize: 2048, Version: "sha256:middle"}
	first, middle := "img", "middle"
	graph := json.RawMessage(`{"nodes":[{"id":"first","type":"rh-image"},{"id":"middle","type":"rh-image"},{"id":"target","type":"rh-video","data":{"subType":"START_END_VIDEO","imageOrder":["middle","first"],"params":{"imageUrls":["rhtv-asset:last"]}}}],"edges":[{"source":"first","target":"target"},{"source":"middle","target":"target"}]}`)
	template, _ := defaultTemplate("IMAGE_TO_VIDEO")
	ref := "existing"
	request := gateway.InvocationRequest{PromptSpec: template.spec(), Input: []gateway.InputPart{}, Attachments: []gateway.Attachment{{Ref: ref, SourceRef: "last", Kind: "IMAGE"}}}
	appendUserInput(&request, gateway.InputPart{Type: "MEDIA", AttachmentRef: &ref})
	task := domain.Task{OwnerID: "owner", Kind: "CANVAS", Snapshot: graph, Plans: []domain.Plan{{NodeID: "first", State: "SUCCEEDED", Outputs: []domain.Output{{ID: "o1", Type: "ASSET", AssetID: &first}}}, {NodeID: "middle", State: "SUCCEEDED", Outputs: []domain.Output{{ID: "o2", Type: "ASSET", AssetID: &middle}}}, {NodeID: "target", InputReferences: []domain.InputReference{{SourceNodeID: "target", AssetID: "last", Modality: "IMAGE", Keys: mediaKeys("target", "last", "")}}}}}
	grants, err := s.bindUpstream(context.Background(), task, 2, &request)
	if err != nil || len(grants) != 2 || !reflect.DeepEqual(requestAssetIDs(request), []string{"middle", "img", "last"}) || !reflect.DeepEqual(requestMediaIDs(request), []string{"middle", "img", "last"}) {
		t.Fatal("dynamic inputs lost media ordering", requestAssetIDs(request), requestMediaIDs(request), err)
	}
	roles := requestRoles(request)
	if roles["middle"] != "FIRST_FRAME" || roles["last"] != "LAST_FRAME" || roles["img"] != "REFERENCE_IMAGE" || len(task.Plans[2].InputReferences) != 3 {
		t.Fatal("dynamic first/final or private manifest wrong", roles)
	}
	if err := validatePromptInputs(request, promptCapability("mock", "IMAGE_TO_VIDEO"), promptTemplate{}); err != nil {
		t.Fatal("media sort corrupted prompt message indexes", err)
	}
}

func TestVisionReconnectOrdersImagesAsWiredBothAtAcceptanceAndDispatch(t *testing.T) {
	s, _, _ := promptTestService(t, "IMAGE_UNDERSTANDING")
	graph := json.RawMessage(`{"nodes":[{"id":"a","type":"rh-image","data":{"sourceObjects":["rhtv-asset:img"]}},{"id":"b","type":"rh-image","data":{"sourceObjects":["rhtv-asset:last"]}},{"id":"target","type":"rh-text","data":{"capabilityRef":"mock","prompt":"Compare first and second."}}],"edges":[{"source":"b","target":"target"},{"source":"a","target":"target"}]}`)
	task, err := s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: "NODE", TargetID: "target", Graph: graph})
	if err != nil {
		t.Fatal(err)
	}
	req := frozenRequest(t, task)
	want := []string{"last", "img"}
	if got := requestMediaIDs(req); !reflect.DeepEqual(got, want) {
		t.Fatal("acceptance", got, want)
	}
	if _, err := s.bindUpstream(context.Background(), task, 0, &req); err != nil {
		t.Fatal(err)
	}
	if got := requestMediaIDs(req); !reflect.DeepEqual(got, want) {
		t.Fatal("dispatch", got, want)
	}
}
