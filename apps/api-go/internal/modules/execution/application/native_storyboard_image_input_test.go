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

func nativeBoardFixture(t *testing.T) (*Service, *promptTestStore, domain.Graph) {
	t.Helper()
	s, store, catalog := promptTestService(t, "IMAGE_TO_IMAGE")
	cap := realImageCapability("IMAGE_TO_IMAGE")
	cap.Version, cap.ParameterSchemaVersion = "3", "3"
	catalog.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
	s.WithRealExecution(true)
	node := func(id, kind string, data map[string]any, parent string) json.RawMessage {
		body, _ := json.Marshal(map[string]any{"id": id, "type": kind, "data": data, "parentId": parent})
		return body
	}
	// Preserve the captured native output.rows object shape, including its
	// separate entity registry (native-storyboard-two-shot-preflight-diagnostic).
	rows := []any{
		map[string]any{"id": "studio-shot-1", "shot": "1", "description": "ALICE_ONLY_SHOT adjusts her sleeve"},
		map[string]any{"id": "studio-shot-2", "shot": "2", "description": "BOB_OTHER_SHOT turns toward camera"},
	}
	graph := domain.Graph{Nodes: []json.RawMessage{
		node("group", "group", map[string]any{}, ""),
		node("article", "rh-text", map[string]any{"text": "WHOLE_STORY_ANCESTOR containing all characters"}, ""),
		node("script", "rh-script", map[string]any{"output": map[string]any{"rows": rows, "characters": []any{map[string]any{"name": "ALICE_ONLY_SHOT"}, map[string]any{"name": "BOB_OTHER_SHOT"}}, "outputScene": "film"}, "params": map[string]any{"prompt": "FULL_SCRIPT_PROMPT with ALICE_ONLY_SHOT and BOB_OTHER_SHOT"}}, ""),
	}, Edges: []domain.Edge{{Source: "article", Target: "script", SourceHandle: "output", TargetHandle: "input"}}}
	for _, shot := range []struct{ id, row, prompt, asset string }{
		{"shot1", "studio-shot-1", "【镜号】1\nALICE_ONLY_SHOT adjusts her sleeve in a white studio", "img"},
		{"shot2", "studio-shot-2", "【镜号】2\nBOB_OTHER_SHOT turns toward camera in a white studio", "last"},
	} {
		graph.Nodes = append(graph.Nodes, node(shot.id, "rh-image", map[string]any{
			"subType": "image-image", "toolsType": "image-image", "sceneCode": "storyboard-prompt-board", "isStoryboard": true,
			"storyboardRowId": shot.row + "__merge_" + shot.row, "storyboardRowIds": []string{shot.row}, "aspectRatio": "16:9",
			"capabilityRef": cap.Ref, "capabilityVersion": cap.Version, "params": map[string]any{"prompt": shot.prompt, "imageUrls": []string{"rhtv-asset:" + shot.asset}},
			"routerParameters": map[string]any{"count": 1},
		}, "group"))
		graph.Edges = append(graph.Edges, domain.Edge{Source: "script", Target: shot.id, SourceHandle: "output", TargetHandle: "input"})
	}
	return s, store, graph
}

func nativeBoardCanvas(t *testing.T, s *Service, graph domain.Graph, targetType, target string) (domain.Task, error) {
	t.Helper()
	body, _ := json.Marshal(graph)
	return s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: targetType, TargetID: target, Graph: body})
}

func nativeBoardRequest(t *testing.T, plan domain.Plan) gateway.InvocationRequest {
	t.Helper()
	var request gateway.InvocationRequest
	if err := json.Unmarshal(plan.Request, &request); err != nil {
		t.Fatal(err)
	}
	return request
}

func TestNativeStoryboardImageGroupFreezesOnlyEachCompiledShotAndExplicitMedia(t *testing.T) {
	s, _, graph := nativeBoardFixture(t)
	task, err := nativeBoardCanvas(t, s, graph, "GROUP", "group")
	if err != nil || len(task.Plans) != 2 {
		t.Fatal("two-shot group was not planned", err, len(task.Plans))
	}
	for i, plan := range task.Plans {
		if plan.PromptRequirements == nil || !plan.PromptRequirements.StoryboardInputFrontier {
			t.Fatal("new canvas task did not freeze its storyboard input policy")
		}
		request := nativeBoardRequest(t, plan)
		text := strings.Join(imageRequestTexts(request), "\n")
		want, other, asset := "ALICE_ONLY_SHOT", "BOB_OTHER_SHOT", "img"
		if i == 1 {
			want, other, asset = other, want, "last"
		}
		body, _ := json.Marshal(request.Input)
		if !strings.Contains(text, want) || strings.Contains(string(body), other) || strings.Contains(string(body), "FULL_SCRIPT_PROMPT") || strings.Contains(string(body), "WHOLE_STORY_ANCESTOR") {
			t.Fatal("full script/other shot reached the image model", plan.NodeID, string(body))
		}
		if !reflect.DeepEqual(requestAssetIDs(request), []string{asset}) || !reflect.DeepEqual(requestMediaIDs(request), []string{asset}) {
			t.Fatal("current target explicit reference lost", plan.NodeID, requestAssetIDs(request))
		}
		if request.PromptSpec.TemplateVersion != nativeStoryboardBoardTemplateVersion || !strings.Contains(request.PromptSpec.Instructions[1].Text, "single cinematic frame") || !strings.Contains(request.PromptSpec.Instructions[1].Text, "identity only") {
			t.Fatal("new native storyboard single-frame/identity template was not frozen", request.PromptSpec)
		}
		for _, ref := range plan.InputReferences {
			if ref.SourceNodeID == "script" || ref.SourceNodeID == "article" {
				t.Fatal("lineage-only script was bound as current model input", ref)
			}
		}
	}
	body, _ := json.Marshal(graph)
	if string(task.Snapshot) != string(body) {
		t.Fatal("input projection changed frozen DAG/history")
	}
	guard, ids, err := domain.CanvasGuard(task.Snapshot, "shot1")
	if err != nil || len(ids) != 3 {
		t.Fatal("script ancestors no longer participate in CAS", ids, err)
	}
	mutateImageFrontierNode(t, &graph, "article", func(data map[string]any) { data["text"] = "changed original story" })
	changed, _ := json.Marshal(graph)
	newGuard, _, err := domain.CanvasGuard(changed, "shot1")
	if err != nil || guard == newGuard {
		t.Fatal("script ancestor edit stopped changing CAS guard", err)
	}
}

func TestLegacyStoryboardPrivateRequestsKeepPreboundAndLateBoundScriptHistory(t *testing.T) {
	for _, video := range []bool{false, true} {
		t.Run(map[bool]string{false: "image", true: "video"}[video], func(t *testing.T) {
			s, _, graph := nativeBoardFixture(t)
			target, capRef := "shot1", "codex-image-edit-v1"
			if video {
				s, graph = nativeBoardVideoFixture(t)
				target, capRef = "video", "h3-drama-reference-v1"
			}
			// A legacy private request starts with its script text/reference
			// already frozen, plus a planned script result still to bind. This
			// deliberately never calls the new Canvas projection to build it.
			legacy := json.RawMessage(`{"capability":{"ref":"` + capRef + `","version":"3"},"input":[{"type":"TEXT","text":"OLD_PREBOUND_SCRIPT ALICE_ONLY_SHOT and BOB_OTHER_SHOT"},{"type":"TEXT","text":"ALICE_ONLY_SHOT compiled target"},{"type":"MEDIA","attachmentRef":"att-img"}],"attachments":[{"ref":"att-img","sourceRef":"img","kind":"IMAGE","sourceVersion":"sha256:a","sha256":"` + strings.Repeat("a", 64) + `","readGrantRef":"old-grant"}],"promptSpec":{"schemaVersion":"1","templateRef":"studio-tv/scene/storyboard-prompt-board","templateVersion":"studio-authored-1","instructions":[{"role":"SYSTEM","text":"old product instruction"},{"role":"DEVELOPER","text":"old task instruction"}],"conditioning":[],"messages":[]}}`)
			var request gateway.InvocationRequest
			if err := json.Unmarshal(legacy, &request); err != nil {
				t.Fatal(err)
			}
			if video {
				request.Capability.Version = "1"
				last := gateway.Attachment{Ref: "att-last", SourceRef: "last", Kind: "IMAGE", SourceVersion: "sha256:b", SHA256: strings.Repeat("b", 64), ReadGrantRef: "old-last-grant"}
				request.Attachments = append(request.Attachments, last)
				ref := last.Ref
				request.Input = append(request.Input, gateway.InputPart{Type: "MEDIA", AttachmentRef: &ref})
				legacy, _ = json.Marshal(request)
			}
			late := "LATE_BOUND_SCRIPT ALICE_ONLY_SHOT and BOB_OTHER_SHOT"
			snapshot, _ := json.Marshal(graph)
			project := "project"
			task := domain.Task{Kind: "CANVAS", OwnerID: "owner", ProjectID: &project, Snapshot: snapshot, Plans: []domain.Plan{
				{NodeID: "script", ExecutionID: "new-script-execution", State: "SUCCEEDED", Outputs: []domain.Output{{ID: "new-script-output", Type: "TEXT", Text: &late}}},
				{NodeID: target, Request: legacy, MediaInputFrontier: true, PromptRequirements: &domain.PromptRequirements{RequireImage: !video}, InputReferences: []domain.InputReference{
					{SourceNodeID: "script", Modality: "TEXT", HistoryTaskID: "old-script-task", HistoryExecutionID: "old-script-execution", HistoryOutputID: "old-script-output", HistoryOutputSHA256: strings.Repeat("c", 64)},
				}},
			}}
			if _, err := s.bindUpstream(context.Background(), task, 1, &request); err != nil {
				t.Fatal(err)
			}
			text := strings.Join(imageRequestTexts(request), "\n")
			if !strings.Contains(text, "OLD_PREBOUND_SCRIPT") || !strings.Contains(text, "LATE_BOUND_SCRIPT") || !strings.Contains(text, "BOB_OTHER_SHOT") || string(task.Plans[1].Request) != string(legacy) {
				t.Fatal("old frozen inputs or their pending script binding were upgraded", text)
			}
			found := false
			for _, ref := range task.Plans[1].InputReferences {
				found = found || ref.HistoryTaskID == "old-script-task" && ref.HistoryOutputSHA256 == strings.Repeat("c", 64)
			}
			if !found || request.PromptSpec.TemplateVersion != "studio-authored-1" || request.PromptSpec.Instructions[1].Text != "old task instruction" {
				t.Fatal("old input history provenance/template changed")
			}
		})
	}
}

func TestNativeStoryboardImageMergedRowsUseCompiledSelectionNotUnselectedScript(t *testing.T) {
	for _, legacyArray := range []bool{false, true} {
		s, _, graph := nativeBoardFixture(t)
		mutateImageFrontierNode(t, &graph, "script", func(data map[string]any) {
			table := data["output"].(map[string]any)
			table["rows"] = append(table["rows"].([]any), map[string]any{"id": "studio-shot-3", "description": "UNSELECTED_THIRD_SHOT"})
			if legacyArray {
				data["output"] = table["rows"]
			}
		})
		compiled := "selected merged ALICE_ONLY_SHOT then BOB_OTHER_SHOT"
		mutateImageFrontierNode(t, &graph, "shot1", func(data map[string]any) {
			data["storyboardRowIds"] = []string{"studio-shot-1", "studio-shot-2"}
			data["params"].(map[string]any)["prompt"] = compiled
		})
		task, err := nativeBoardCanvas(t, s, graph, "NODE", "shot1")
		if err != nil {
			t.Fatal(err)
		}
		request := frozenRequest(t, task)
		if got := imageRequestTexts(request); !reflect.DeepEqual(got, []string{compiled}) {
			t.Fatal("merged selection was reconstructed or expanded to the full script", got)
		}
		if strings.Contains(string(task.Plans[0].Request), "UNSELECTED_THIRD_SHOT") || !strings.Contains(string(task.Snapshot), "UNSELECTED_THIRD_SHOT") {
			t.Fatal("unselected shot leaked or full snapshot lost")
		}
	}
}

func TestNativeStoryboardImagePreservesIndependentInputsAndSelectedMediaHistory(t *testing.T) {
	s, store, graph := nativeBoardFixture(t)
	graph.Nodes = append(graph.Nodes, json.RawMessage(`{"id":"media","type":"rh-image","data":{"historyStorage":{"historyId":"previous-image"},"params":{"prompt":"OLD_MEDIA_PROMPT","imageUrls":["rhtv-asset:last"]},"sourceObjects":["rhtv-asset:img"]}}`))
	// The same text ancestor is also explicitly connected through a separate
	// non-script path. That authored condition must remain an input.
	graph.Edges = append(graph.Edges, domain.Edge{Source: "article", Target: "media"}, domain.Edge{Source: "media", Target: "shot1"})
	project, asset := "project", "img"
	s.store = &selectedHistoryStore{promptTestStore: store, detail: func(owner, id string) (History, error) {
		if owner != "owner" || id != "previous-image" {
			t.Fatal("wrong history authority", owner, id)
		}
		return History{ProjectID: &project, NodeID: "media", TaskID: "old-image-task", ExecutionID: id, Outputs: []domain.Output{{ID: "old-image-output", Type: "ASSET", AssetID: &asset}}}, nil
	}}
	task, err := nativeBoardCanvas(t, s, graph, "NODE", "shot1")
	if err != nil {
		t.Fatal(err)
	}
	request := frozenRequest(t, task)
	text := strings.Join(imageRequestTexts(request), "\n")
	if !strings.Contains(text, "WHOLE_STORY_ANCESTOR") || strings.Contains(text, "FULL_SCRIPT_PROMPT") || strings.Contains(text, "BOB_OTHER_SHOT") || strings.Contains(text, "OLD_MEDIA_PROMPT") {
		t.Fatal("independent authored text changed, or media/script history inputs leaked", text)
	}
	if !reflect.DeepEqual(requestAssetIDs(request), []string{"img"}) {
		t.Fatal("current explicit media was lost or old generation reference reintroduced", requestAssetIDs(request))
	}
	proof := false
	for _, ref := range task.Plans[0].InputReferences {
		proof = proof || ref.SourceNodeID == "media" && ref.HistoryTaskID == "old-image-task" && ref.HistoryOutputSHA256 != ""
	}
	if !proof {
		t.Fatal("selected media history provenance lost")
	}
}

func TestNativeStoryboardImageWorkerDoesNotReinjectScriptOrRewriteFrozenHistoryTemplate(t *testing.T) {
	s, _, graph := nativeBoardFixture(t)
	task, err := nativeBoardCanvas(t, s, graph, "NODE", "shot1")
	if err != nil {
		t.Fatal(err)
	}
	request := frozenRequest(t, task)
	request.PromptSpec.TemplateVersion = "historical-board-template"
	request.PromptSpec.Instructions[1].Text = "historical instruction kept verbatim"
	frozen, _ := json.Marshal(request)
	task.Plans[0].Request = frozen
	fullScript := "new script output ALICE_ONLY_SHOT and BOB_OTHER_SHOT"
	prior := domain.Plan{NodeID: "script", State: "SUCCEEDED", Outputs: []domain.Output{{ID: "new-script-output", Type: "TEXT", Text: &fullScript}}}
	task.Plans = append([]domain.Plan{prior}, task.Plans...)
	if _, err := s.bindUpstream(context.Background(), task, 1, &request); err != nil {
		t.Fatal(err)
	}
	if request.PromptSpec.TemplateVersion != "historical-board-template" || request.PromptSpec.Instructions[1].Text != "historical instruction kept verbatim" || string(task.Plans[1].Request) != string(frozen) {
		t.Fatal("worker recomputed a previously frozen template/history")
	}
	if strings.Contains(strings.Join(imageRequestTexts(request), "\n"), "BOB_OTHER_SHOT") {
		t.Fatal("worker rebound an excluded script plan")
	}
}

func TestNativeStoryboardImageRejectsMalformedMetadataBeforeTaskCreation(t *testing.T) {
	changes := map[string]func(map[string]any){
		"missing board flag": func(d map[string]any) { delete(d, "isStoryboard") },
		"false board flag":   func(d map[string]any) { d["isStoryboard"] = false },
		"string board flag":  func(d map[string]any) { d["isStoryboard"] = "true" },
		"missing rows":       func(d map[string]any) { delete(d, "storyboardRowIds") },
		"empty rows":         func(d map[string]any) { d["storyboardRowIds"] = []string{} },
		"null rows":          func(d map[string]any) { d["storyboardRowIds"] = nil },
		"wrong rows type":    func(d map[string]any) { d["storyboardRowIds"] = "studio-shot-1" },
		"numeric row":        func(d map[string]any) { d["storyboardRowIds"] = []int{1} },
		"duplicate rows":     func(d map[string]any) { d["storyboardRowIds"] = []string{"studio-shot-1", "studio-shot-1"} },
		"blank row":          func(d map[string]any) { d["storyboardRowIds"] = []string{" "} },
		"unresolved row":     func(d map[string]any) { d["storyboardRowIds"] = []string{"not-a-script-row"} },
		"missing params":     func(d map[string]any) { delete(d, "params") },
		"wrong params":       func(d map[string]any) { d["params"] = "prompt" },
		"missing prompt":     func(d map[string]any) { delete(d["params"].(map[string]any), "prompt") },
		"empty prompt":       func(d map[string]any) { d["params"].(map[string]any)["prompt"] = " " },
		"wrong prompt":       func(d map[string]any) { d["params"].(map[string]any)["prompt"] = []string{"draw"} },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			s, store, graph := nativeBoardFixture(t)
			mutateImageFrontierNode(t, &graph, "shot1", change)
			_, err := nativeBoardCanvas(t, s, graph, "NODE", "shot1")
			if name == "wrong params" {
				// General input validation rejects a non-object params even
				// before this scene-specific frontier is considered.
				if !errors.Is(err, domain.ErrInvalid) {
					t.Fatal("non-object params accepted", err)
				}
			} else {
				faultCode(t, err, "PROMPT_CONDITIONING_INVALID")
			}
			if store.creates != 0 {
				t.Fatal("malformed native selection created a task")
			}
		})
	}
	for _, output := range []any{nil, "plain script", map[string]any{"shots": []any{}}, map[string]any{"rows": []any{}}, map[string]any{"rows": []any{map[string]any{"id": "studio-shot-1"}, map[string]any{"id": "studio-shot-1"}}}, map[string]any{"rows": []any{map[string]any{"id": 1}}}} {
		s, store, graph := nativeBoardFixture(t)
		mutateImageFrontierNode(t, &graph, "script", func(data map[string]any) { data["output"] = output })
		_, err := nativeBoardCanvas(t, s, graph, "NODE", "shot1")
		faultCode(t, err, "PROMPT_CONDITIONING_INVALID")
		if store.creates != 0 {
			t.Fatal("unverifiable source rows created a task")
		}
	}
}

func TestNativeStoryboardImageFrontierScopeAndNoPromptTextGuessing(t *testing.T) {
	for _, boundary := range []string{"ordinary", "unknown scene", "other node", "untrusted", "custom handle", "explicit conditioning"} {
		t.Run(boundary, func(t *testing.T) {
			_, _, graph := nativeBoardFixture(t)
			mutateImageFrontierNode(t, &graph, "shot1", func(data map[string]any) {
				if boundary == "ordinary" {
					delete(data, "sceneCode")
					delete(data, "isStoryboard")
					delete(data, "storyboardRowIds")
				}
				if boundary == "unknown scene" {
					data["sceneCode"] = "unregistered-other-scene"
				}
			})
			var target domain.Node
			_ = json.Unmarshal(graph.Nodes[3], &target)
			if boundary == "other node" {
				target.Type = "rh-text"
			}
			if boundary == "custom handle" {
				graph.Edges[1].TargetHandle = "custom-context"
			}
			if boundary == "explicit conditioning" {
				graph.Edges[1].ConditioningRole = "REFERENCE_IMAGE"
			}
			selected := map[string]bool{"article": true, "script": true, "shot1": true}
			got, _, err := canvasModelInputFrontier(gateway.CapabilitySelection{Ref: "codex-image-edit-v1", Version: "3"}, target, graph, selected, boundary != "untrusted")
			if err != nil || !reflect.DeepEqual(got, selected) {
				t.Fatal("unrelated native chain changed", got, err)
			}
		})
	}
	s, _, graph := nativeBoardFixture(t)
	mutateImageFrontierNode(t, &graph, "shot1", func(data map[string]any) {
		data["params"].(map[string]any)["prompt"] = "an opaque authored prompt without a shot-number header"
	})
	task, err := nativeBoardCanvas(t, s, graph, "NODE", "shot1")
	if err != nil || !reflect.DeepEqual(imageRequestTexts(frozenRequest(t, task)), []string{"an opaque authored prompt without a shot-number header"}) {
		t.Fatal("projection guessed selection from prompt text", err)
	}
}
