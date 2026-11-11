package application

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

func selectedTextImageFixture(t *testing.T, original, excerpt, own string) (*Service, domain.Graph) {
	t.Helper()
	s, _, catalog := promptTestService(t, "TEXT_TO_IMAGE")
	cap := realImageCapability("TEXT_TO_IMAGE")
	cap.Ref = "z-image-turbo-generate-v1"
	cap.Model = &gateway.ModelDescriptor{ProviderRef: "comfy", ModelRef: "z-image-turbo"}
	catalog.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
	s.WithRealExecution(true)
	body, _ := json.Marshal(map[string]any{
		"nodes": []any{
			map[string]any{"id": "original", "type": "rh-text", "data": map[string]any{"text": original}},
			map[string]any{"id": "excerpt", "type": "rh-text", "data": map[string]any{"title": "文生图提示词", "text": excerpt, "subType": "text-text"}},
			map[string]any{"id": "image", "type": "rh-image", "data": map[string]any{"subType": "text-image", "capabilityRef": cap.Ref, "capabilityVersion": cap.Version, "params": map[string]any{"prompt": own}, "routerParameters": map[string]any{"count": 1}}},
		},
		"edges": []domain.Edge{{Source: "original", Target: "excerpt"}, {Source: "excerpt", Target: "image"}},
	})
	var graph domain.Graph
	if err := json.Unmarshal(body, &graph); err != nil {
		t.Fatal(err)
	}
	return s, graph
}

func selectedTextImageTask(t *testing.T, s *Service, graph domain.Graph) domain.Task {
	t.Helper()
	body, _ := json.Marshal(graph)
	task, err := s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: "NODE", TargetID: "image", Graph: body})
	if err != nil {
		t.Fatal(err)
	}
	if string(task.Snapshot) != string(body) {
		t.Fatal("input frontier changed full graph/CAS lineage")
	}
	return task
}

func imageRequestTexts(request gateway.InvocationRequest) []string {
	texts := []string{}
	for _, part := range request.Input {
		if part.Type == "TEXT" && part.Text != nil {
			texts = append(texts, *part.Text)
		}
	}
	return texts
}

func TestSelectedTextImageUsesExcerptOnceWithoutItsOriginalAncestor(t *testing.T) {
	for _, original := range []string{"original complete article with an unrelated ending", "selected excerpt"} {
		s, graph := selectedTextImageFixture(t, original, "selected excerpt", "")
		task := selectedTextImageTask(t, s, graph)
		if got := imageRequestTexts(frozenRequest(t, task)); !reflect.DeepEqual(got, []string{"selected excerpt"}) {
			t.Fatal("original context or duplicate selected text reached image model", got)
		}
	}
}

func TestSelectedTextImagePreservesOwnPromptAndExplicitIndependentTextInputs(t *testing.T) {
	for _, branch := range []string{"own prompt", "explicit original", "two same-valued nodes", "independent media path"} {
		t.Run(branch, func(t *testing.T) {
			s, graph := selectedTextImageFixture(t, "original context", "selected excerpt", "draw with natural light")
			want := []string{"draw with natural light", "selected excerpt"}
			if branch == "explicit original" || branch == "two same-valued nodes" {
				graph.Edges = append(graph.Edges, domain.Edge{Source: "original", Target: "image"})
				original := "original context"
				if branch == "two same-valued nodes" {
					original = "selected excerpt"
					mutateImageFrontierNode(t, &graph, "original", func(data map[string]any) { data["text"] = original })
				}
				want = append(want, original) // The original was attached after the excerpt.
			}
			if branch == "independent media path" {
				// Keep text inherited by an independent media branch. This patch
				// does not redefine the existing image/video ancestry semantics.
				graph.Nodes = append(graph.Nodes, json.RawMessage(`{"id":"media","type":"rh-image","data":{}}`))
				graph.Edges = append(graph.Edges, domain.Edge{Source: "original", Target: "media"}, domain.Edge{Source: "media", Target: "image"})
				want = append([]string{"original context"}, want...)
			}
			if got := imageRequestTexts(frozenRequest(t, selectedTextImageTask(t, s, graph))); !reflect.DeepEqual(got, want) {
				t.Fatal("independent or explicitly selected text changed", got, want)
			}
		})
	}
}

func TestSelectedTextImageEmptyCurrentTextDoesNotResurrectContentOrAncestor(t *testing.T) {
	s, graph := selectedTextImageFixture(t, "old complete article", "", "draw a ceramic fox")
	mutateImageFrontierNode(t, &graph, "excerpt", func(data map[string]any) { data["content"] = "old generated content" })
	if got := imageRequestTexts(frozenRequest(t, selectedTextImageTask(t, s, graph))); !reflect.DeepEqual(got, []string{"draw a ceramic fox"}) {
		t.Fatal("cleared current text resurrected stale content", got)
	}
}

func TestSelectedTextImageWorkerDoesNotReintroduceOriginalTextResult(t *testing.T) {
	s, graph := selectedTextImageFixture(t, "original complete article", "selected excerpt", "")
	task := selectedTextImageTask(t, s, graph)
	request := frozenRequest(t, task)
	original := "new original result that is not the excerpt"
	task.Plans = []domain.Plan{{NodeID: "original", State: "SUCCEEDED", Outputs: []domain.Output{{ID: "original-output", Type: "TEXT", Text: &original}}}, task.Plans[0]}
	if _, err := s.bindUpstream(context.Background(), task, 1, &request); err != nil {
		t.Fatal(err)
	}
	if got := imageRequestTexts(request); !reflect.DeepEqual(got, []string{"selected excerpt"}) {
		t.Fatal("worker reintroduced excerpt ancestor", got)
	}
}

func TestSelectedTextImageFrontierLeavesOtherNativeChainsAndHistorySelectionsUnchanged(t *testing.T) {
	for _, boundary := range []string{"video", "LLM", "tool", "portrait", "storyboard", "no current text", "history selection", "conditioned", "special handle", "untrusted"} {
		t.Run(boundary, func(t *testing.T) {
			_, graph := selectedTextImageFixture(t, "original", "excerpt", "own")
			mutateImageFrontierNode(t, &graph, "image", func(data map[string]any) {
				if boundary == "tool" {
					data["toolsType"] = "IMAGE_IMAGE"
				}
				if boundary == "portrait" {
					data["isPortraitAdjustResult"] = true
				}
				if boundary == "storyboard" {
					data["isStoryboard"] = true
				}
			})
			mutateImageFrontierNode(t, &graph, "excerpt", func(data map[string]any) {
				if boundary == "no current text" {
					delete(data, "text")
					data["params"] = map[string]any{"prompt": "a previous instruction"}
				}
				if boundary == "history selection" {
					data["selectedHistoryOutputId"] = "chosen-output"
				}
			})
			if boundary == "conditioned" {
				graph.Edges[1].ConditioningRole = "REFERENCE_IMAGE"
			}
			if boundary == "special handle" {
				graph.Edges[1].SourceHandle = "custom"
			}
			var target domain.Node
			_ = json.Unmarshal(graph.Nodes[2], &target)
			if boundary == "video" {
				target.Type = "rh-video"
			}
			if boundary == "LLM" {
				target.Type = "rh-text"
			}
			selected := map[string]bool{"original": true, "excerpt": true, "image": true}
			trusted := boundary != "untrusted"
			got, _, err := canvasModelInputFrontier(gateway.CapabilitySelection{Ref: "codex-image-generate-v1", Version: "1"}, target, graph, selected, trusted)
			if err != nil || !reflect.DeepEqual(got, selected) {
				t.Fatal("unrelated chain or authority changed", got, err)
			}
		})
	}
}

func TestSelectedTextImageUsesContentOnlyCurrentTextAndStopsMultipleTextAncestors(t *testing.T) {
	s, graph := selectedTextImageFixture(t, "original article", "excerpt", "")
	mutateImageFrontierNode(t, &graph, "excerpt", func(data map[string]any) {
		delete(data, "text")
		data["content"] = "content-only excerpt"
	})
	graph.Nodes = append(graph.Nodes, json.RawMessage(`{"id":"earlier","type":"rh-text","data":{"text":"earlier unrelated prompt"}}`))
	graph.Edges = append(graph.Edges, domain.Edge{Source: "earlier", Target: "original"})
	if got := imageRequestTexts(frozenRequest(t, selectedTextImageTask(t, s, graph))); !reflect.DeepEqual(got, []string{"content-only excerpt"}) {
		t.Fatal("current content or multiple text ancestors handled incorrectly", got)
	}
}
