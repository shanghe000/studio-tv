package domain

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

const guardGraph = `{"nodes":[
 {"id":"seed","type":"rh-text","position":{"x":0,"y":0},"data":{"text":"seed text"}},
 {"id":"image","type":"rh-image","data":{"sourceObjects":["rhtv-asset:image_a","rhtv-asset:image_b"],"imageOrder":["image::rhtv-asset:image_b","image::rhtv-asset:image_a"]}},
 {"id":"audio","type":"rh-audio","data":{"audioUrl":"rhtv-asset:audio_a"}},
 {"id":"target","type":"rh-video","data":{"params":{"prompt":"frozen prompt"},"capabilityRef":"fixture-video","capabilityVersion":"1","output":[{"outputId":"previous","url":"rhtv-asset:old"}],"historyStorage":{"source":"remote","historyId":"old_execution"}}},
 {"id":"other","type":"rh-text","data":{"text":"unrelated text"}}
 ],"edges":[
 {"id":"seed_image","source":"seed","target":"image"},
 {"id":"image_target","source":"image","target":"target","conditioningRole":"FIRST_FRAME","sourceHandle":"output","targetHandle":"input"},
 {"id":"audio_target","source":"audio","target":"target","conditioningRole":"AUDIO_INPUT"},
 {"id":"outgoing","source":"target","target":"other"}
 ],"viewport":{"x":1,"y":2,"zoom":1}}`

func mutateGuardGraph(t *testing.T, mutate func(map[string]any)) json.RawMessage {
	t.Helper()
	var graph map[string]any
	if json.Unmarshal([]byte(guardGraph), &graph) != nil {
		t.Fatal("invalid guard fixture")
	}
	mutate(graph)
	raw, err := json.Marshal(graph)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func guardNode(graph map[string]any, index int) map[string]any {
	return graph["nodes"].([]any)[index].(map[string]any)
}

func requireGuard(t *testing.T, raw json.RawMessage) (string, []string) {
	t.Helper()
	guard, ids, err := CanvasGuard(raw, "target")
	if err != nil || len(guard) != 64 {
		t.Fatal("valid guard was not a SHA-256 acceptance record", guard, ids, err)
	}
	return guard, ids
}

func TestCanvasGuardTracksFullInputClosureButIgnoresLayoutAndDisplayState(t *testing.T) {
	base, ids := requireGuard(t, json.RawMessage(guardGraph))
	if !reflect.DeepEqual(ids, []string{"seed", "image", "audio", "target"}) {
		t.Fatal("guard lost recursive input provenance or changed source order", ids)
	}
	changed := mutateGuardGraph(t, func(graph map[string]any) {
		graph["viewport"] = map[string]any{"x": 99, "y": 88, "zoom": 2}
		for index := 0; index < 4; index++ {
			node := guardNode(graph, index)
			node["position"] = map[string]any{"x": 900, "y": 800}
			node["style"] = map[string]any{"width": 900}
			data := node["data"].(map[string]any)
			for _, key := range []string{"title", "label", "modelName", "modelNameEn", "status", "taskId", "errorMsg", "testMode", "customBadgeText", "progress", "__rhtv"} {
				data[key] = "presentation only"
			}
		}
		guardNode(graph, 4)["data"] = map[string]any{"text": "different unrelated text"}
		graph["edges"].([]any)[3].(map[string]any)["sourceHandle"] = "unrelated outgoing handle"
	})
	actual, actualIDs := requireGuard(t, changed)
	if actual != base || !reflect.DeepEqual(actualIDs, ids) {
		t.Fatal("layout or transient state detached a valid bound run", base, actual, actualIDs)
	}
}

func TestCanvasGuardDetectsInputOutputHistoryAndUnknownDataEdits(t *testing.T) {
	base, _ := requireGuard(t, json.RawMessage(guardGraph))
	mutations := map[string]func(map[string]any){
		"recursive upstream text": func(g map[string]any) { guardNode(g, 0)["data"].(map[string]any)["text"] = "edited seed" },
		"source media": func(g map[string]any) {
			guardNode(g, 1)["data"].(map[string]any)["sourceObjects"] = []string{"rhtv-asset:replacement"}
		},
		"explicit media order": func(g map[string]any) {
			guardNode(g, 1)["data"].(map[string]any)["imageOrder"] = []string{"image::rhtv-asset:image_a", "image::rhtv-asset:image_b"}
		},
		"target prompt": func(g map[string]any) {
			guardNode(g, 3)["data"].(map[string]any)["params"] = map[string]any{"prompt": "new prompt"}
		},
		"precise model version":  func(g map[string]any) { guardNode(g, 3)["data"].(map[string]any)["capabilityVersion"] = "2" },
		"edited previous output": func(g map[string]any) { guardNode(g, 3)["data"].(map[string]any)["output"] = []any{} },
		"history selection": func(g map[string]any) {
			guardNode(g, 3)["data"].(map[string]any)["historyStorage"] = map[string]any{"historyId": "selected_execution"}
		},
		"unknown future input": func(g map[string]any) {
			guardNode(g, 3)["data"].(map[string]any)["futureInput"] = map[string]any{"value": 1}
		},
		"node modality":        func(g map[string]any) { guardNode(g, 3)["type"] = "rh-image" },
		"conditioning role":    func(g map[string]any) { g["edges"].([]any)[1].(map[string]any)["conditioningRole"] = "LAST_FRAME" },
		"input handle":         func(g map[string]any) { g["edges"].([]any)[1].(map[string]any)["targetHandle"] = "last-frame" },
		"upstream graph order": func(g map[string]any) { nodes := g["nodes"].([]any); nodes[1], nodes[2] = nodes[2], nodes[1] },
		"incoming edge order":  func(g map[string]any) { edges := g["edges"].([]any); edges[1], edges[2] = edges[2], edges[1] },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			actual, _ := requireGuard(t, mutateGuardGraph(t, mutate))
			if actual == base {
				t.Fatal("semantic input/output edit retained obsolete acceptance guard")
			}
		})
	}
}

func TestMeasuredPhaseIsPresentationOnlyButNestedParametersRemainInputs(t *testing.T) {
	base, _ := requireGuard(t, json.RawMessage(guardGraph))
	view := mutateGuardGraph(t, func(g map[string]any) {
		guardNode(g, 3)["data"].(map[string]any)["progressDetail"] = map[string]any{"phase": "sampling", "scope": "SAMPLING"}
	})
	if got, _ := requireGuard(t, view); got != base {
		t.Fatal("measured phase detached the active task")
	}
	input := mutateGuardGraph(t, func(g map[string]any) {
		guardNode(g, 3)["data"].(map[string]any)["params"] = map[string]any{"progressDetail": "user input"}
	})
	if got, _ := requireGuard(t, input); got == base {
		t.Fatal("nested input was ignored")
	}
}

func TestCanvasGuardMatchesNativeAndPersistedConditioningRoleEncoding(t *testing.T) {
	base, _ := requireGuard(t, json.RawMessage(guardGraph))
	encoded := mutateGuardGraph(t, func(g map[string]any) {
		delete(g["edges"].([]any)[1].(map[string]any), "conditioningRole")
		meta := map[string]any{"id": "rhtv_meta_v1", "type": "__rhtv_meta", "data": map[string]any{"edges": map[string]any{"image_target": map[string]any{"conditioningRole": "FIRST_FRAME"}}, "meta": map[string]any{"name": "ignored"}}}
		g["nodes"] = append([]any{meta}, g["nodes"].([]any)...)
	})
	actual, ids := requireGuard(t, encoded)
	if actual != base || !reflect.DeepEqual(ids, []string{"seed", "image", "audio", "target"}) {
		t.Fatal("persisted edge sidecar changed native input authority", actual, ids)
	}
	changed := strings.Replace(string(encoded), `"FIRST_FRAME"`, `"LAST_FRAME"`, 1)
	other, _ := requireGuard(t, json.RawMessage(changed))
	if other == base {
		t.Fatal("persisted edge role edit did not detach frozen input")
	}
}

func TestCanvasGuardPreservesJSONNumberPrecisionAndRejectsMissingEvidence(t *testing.T) {
	a := json.RawMessage(`{"nodes":[{"id":"target","type":"rh-text","data":{"seed":9007199254740992}}],"edges":[]}`)
	b := json.RawMessage(strings.Replace(string(a), "9007199254740992", "9007199254740993", 1))
	first, _ := requireGuard(t, a)
	second, _ := requireGuard(t, b)
	if first == second {
		t.Fatal("adjacent integer inputs collapsed through float64")
	}
	for _, raw := range []string{
		`{`, `{"nodes":null,"edges":[]}`, `{"nodes":[],"edges":null}`,
		`{"nodes":[{"id":"other"}],"edges":[]}`,
		`{"nodes":[{"id":"target"},{"id":"target"}],"edges":[]}`,
		`{"nodes":[{"id":"target"}],"edges":[{"source":"missing","target":"target"}]}`,
	} {
		guard, ids, err := CanvasGuard(json.RawMessage(raw), "target")
		if !errors.Is(err, ErrInvalid) || guard != "" || ids != nil {
			t.Fatal("missing or corrupt graph evidence produced an acceptance guard", raw, guard, ids, err)
		}
	}
}

func TestCanvasGuardNativeDisplayDimensionsAreNotModelInputs(t *testing.T) {
	base := json.RawMessage(`{"nodes":[{"id":"n","type":"rh-image","data":{"width":300,"height":268,"params":{"width":1024}}}],"edges":[]}`)
	want, _, err := CanvasGuard(base, "n")
	if err != nil {
		t.Fatal(err)
	}
	display := json.RawMessage(`{"nodes":[{"id":"n","type":"rh-image","data":{"width":640,"height":800,"opResize":true,"params":{"width":1024}}}],"edges":[]}`)
	got, _, err := CanvasGuard(display, "n")
	if err != nil || got != want {
		t.Fatal("native media load/resize invalidates execution", err)
	}
	model := json.RawMessage(`{"nodes":[{"id":"n","type":"rh-image","data":{"width":300,"height":268,"params":{"width":2048}}}],"edges":[]}`)
	got, _, err = CanvasGuard(model, "n")
	if err != nil || got == want {
		t.Fatal("model output dimension change ignored", err)
	}
}

func TestCanvasGuardNativeExecutionTimingIsPresentationOnly(t *testing.T) {
	base := json.RawMessage(`{"nodes":[{"id":"target","type":"rh-image","data":{"params":{"prompt":"fox"}}}],"edges":[]}`)
	want, _ := requireGuard(t, base)
	for _, change := range []struct {
		fragment string
		same     bool
	}{
		{`"estimateTaskId":"task-1","generationStartedAt":1791297866546,"estimatedSeconds":120,"params":{"prompt":"fox"}`, true},
		{`"params":{"prompt":"fox","estimatedSeconds":120}`, false},
		{`"output":[{"estimatedSeconds":120}],"params":{"prompt":"fox"}`, false},
	} {
		raw := json.RawMessage(strings.Replace(string(base), `"params":{"prompt":"fox"}`, change.fragment, 1))
		got, _ := requireGuard(t, raw)
		if (got == want) != change.same {
			t.Fatal("timing field authority mismatch", change.fragment)
		}
	}
}
