package application

import (
	"context"
	"encoding/json"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"reflect"
	"strings"
	"testing"
)

func h3FrontierFixture(t *testing.T, ref, version string) (*Service, domain.Graph) {
	s, store, catalog := promptTestService(t, "IMAGE_TO_VIDEO")
	cap := promptCapability(ref, "IMAGE_TO_VIDEO")
	cap.Version = version
	catalog.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
	store.assets["audio"] = Asset{ID: "audio", Kind: "AUDIO", Version: "sha256:d", SHA256: strings.Repeat("d", 64)}
	var graph domain.Graph
	if err := json.Unmarshal([]byte(`{"nodes":[
 {"id":"text","type":"rh-text","data":{"text":"keep text condition"}},
 {"id":"A","type":"rh-image","data":{"sourceObjects":["rhtv-asset:img"]}},
 {"id":"B","type":"rh-image","data":{"sourceObjects":["rhtv-asset:last"],"params":{"imageUrls":["rhtv-asset:img"]}}},
 {"id":"C","type":"rh-video","data":{"prompt":"animate current image","subType":"image-video","params":{"imageUrls":["rhtv-asset:last"]}}}
 ],"edges":[{"source":"text","target":"A"},{"source":"A","target":"B"},{"source":"B","target":"C"}]}`), &graph); err != nil {
		t.Fatal(err)
	}
	mutateImageFrontierNode(t, &graph, "C", func(d map[string]any) { d["capabilityRef"] = ref; d["capabilityVersion"] = version })
	return s, graph
}

func TestH3FrontierChainUsesOnlyCurrentDirectMedia(t *testing.T) {
	for _, ref := range []string{"h3-first-frame-v1", "h3-first-last-frame-v1", "h3-reference-v1", "h3-video-reference-v1"} {
		for _, version := range []string{"1", "2"} {
			t.Run(ref+"/"+version, func(t *testing.T) {
				s, graph := h3FrontierFixture(t, ref, version)
				task, err := createImageFrontierTask(t, s, graph)
				if err != nil {
					t.Fatal(err)
				}
				request := frozenRequest(t, task)
				if got := requestAssetIDs(request); !reflect.DeepEqual(got, []string{"last"}) {
					t.Fatal("historical image leaked", got)
				}
				var snapshot domain.Graph
				_ = json.Unmarshal(task.Snapshot, &snapshot)
				if len(snapshot.Nodes) != 4 || len(snapshot.Edges) != 3 {
					t.Fatal("lineage removed")
				}
				found := false
				for _, part := range request.Input {
					found = found || part.Text != nil && *part.Text == "keep text condition"
				}
				if !found {
					t.Fatal("text condition lost")
				}
			})
		}
	}
}

func TestH3FrontierExplicitDirectReferencesAndOrderingSurvive(t *testing.T) {
	for _, ref := range []string{"h3-first-last-frame-v1", "h3-video-reference-v1"} {
		t.Run(ref, func(t *testing.T) {
			s, graph := h3FrontierFixture(t, ref, "2")
			// Explicitly wire A as well: it must now be retained even though it is B's ancestor.
			graph.Edges = append(graph.Edges, domain.Edge{Source: "A", Target: "C"})
			mutateImageFrontierNode(t, &graph, "C", func(d map[string]any) {
				d["imageOrder"] = []string{"B", "A"}
				if ref == "h3-first-last-frame-v1" {
					d["subType"] = "START_END_VIDEO"
				}
			})
			want := []string{"last", "img"}
			if ref == "h3-video-reference-v1" {
				graph.Nodes = append(graph.Nodes, json.RawMessage(`{"id":"V","type":"rh-video","data":{"sourceObjects":["rhtv-asset:video"],"params":{"imageUrls":["rhtv-asset:img"]}}}`), json.RawMessage(`{"id":"S","type":"rh-audio","data":{"sourceObjects":["rhtv-asset:audio"]}}`))
				graph.Edges = append(graph.Edges, domain.Edge{Source: "V", Target: "C"}, domain.Edge{Source: "S", Target: "C"})
				want = append(want, "video", "audio")
			}
			task, err := createImageFrontierTask(t, s, graph)
			if err != nil {
				t.Fatal(err)
			}
			if got := requestAssetIDs(frozenRequest(t, task)); !reflect.DeepEqual(got, want) {
				t.Fatal("explicit media lost/reordered", got, want)
			}
		})
	}
}

func TestH3FrontierWorkerDoesNotReintroduceAncestor(t *testing.T) {
	s, graph := h3FrontierFixture(t, "h3-first-frame-v1", "2")
	task, err := createImageFrontierTask(t, s, graph)
	if err != nil {
		t.Fatal(err)
	}
	request := frozenRequest(t, task)
	request.Attachments = nil
	request.Input = nil
	request.PromptSpec.Messages = nil
	old, current := "img", "last"
	task.Plans = []domain.Plan{
		{NodeID: "A", State: "SUCCEEDED", Outputs: []domain.Output{{ID: "old", Type: "ASSET", AssetID: &old}}},
		{NodeID: "B", State: "SUCCEEDED", Outputs: []domain.Output{{ID: "current", Type: "ASSET", AssetID: &current}}},
		{NodeID: "C"},
	}
	_, err = s.bindUpstream(context.Background(), task, 2, &request)
	if err != nil {
		t.Fatal(err)
	}
	if got := requestAssetIDs(request); !reflect.DeepEqual(got, []string{"last"}) {
		t.Fatal("worker historical image leaked", got)
	}
}

func TestNewAdvertisedH3ProfilesUseTrustedMetadataAndFreezeTheirFrontier(t *testing.T) {
	for _, ref := range []string{"h3-drama-reference-v1", "h3-action-reference-v1", "future-reference-profile"} {
		t.Run(ref, func(t *testing.T) {
			s, graph := h3FrontierFixture(t, ref, "1")
			catalog := s.gateway.(*promptTestGateway)
			cap := catalog.pages[""].Items[0]
			cap.Kind = "OMNI_REFERENCE"
			cap.Model = &gateway.ModelDescriptor{ModelRef: "h3"}
			cap.ParameterSchema = json.RawMessage(`{"type":"object","additionalProperties":false,"x-video-mode":"OMNI_REFERENCE"}`)
			catalog.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
			mutateImageFrontierNode(t, &graph, "C", func(data map[string]any) { data["subType"] = "multimodal-video"; data["videoUrl"] = "rhtv-asset:video" })
			task, err := createImageFrontierTask(t, s, graph)
			if err != nil {
				t.Fatal(err)
			}
			if !task.Plans[0].MediaInputFrontier || !reflect.DeepEqual(requestAssetIDs(frozenRequest(t, task)), []string{"last"}) {
				t.Fatal("new profile inherited generation history")
			}
			if h3Capability(gateway.Capability{Model: &gateway.ModelDescriptor{ModelRef: "unrelated"}, Kind: cap.Kind, ParameterSchema: cap.ParameterSchema}) {
				t.Fatal("unrelated model misidentified")
			}
		})
	}
}

func TestAdvertisedComfyImageModelsUseCurrentDirectSource(t *testing.T) {
	for _, kind := range []string{"IMAGE_TO_IMAGE", "IMAGE_ENHANCE"} {
		t.Run(kind, func(t *testing.T) {
			s, graph := h3FrontierFixture(t, "configured-comfy-image", "1")
			catalog := s.gateway.(*promptTestGateway)
			cap := catalog.pages[""].Items[0]
			cap.Kind = kind
			cap.Model = &gateway.ModelDescriptor{ModelRef: "qwen-image-edit-2511"}
			cap.OutputKinds = []string{"IMAGE"}
			catalog.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
			var target map[string]any
			_ = json.Unmarshal(graph.Nodes[3], &target)
			target["type"] = "rh-image"
			data := target["data"].(map[string]any)
			data["subType"] = kind
			data["imageUrl"] = "rhtv-asset:img"
			graph.Nodes[3], _ = json.Marshal(target)
			task, err := createImageFrontierTask(t, s, graph)
			if err != nil {
				t.Fatal(err)
			}
			if !task.Plans[0].MediaInputFrontier || !reflect.DeepEqual(requestAssetIDs(frozenRequest(t, task)), []string{"last"}) {
				t.Fatal("new image profile inherited old references")
			}
		})
	}
}

func TestH3RegenerationKeepsOldOutputOutOfInputsAndInSnapshot(t *testing.T) {
	s, graph := h3FrontierFixture(t, "h3-first-frame-v1", "2")
	mutateImageFrontierNode(t, &graph, "C", func(d map[string]any) {
		d["videoUrl"] = "rhtv-asset:video"
		d["sourceObjects"] = []string{"rhtv-asset:video"}
		d["assetIds"] = []string{"video"}
		d["historyStorage"] = map[string]any{"historyId": "previous-video"}
		d["output"] = []any{map[string]any{"assetId": "video"}}
	})
	task, err := createImageFrontierTask(t, s, graph)
	if err != nil {
		t.Fatal(err)
	}
	if got := requestAssetIDs(frozenRequest(t, task)); !reflect.DeepEqual(got, []string{"last"}) {
		t.Fatal("previous output became reference", got)
	}
	if !strings.Contains(string(task.Snapshot), "previous-video") || !strings.Contains(string(task.Snapshot), "rhtv-asset:video") {
		t.Fatal("previous result/history deleted")
	}
	// Deliberately supplied video references are retained, not silently filtered.
	mutateImageFrontierNode(t, &graph, "C", func(d map[string]any) {
		d["capabilityRef"] = "h3-video-reference-v1"
		d["params"] = map[string]any{"imageUrls": []string{"rhtv-asset:last"}, "videoUrls": []string{"rhtv-asset:video"}}
	})
	target := domain.Node{}
	_ = json.Unmarshal(graph.Nodes[3], &target)
	refs, err := mediaReferences(canvasGenerationInputData(target), target.ID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range refs {
		found = found || r.AssetID == "video"
	}
	if !found {
		t.Fatal("explicit video input lost")
	}
}

func TestReconnectingChangesFirstLastFrameUntilExplicitOrderOverridesIt(t *testing.T) {
	for _, row := range []struct {
		name  string
		order any
		refs  []string
	}{
		{"reconnected-after-B", nil, []string{"last", "img"}},
		{"ranked A first", []any{map[string]string{"nodeId": "A", "url": "rhtv-asset:img"}, map[string]string{"nodeId": "B", "fileUrl": "rhtv-asset:last"}}, []string{"img", "last"}},
		{"compound key for B", []any{map[string]string{"_key": "B::rhtv-asset:last"}}, []string{"last", "img"}},
	} {
		t.Run(row.name, func(t *testing.T) {
			s, graph := h3FrontierFixture(t, "h3-first-last-frame-v1", "2")
			graph.Edges = append(graph.Edges, domain.Edge{Source: "A", Target: "C"})
			mutateImageFrontierNode(t, &graph, "C", func(d map[string]any) {
				d["subType"] = "START_END_VIDEO"
				if row.order != nil {
					d["imageOrder"] = row.order
				}
			})
			task, err := createImageFrontierTask(t, s, graph)
			if err != nil {
				t.Fatal(err)
			}
			req := frozenRequest(t, task)
			if ids := requestMediaIDs(req); !reflect.DeepEqual(ids, row.refs) {
				t.Fatalf("media = %v, wanted %v", ids, row.refs)
			}
			if roles := requestRoles(req); roles[row.refs[0]] != "FIRST_FRAME" || roles[row.refs[1]] != "LAST_FRAME" {
				t.Fatalf("wrong endpoint roles: %v", roles)
			}
			if _, err := s.bindUpstream(context.Background(), task, 0, &req); err != nil {
				t.Fatal(err)
			}
			if ids := requestMediaIDs(req); !reflect.DeepEqual(ids, row.refs) {
				t.Fatalf("worker changed frame order: %v", ids)
			}
		})
	}
}

func TestVideoReferenceConsumesDisplayedOutputFromAuthorizedImageBatch(t *testing.T) {
	s, graph := h3FrontierFixture(t, "h3-first-frame-v1", "2")
	project, first, second := "project", "last", "img"
	s.store = &selectedHistoryStore{promptTestStore: s.store.(*promptTestStore), detail: func(owner, id string) (History, error) {
		return History{TaskID: "prev", ExecutionID: id, ProjectID: &project, NodeID: "B", Outputs: []domain.Output{{ID: "first", Type: "ASSET", AssetID: &first}, {ID: "second", Type: "ASSET", AssetID: &second}}}, nil
	}}
	mutateImageFrontierNode(t, &graph, "B", func(d map[string]any) {
		d["historyStorage"] = map[string]any{"historyId": "history-B"}
		d["output"] = []any{map[string]any{"url": "rhtv-asset:last"}, map[string]any{"url": "rhtv-asset:img"}}
	})
	task, err := createImageFrontierTask(t, s, graph)
	if err != nil {
		t.Fatal(err)
	}
	if refs := requestAssetIDs(frozenRequest(t, task)); !reflect.DeepEqual(refs, []string{"last"}) {
		t.Fatalf("unselected historical output leaked: %v", refs)
	}
	mutateImageFrontierNode(t, &graph, "B", func(d map[string]any) { d["output"] = []any{map[string]any{"url": "rhtv-asset:unrelated"}} })
	if _, err := createImageFrontierTask(t, s, graph); err == nil {
		t.Fatal("missing displayed history silently replaced or accepted")
	}
}

func TestNativeVideoTextFollowsCurrentDirectWireOrderThenInline(t *testing.T) {
	s, graph := h3FrontierFixture(t, "h3-first-frame-v1", "2")
	graph.Nodes = append(graph.Nodes, json.RawMessage(`{"id":"newtext","type":"rh-text","data":{"text":"first connected"}}`), json.RawMessage(`{"id":"second","type":"rh-text","data":{"text":"second connected"}}`))
	// Node display order and edge order deliberately disagree.
	graph.Edges = []domain.Edge{{Source: "B", Target: "C"}, {Source: "second", Target: "C"}, {Source: "newtext", Target: "C"}}
	mutateImageFrontierNode(t, &graph, "C", func(d map[string]any) {
		d["mentionAssets"] = []any{map[string]string{"type": "TEXT", "text": "  final note "}}
	})
	task, err := createImageFrontierTask(t, s, graph)
	if err != nil {
		t.Fatal(err)
	}
	texts := []string{}
	for _, p := range frozenRequest(t, task).Input {
		if p.Text != nil {
			texts = append(texts, *p.Text)
		}
	}
	if !reflect.DeepEqual(texts, []string{"animate current image", "second connected", "first connected", "final note"}) {
		t.Fatal("unexpected prompt order", texts)
	}
}
