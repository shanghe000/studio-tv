package application

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

func nativeBoardVideoFixture(t *testing.T) (*Service, domain.Graph) {
	t.Helper()
	s, _, graph := nativeBoardFixture(t)
	cap := promptCapability("h3-drama-reference-v1", "OMNI_REFERENCE")
	cap.Model = &gateway.ModelDescriptor{ModelRef: "h3"}
	cap.ParameterSchema = json.RawMessage(`{"type":"object","additionalProperties":false,"x-video-mode":"OMNI_REFERENCE"}`)
	s.gateway.(*promptTestGateway).pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
	mutateImageFrontierNode(t, &graph, "shot1", func(data map[string]any) { data["sourceObjects"] = []string{"rhtv-asset:img"} })
	// Captured S08 target: no sceneCode or storyboardRowIds, but the same
	// opaque storyboardRowId as its direct native board, plus explicit images.
	graph.Nodes = append(graph.Nodes, json.RawMessage(`{"id":"video","type":"rh-video","data":{"capabilityRef":"h3-drama-reference-v1","capabilityVersion":"1","subType":"multimodal-video","isStoryboard":true,"storyboardRowId":"studio-shot-1__merge_studio-shot-1","params":{"prompt":"ALICE_ONLY_SHOT gently adjusts her sleeve for five seconds","imageUrls":["rhtv-asset:img","rhtv-asset:last"]},"routerParameters":{}}}`))
	graph.Edges = append(graph.Edges, domain.Edge{Source: "shot1", Target: "video", SourceHandle: "output", TargetHandle: "input"})
	return s, graph
}

func TestNativeStoryboardVideoExcludesOnlyBoardScriptLineage(t *testing.T) {
	s, graph := nativeBoardVideoFixture(t)
	task, err := nativeBoardCanvas(t, s, graph, "NODE", "video")
	if err != nil {
		t.Fatal(err)
	}
	request := frozenRequest(t, task)
	body, _ := json.Marshal(request.Input)
	if strings.Contains(string(body), "BOB_OTHER_SHOT") || strings.Contains(string(body), "FULL_SCRIPT_PROMPT") || strings.Contains(string(body), "WHOLE_STORY_ANCESTOR") {
		t.Fatal("S08 inherited the complete upstream script instead of its compiled selected shot", string(body))
	}
	if !strings.Contains(strings.Join(imageRequestTexts(request), "\n"), "ALICE_ONLY_SHOT") || !reflect.DeepEqual(requestAssetIDs(request), []string{"img", "last"}) {
		t.Fatal("H3 authored shot or explicit current board/entity images changed", requestAssetIDs(request))
	}
	frozen, _ := json.Marshal(graph)
	if string(task.Snapshot) != string(frozen) {
		t.Fatal("video input projection removed full graph/history")
	}
	fullScript := "a new script result BOB_OTHER_SHOT"
	task.Plans = append([]domain.Plan{{NodeID: "script", State: "SUCCEEDED", Outputs: []domain.Output{{ID: "new-script", Type: "TEXT", Text: &fullScript}}}}, task.Plans...)
	if _, err := s.bindUpstream(context.Background(), task, 1, &request); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(imageRequestTexts(request), "\n"), "BOB_OTHER_SHOT") {
		t.Fatal("video worker reinjected complete script")
	}
}

func TestNativeStoryboardVideoPreservesIndependentDirectText(t *testing.T) {
	s, graph := nativeBoardVideoFixture(t)
	graph.Edges = append(graph.Edges, domain.Edge{Source: "article", Target: "video"})
	task, err := nativeBoardCanvas(t, s, graph, "NODE", "video")
	if err != nil {
		t.Fatal(err)
	}
	text := strings.Join(imageRequestTexts(frozenRequest(t, task)), "\n")
	if !strings.Contains(text, "WHOLE_STORY_ANCESTOR") || strings.Contains(text, "FULL_SCRIPT_PROMPT") || strings.Contains(text, "BOB_OTHER_SHOT") {
		t.Fatal("independent direct authored text was pruned with script lineage", text)
	}
}

func TestNativeStoryboardVideoRejectsUnverifiableBoardBindings(t *testing.T) {
	for _, boundary := range []string{"missing target row", "wrong target row type", "mismatched row", "missing board row", "wrong board flag", "unresolved selected row", "empty video prompt", "two direct boards"} {
		t.Run(boundary, func(t *testing.T) {
			s, graph := nativeBoardVideoFixture(t)
			mutateImageFrontierNode(t, &graph, "video", func(data map[string]any) {
				switch boundary {
				case "missing target row":
					delete(data, "storyboardRowId")
				case "wrong target row type":
					data["storyboardRowId"] = 1
				case "mismatched row":
					data["storyboardRowId"] = "studio-shot-2__merge_studio-shot-2"
				case "empty video prompt":
					data["params"].(map[string]any)["prompt"] = " "
				}
			})
			mutateImageFrontierNode(t, &graph, "shot1", func(data map[string]any) {
				switch boundary {
				case "missing board row":
					delete(data, "storyboardRowId")
				case "wrong board flag":
					data["isStoryboard"] = false
				case "unresolved selected row":
					data["storyboardRowIds"] = []string{"unknown-row"}
				}
			})
			if boundary == "two direct boards" {
				graph.Edges = append(graph.Edges, domain.Edge{Source: "shot2", Target: "video"})
			}
			_, err := nativeBoardCanvas(t, s, graph, "NODE", "video")
			faultCode(t, err, "PROMPT_CONDITIONING_INVALID")
			if s.store.(*promptTestStore).creates != 0 {
				t.Fatal("ambiguous native board reference created a task")
			}
		})
	}
}

func TestNativeStoryboardVideoLeavesOrdinaryH3AndUnknownChainsUnchanged(t *testing.T) {
	for _, boundary := range []string{"ordinary video", "other scene", "ordinary image source", "untrusted", "custom board edge"} {
		t.Run(boundary, func(t *testing.T) {
			_, graph := nativeBoardVideoFixture(t)
			mutateImageFrontierNode(t, &graph, "video", func(data map[string]any) {
				if boundary == "ordinary video" {
					delete(data, "isStoryboard")
				}
				if boundary == "other scene" {
					data["sceneCode"] = "other-video-scene"
				}
			})
			if boundary == "ordinary image source" {
				mutateImageFrontierNode(t, &graph, "shot1", func(data map[string]any) { delete(data, "sceneCode") })
			}
			if boundary == "custom board edge" {
				graph.Edges[len(graph.Edges)-1].TargetHandle = "custom-context"
			}
			var video domain.Node
			_ = json.Unmarshal(graph.Nodes[len(graph.Nodes)-1], &video)
			selected := map[string]bool{"article": true, "script": true, "shot1": true, "video": true}
			got, err := nativeStoryboardVideoInputFrontier(gateway.CapabilitySelection{Ref: "h3-drama-reference-v1", Version: "1"}, video, graph, selected, boundary != "untrusted")
			if err != nil || !reflect.DeepEqual(got, selected) {
				t.Fatal("ordinary/untrusted/unknown video text inputs changed", got, err)
			}
		})
	}
}
