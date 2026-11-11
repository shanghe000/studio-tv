package application

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

func imageFrontierFixture(t *testing.T, tool string, pose bool) (*Service, *promptTestStore, domain.Graph) {
	t.Helper()
	s, store, catalog := promptTestService(t, "IMAGE_TO_IMAGE")
	cap := realImageCapability("IMAGE_TO_IMAGE")
	cap.Version, cap.ParameterSchemaVersion = "3", "3"
	cap.ParameterSchema = json.RawMessage(`{"type":"object","properties":{"count":{"type":"integer","enum":[1,2,4]},"transparentBackground":{"type":"boolean"}},"additionalProperties":false}`)
	catalog.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
	s.WithRealExecution(true)
	store.assets["guide"] = Asset{ID: "guide", Kind: "IMAGE", MimeType: "image/png", ByteSize: 2048, Version: "sha256:d", SHA256: strings.Repeat("d", 64)}
	node := func(id, kind string, data map[string]any) json.RawMessage {
		body, err := json.Marshal(map[string]any{"id": id, "type": kind, "data": data})
		if err != nil {
			t.Fatal(err)
		}
		return body
	}
	data := map[string]any{"capabilityRef": cap.Ref, "capabilityVersion": "3", "toolsType": tool, "subType": "IMAGE_IMAGE", "sourceNodeId": "B", "toolsSourceUrl": "rhtv-asset:last", "params": map[string]any{"prompt": "preserve this user's intent", "imageUrls": []string{"rhtv-asset:last"}}, "routerParameters": map[string]any{"count": 1, "transparentBackground": tool == "IMAGE_CUTOUT"}}
	if tool == "IMAGE_REDRAW" || tool == "IMAGE_ERASE" || tool == "IMAGE_EXPAND" {
		data["toolsSourceUrl"] = "rhtv-asset:guide"
		data["params"] = map[string]any{"prompt": "preserve this user's intent", "imageUrls": []string{"rhtv-asset:guide"}}
	}
	graph := domain.Graph{Nodes: []json.RawMessage{
		node("text", "rh-text", map[string]any{"text": "keep the upstream text condition"}),
		node("A", "rh-image", map[string]any{"isUpload": true, "sourceObjects": []string{"rhtv-asset:img"}, "assetIds": []string{"img"}}),
		node("B", "rh-image", map[string]any{"sourceObjects": []string{"rhtv-asset:last"}, "historyStorage": map[string]any{"historyId": "previous-execution"}, "params": map[string]any{"imageUrls": []string{"rhtv-asset:img"}}}),
		node("C", "rh-image", data),
	}, Edges: []domain.Edge{{Source: "text", Target: "A"}, {Source: "A", Target: "B"}, {Source: "B", Target: "C"}}}
	if pose {
		// The native portrait result omits sourceNodeId, but keeps the original
		// image URL and two actual input edges (original plus uploaded pose).
		delete(data, "sourceNodeId")
		data["isPortraitAdjustResult"] = true
		data["presetSelections"] = []any{map[string]any{"key": "poseBase", "id": "studio-portrait-952-v1", "promptCode": "studio-portrait-952-v1"}}
		data["params"] = map[string]any{"prompt": "preserve this user's intent", "imageUrls": []string{"rhtv-asset:last", "rhtv-asset:guide"}}
		graph.Nodes[3] = node("C", "rh-image", data)
		graph.Nodes = append(graph.Nodes, node("pose", "rh-image", map[string]any{"isUpload": true, "sourceObjects": []string{"rhtv-asset:guide"}}))
		graph.Edges = append(graph.Edges, domain.Edge{Source: "pose", Target: "C"})
	}
	project, current := "project", "last"
	s.store = &selectedHistoryStore{promptTestStore: store, detail: func(owner, eid string) (History, error) {
		if owner != "owner" || eid != "previous-execution" {
			t.Fatal("history ownership/execution not checked", owner, eid)
		}
		return History{ProjectID: &project, NodeID: "B", TaskID: "previous-task", ExecutionID: eid, Outputs: []domain.Output{{ID: "previous-output", Type: "ASSET", AssetID: &current}}}, nil
	}}
	return s, store, graph
}

func createImageFrontierTask(t *testing.T, s *Service, graph domain.Graph) (domain.Task, error) {
	t.Helper()
	body, _ := json.Marshal(graph)
	return s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: "NODE", TargetID: "C", Graph: body})
}

func mutateImageFrontierNode(t *testing.T, graph *domain.Graph, id string, change func(map[string]any)) {
	t.Helper()
	for i, raw := range graph.Nodes {
		var node map[string]any
		_ = json.Unmarshal(raw, &node)
		if node["id"] == id {
			change(node["data"].(map[string]any))
			graph.Nodes[i], _ = json.Marshal(node)
			return
		}
	}
	t.Fatal("missing fixture node", id)
}

func TestNativeImageFrontierCanvasChainUsesCurrentOwnedOutputAndPreservesAncestors(t *testing.T) {
	for _, tool := range []string{"IMAGE_REDRAW", "IMAGE_ERASE", "IMAGE_EXPAND", "IMAGE_CUTOUT", "IMAGE_CUTOUT_TEXT", "IMAGE_ENHANCE", "IMAGE_MULTIANGLE", "IMAGE_LIGHT", "portrait-pose", "quick-scene", "panorama"} {
		t.Run(tool, func(t *testing.T) {
			nativeTool := tool
			if tool == "portrait-pose" || tool == "quick-scene" || tool == "panorama" {
				nativeTool = "IMAGE_IMAGE"
			}
			s, _, graph := imageFrontierFixture(t, nativeTool, tool == "portrait-pose")
			if tool == "quick-scene" || tool == "panorama" {
				mutateImageFrontierNode(t, &graph, "C", func(data map[string]any) {
					data["sceneCode"] = "canvas-image-quick-create-cinematic-lighting-rembrandt"
					if tool == "panorama" {
						data["sceneCode"] = "canvas-image-panorama-image"
						data["panorama"] = map[string]any{"isPanoramaNode": true}
					}
				})
			}
			task, err := createImageFrontierTask(t, s, graph)
			if err != nil {
				t.Fatal(err)
			}
			request := frozenRequest(t, task)
			want := []string{"last"}
			guideRole := ""
			if nativeTool == "IMAGE_REDRAW" || nativeTool == "IMAGE_ERASE" || nativeTool == "IMAGE_EXPAND" || tool == "portrait-pose" {
				want = append(want, "guide")
				guideRole = "MASK"
				if tool == "portrait-pose" {
					guideRole = "POSE"
				}
			}
			if !reflect.DeepEqual(requestAssetIDs(request), want) || !reflect.DeepEqual(requestMediaIDs(request), want) {
				t.Fatalf("ancestor generation pixels leaked into model input: %v / %v", requestAssetIDs(request), requestMediaIDs(request))
			}
			originalRef := request.Attachments[0].Ref
			if guideRole != "" {
				found := false
				for _, binding := range request.PromptSpec.Conditioning {
					if binding.Role == guideRole {
						found = binding.AttachmentRef == request.Attachments[1].Ref && binding.TargetAttachmentRef != nil && *binding.TargetAttachmentRef == originalRef
					}
				}
				if !found {
					t.Fatal("guide was not bound to current B output", request.PromptSpec.Conditioning)
				}
			}
			upstreamText, userPrompt, historyProof := false, false, false
			for _, part := range request.Input {
				if part.Text != nil {
					upstreamText = upstreamText || *part.Text == "keep the upstream text condition"
					userPrompt = userPrompt || *part.Text == "preserve this user's intent"
				}
			}
			for _, ref := range task.Plans[0].InputReferences {
				if ref.SourceNodeID == "A" || ref.AssetID == "img" {
					t.Fatal("old ancestor input retained in private binding", ref)
				}
				historyProof = historyProof || ref.SourceNodeID == "B" && ref.HistoryTaskID == "previous-task" && ref.HistoryOutputSHA256 != ""
			}
			body, _ := json.Marshal(graph)
			if !upstreamText || !userPrompt || !historyProof || string(task.Snapshot) != string(body) {
				t.Fatal("text, authoritative output proof or full CAS snapshot changed")
			}
		})
	}
}

func TestNativeImageFrontierRejectsAmbiguousAndTamperedSources(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*testing.T, *domain.Graph)
	}{
		{"extra-direct-source", func(t *testing.T, graph *domain.Graph) {
			graph.Edges = append(graph.Edges, domain.Edge{Source: "A", Target: "C"})
		}},
		{"ancestor-source-id", func(t *testing.T, graph *domain.Graph) {
			mutateImageFrontierNode(t, graph, "C", func(data map[string]any) { data["sourceNodeId"] = "A" })
		}},
		{"source-id-alias-conflict", func(t *testing.T, graph *domain.Graph) {
			mutateImageFrontierNode(t, graph, "C", func(data map[string]any) { data["sourceImageNodeId"] = "A" })
		}},
		{"source-id-wrong-type", func(t *testing.T, graph *domain.Graph) {
			mutateImageFrontierNode(t, graph, "C", func(data map[string]any) { data["sourceNodeId"] = map[string]any{"id": "A"} })
		}},
		{"hidden-param-image", func(t *testing.T, graph *domain.Graph) {
			mutateImageFrontierNode(t, graph, "C", func(data map[string]any) {
				data["params"] = map[string]any{"imageUrls": []string{"rhtv-asset:guide", "rhtv-asset:img"}}
			})
		}},
		{"multiple-source-outputs", func(t *testing.T, graph *domain.Graph) {
			mutateImageFrontierNode(t, graph, "B", func(data map[string]any) {
				delete(data, "historyStorage")
				data["sourceObjects"] = []string{"rhtv-asset:last", "rhtv-asset:img"}
			})
		}},
		{"guide-is-original", func(t *testing.T, graph *domain.Graph) {
			mutateImageFrontierNode(t, graph, "C", func(data map[string]any) { data["toolsSourceUrl"] = "rhtv-asset:last" })
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, store, graph := imageFrontierFixture(t, "IMAGE_ERASE", false)
			test.change(t, &graph)
			_, err := createImageFrontierTask(t, s, graph)
			faultCode(t, err, "PROMPT_CONDITIONING_INVALID")
			if store.creates != 0 {
				t.Fatal("invalid source created task")
			}
		})
	}
	for _, pose := range []bool{false, true} {
		s, store, graph := imageFrontierFixture(t, "IMAGE_ENHANCE", pose)
		mutateImageFrontierNode(t, &graph, "C", func(data map[string]any) { data["toolsSourceUrl"] = "rhtv-asset:img" })
		_, err := createImageFrontierTask(t, s, graph)
		faultCode(t, err, "PROMPT_CONDITIONING_INVALID")
		if store.creates != 0 {
			t.Fatal("ancestor source URL accepted")
		}
	}
}

func TestNativeImageFrontierLongChainKeepsFullAncestorCASWithoutReferenceBudgetGrowth(t *testing.T) {
	s, store, graph := imageFrontierFixture(t, "IMAGE_ENHANCE", false)
	graph.Edges = []domain.Edge{{Source: "text", Target: "A"}, {Source: "B", Target: "C"}}
	prior := "A"
	for i := 0; i < 6; i++ {
		id := string(rune('D' + i))
		asset := "old-" + id
		store.assets[asset] = Asset{ID: asset, Kind: "IMAGE", MimeType: "image/png", ByteSize: 2048, Version: "sha256:e", SHA256: strings.Repeat("e", 64)}
		body, _ := json.Marshal(map[string]any{"id": id, "type": "rh-image", "data": map[string]any{"sourceObjects": []string{"rhtv-asset:" + asset}}})
		graph.Nodes = append(graph.Nodes, body)
		graph.Edges = append(graph.Edges, domain.Edge{Source: prior, Target: id})
		prior = id
	}
	graph.Edges = append(graph.Edges, domain.Edge{Source: prior, Target: "B"})
	task, err := createImageFrontierTask(t, s, graph)
	if err != nil {
		t.Fatal(err)
	}
	if got := requestAssetIDs(frozenRequest(t, task)); !reflect.DeepEqual(got, []string{"last"}) {
		t.Fatal("long chain consumed Router reference budget", got)
	}
	guard, ids, err := domain.CanvasGuard(task.Snapshot, "C")
	if err != nil || len(ids) != len(graph.Nodes) {
		t.Fatal("full ancestor version closure lost", ids, err)
	}
	mutateImageFrontierNode(t, &graph, "A", func(data map[string]any) { data["sourceObjects"] = []string{"rhtv-asset:guide"} })
	changed, _ := json.Marshal(graph)
	newGuard, _, err := domain.CanvasGuard(changed, "C")
	if err != nil || guard == newGuard {
		t.Fatal("excluded image ancestor stopped participating in CAS", err)
	}
}

func TestOrdinaryImageFrontierUsesOnlyDirectMediaAndExplicitReferences(t *testing.T) {
	s, _, graph := imageFrontierFixture(t, "IMAGE_IMAGE", false)
	task, err := createImageFrontierTask(t, s, graph)
	if err != nil {
		t.Fatal(err)
	}
	if got := requestAssetIDs(frozenRequest(t, task)); !reflect.DeepEqual(got, []string{"last"}) {
		t.Fatal("ordinary reference editing leaked an ancestor", got)
	}
}

func TestNativeImageFrontierWorkerNeverReattachesHistoricalAncestor(t *testing.T) {
	s, _, graph := imageFrontierFixture(t, "IMAGE_ERASE", false)
	accepted, err := createImageFrontierTask(t, s, graph)
	if err != nil {
		t.Fatal(err)
	}
	request := frozenRequest(t, accepted)
	guide := request.Attachments[1]
	request.Attachments = []gateway.Attachment{guide}
	request.Input = nil
	request.PromptSpec.Messages = nil
	appendUserInput(&request, gateway.InputPart{Type: "MEDIA", AttachmentRef: &guide.Ref})
	old, current := "img", "last"
	accepted.Plans = []domain.Plan{
		{NodeID: "A", ExecutionID: "a-execution", State: "SUCCEEDED", Outputs: []domain.Output{{ID: "a-output", Type: "ASSET", AssetID: &old}}},
		{NodeID: "B", ExecutionID: "b-execution", State: "SUCCEEDED", Outputs: []domain.Output{{ID: "b-output", Type: "ASSET", AssetID: &current}}},
		{NodeID: "C", InputReferences: []domain.InputReference{{SourceNodeID: "C", AssetID: "guide", Modality: "IMAGE"}}},
	}
	grants, err := s.bindUpstream(context.Background(), accepted, 2, &request)
	if err != nil || len(grants) != 1 {
		t.Fatal("worker failed to bind current output", grants, err)
	}
	if got := requestAssetIDs(request); !reflect.DeepEqual(got, []string{"last", "guide"}) {
		t.Fatal("worker reintroduced ancestor A", got)
	}
	for _, ref := range accepted.Plans[2].InputReferences {
		if ref.SourceNodeID == "A" || ref.AssetID == "img" {
			t.Fatal("worker private input bindings retained ancestor", ref)
		}
	}
}

func TestImageRegenerationExcludesOwnResultForOrdinaryAndToolEdits(t *testing.T) {
	for _, tool := range []string{"IMAGE_IMAGE", "IMAGE_REDRAW", "IMAGE_ERASE", "IMAGE_EXPAND", "IMAGE_ENHANCE", "IMAGE_LIGHT", "IMAGE_CUTOUT", "IMAGE_CUTOUT_TEXT", "IMAGE_MULTIANGLE", "portrait-pose", "reopened-redraw"} {
		t.Run(tool, func(t *testing.T) {
			nativeTool := tool
			if tool == "portrait-pose" {
				nativeTool = "IMAGE_IMAGE"
			}
			if tool == "reopened-redraw" {
				nativeTool = "IMAGE_REDRAW"
			}
			s, store, graph := imageFrontierFixture(t, nativeTool, tool == "portrait-pose")
			store.assets["old-result"] = Asset{ID: "old-result", Kind: "IMAGE", MimeType: "image/png", ByteSize: 2048, Version: "sha256:f", SHA256: strings.Repeat("f", 64)}
			mutateImageFrontierNode(t, &graph, "C", func(d map[string]any) {
				if tool == "reopened-redraw" {
					d["params"] = map[string]any{"prompt": "preserve this user's intent", "imageUrls": []string{"rhtv-asset:last"}}
				}
				d["sourceObjects"] = []string{"rhtv-asset:old-result"}
				d["imageUrl"] = "rhtv-asset:old-result"
				d["assetIds"] = []string{"old-result"}
				d["output"] = []any{map[string]any{"assetId": "old-result"}}
				d["historyStorage"] = map[string]any{"historyId": "target-previous-execution"}
			})
			task, err := createImageFrontierTask(t, s, graph)
			if err != nil {
				t.Fatal(err)
			}
			want := []string{"last"}
			if nativeTool == "IMAGE_REDRAW" || nativeTool == "IMAGE_ERASE" || nativeTool == "IMAGE_EXPAND" || tool == "portrait-pose" {
				want = append(want, "guide")
			}
			req := frozenRequest(t, task)
			if !reflect.DeepEqual(requestAssetIDs(req), want) || !reflect.DeepEqual(requestMediaIDs(req), want) {
				t.Fatal("regeneration input changed", requestAssetIDs(req), requestMediaIDs(req))
			}
			body, _ := json.Marshal(graph)
			if string(task.Snapshot) != string(body) {
				t.Fatal("display/history snapshot mutated")
			}
		})
	}
}

func TestTextImageNewAndRegenerationHaveNoReferenceImages(t *testing.T) {
	for _, version := range []string{"1", "2", "3"} {
		for _, completed := range []bool{false, true} {
			s, _, catalog := promptTestService(t, "TEXT_TO_IMAGE")
			cap := realImageCapability("TEXT_TO_IMAGE")
			cap.Version, cap.ParameterSchemaVersion = version, version
			catalog.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
			s.WithRealExecution(true)
			data := map[string]any{"capabilityRef": cap.Ref, "capabilityVersion": version, "params": map[string]any{"prompt": "original composition"}, "routerParameters": map[string]any{"count": 1}}
			if completed {
				data["sourceObjects"] = []string{"rhtv-asset:img"}
				data["imageUrl"] = "rhtv-asset:img"
				data["output"] = []any{map[string]any{"assetId": "img"}}
				data["historyStorage"] = map[string]any{"historyId": "old-result"}
			}
			raw, _ := json.Marshal(data)
			task, err := promptCanvas(t, s, string(raw))
			if err != nil {
				t.Fatalf("version=%s completed=%v: %v", version, completed, err)
			}
			req := frozenRequest(t, task)
			if len(req.Attachments) != 0 || len(req.PromptSpec.Conditioning) != 0 {
				t.Fatal("text-image acquired previous pixels", version, completed)
			}
		}
	}
}

func TestOrdinaryImageNewAndRegenerationPreserveExplicitInputs(t *testing.T) {
	for _, version := range []string{"1", "2", "3"} {
		for _, mode := range []string{"direct-only", "two-direct", "explicit-extra", "without-history-metadata"} {
			t.Run(version+"/"+mode, func(t *testing.T) {
				s, _, graph := imageFrontierFixture(t, "IMAGE_IMAGE", false)
				catalog := s.gateway.(*promptTestGateway)
				page := catalog.pages[""]
				page.Items[0].Version = version
				page.Items[0].ParameterSchemaVersion = version
				catalog.pages[""] = page
				mutateImageFrontierNode(t, &graph, "C", func(d map[string]any) {
					d["capabilityVersion"] = version
					delete(d, "toolsSourceUrl")
					if mode == "explicit-extra" {
						d["params"] = map[string]any{"prompt": "preserve this user's intent", "imageUrls": []string{"rhtv-asset:last", "rhtv-asset:guide"}}
					}
				})
				if mode == "two-direct" {
					graph.Edges = append(graph.Edges, domain.Edge{Source: "A", Target: "C"})
				}
				if mode == "without-history-metadata" {
					mutateImageFrontierNode(t, &graph, "B", func(d map[string]any) {
						delete(d, "historyStorage")
						d["params"] = map[string]any{"prompt": "DO NOT REPLAY upstream instruction", "imageUrls": []string{"rhtv-asset:img"}}
					})
				}
				task, err := createImageFrontierTask(t, s, graph)
				if err != nil {
					t.Fatal(err)
				}
				req := frozenRequest(t, task)
				want := []string{"last"}
				if mode == "two-direct" {
					want = []string{"last", "img"} // B was connected first; A was appended later.
				}
				if mode == "explicit-extra" {
					want = append(want, "guide")
				}
				if !reflect.DeepEqual(requestAssetIDs(req), want) {
					t.Fatal("explicit reference semantics", requestAssetIDs(req), want)
				}
				for _, part := range req.Input {
					if part.Text != nil && strings.Contains(*part.Text, "DO NOT REPLAY") {
						t.Fatal("upstream generation instruction leaked")
					}
				}
			})
		}
	}
}

func TestOrdinaryImageHistoricalChoiceIsAuthoritativeOrFailsWithoutFallback(t *testing.T) {
	for _, missing := range []bool{false, true} {
		s, store, graph := imageFrontierFixture(t, "IMAGE_IMAGE", false)
		mutateImageFrontierNode(t, &graph, "C", func(d map[string]any) {
			delete(d, "toolsSourceUrl")
			d["params"] = map[string]any{"prompt": "use selected reference"}
		})
		mutateImageFrontierNode(t, &graph, "B", func(d map[string]any) { d["selectedHistoryOutputId"] = "chosen" })
		s.store = &selectedHistoryStore{promptTestStore: store, read: func(owner string, q HistoryInputQuery) (HistoryInput, error) {
			if owner != "owner" || q.ProjectID != "project" || q.NodeID != "B" || q.OutputID != "chosen" {
				t.Fatal("unscoped history lookup", q)
			}
			if missing {
				return HistoryInput{}, domain.ErrNotFound
			}
			id := "guide"
			return HistoryInput{TaskID: "chosen-task", ExecutionID: "chosen-execution", Output: domain.Output{ID: "chosen", Type: "ASSET", AssetID: &id}}, nil
		}}
		task, err := createImageFrontierTask(t, s, graph)
		if missing {
			if err == nil || store.creates != 0 {
				t.Fatal("missing history fell back")
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if got := requestAssetIDs(frozenRequest(t, task)); !reflect.DeepEqual(got, []string{"guide"}) {
			t.Fatal("history choice lost", got)
		}
	}
}

func TestOrdinaryImageWorkerUsesOnlyDirectFreshOutput(t *testing.T) {
	s, _, graph := imageFrontierFixture(t, "IMAGE_IMAGE", false)
	task, err := createImageFrontierTask(t, s, graph)
	if err != nil {
		t.Fatal(err)
	}
	request := frozenRequest(t, task)
	request.Attachments = nil
	request.Input = nil
	request.PromptSpec.Messages = nil
	old, current := "img", "last"
	task.Plans = []domain.Plan{{NodeID: "A", State: "SUCCEEDED", Outputs: []domain.Output{{ID: "a", Type: "ASSET", AssetID: &old}}}, {NodeID: "B", State: "SUCCEEDED", Outputs: []domain.Output{{ID: "b", Type: "ASSET", AssetID: &current}}}, {NodeID: "C"}}
	if _, err = s.bindUpstream(context.Background(), task, 2, &request); err != nil {
		t.Fatal(err)
	}
	if got := requestAssetIDs(request); !reflect.DeepEqual(got, []string{"last"}) {
		t.Fatal("worker reintroduced historical ancestor", got)
	}
}
