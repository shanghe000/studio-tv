package domain

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestCanvasMaterialClassificationPreservesGenerationConfiguration(t *testing.T) {
	for _, row := range []struct {
		name, kind, data string
		material         bool
	}{
		{"explicit upload overrides stale model", "rh-image", `{"isUpload":true,"modelCode":"retained","params":{"prompt":"old"}}`, true},
		{"legacy production image upload shape", "rh-image", `{"label":"Image","title":"Image","width":900,"height":1200,"status":"finished","subType":"text-image","aspectRatio":"3:4","sourceObjects":["rhtv-asset:img"]}`, true},
		{"legacy image reference mode", "rh-image", `{"subType":"image-image","sourceObjects":["rhtv-asset:img"],"params":{},"routerParameters":null}`, true},
		{"legacy video upload", "rh-video", `{"subType":"text-video","sourceObjects":["rhtv-asset:video"]}`, true},
		{"legacy audio upload", "rh-audio", `{"subType":"audio-audio","sourceObjects":["rhtv-asset:audio"]}`, true},
		{"ordinary empty image generation", "rh-image", `{}`, false},
		{"explicit model result remains executable", "rh-image", `{"modelCode":"real-model","sourceObjects":["rhtv-asset:img"],"historyStorage":{"historyId":"result"}}`, false},
		{"capability selection remains executable", "rh-video", `{"capabilityRef":"real-model","sourceObjects":["rhtv-asset:video"]}`, false},
		{"authored prompt remains executable", "rh-image", `{"sourceObjects":["rhtv-asset:img"],"prompt":"edit the image"}`, false},
		{"empty authored parameter retains compatibility", "rh-image", `{"sourceObjects":["rhtv-asset:img"],"params":{"prompt":""}}`, false},
		{"old generation params remain executable", "rh-image", `{"sourceObjects":["rhtv-asset:img"],"params":{"imageUrls":["rhtv-asset:old-input"]}}`, false},
		{"tool remains executable", "rh-image", `{"sourceObjects":["rhtv-asset:img"],"toolsType":"image-cutout"}`, false},
		{"tool subtype remains executable", "rh-image", `{"sourceObjects":["rhtv-asset:img"],"subType":"image-enhance"}`, false},
		{"batch configuration remains executable", "rh-image", `{"sourceObjects":["rhtv-asset:img"],"generateNum":1}`, false},
		{"text references are not media material", "rh-text", `{"sourceObjects":["rhtv-asset:img"]}`, false},
		{"empty source array is no evidence", "rh-image", `{"sourceObjects":[]}`, false},
		{"object source conservatively preserves compatibility", "rh-image", `{"sourceObjects":{"assetId":"img"}}`, false},
		{"unknown source array is no material evidence", "rh-image", `{"sourceObjects":[null,1,{}]}`, false},
		{"whitespace source is no material evidence", "rh-image", `{"sourceObjects":["  "]}`, false},
	} {
		t.Run(row.name, func(t *testing.T) {
			var data map[string]json.RawMessage
			if err := json.Unmarshal([]byte(row.data), &data); err != nil {
				t.Fatal(err)
			}
			if got := IsCanvasMaterialNode(Node{Type: row.kind, Data: data}); got != row.material {
				t.Fatalf("material=%v, want %v", got, row.material)
			}
		})
	}
}

func TestGroupAndCanvasExcludeMaterialsOnlyFromExecutionTargets(t *testing.T) {
	graph := json.RawMessage(`{"nodes":[{"id":"group","type":"group"},{"id":"upload","parentId":"group","type":"rh-image","data":{"isUpload":true,"modelCode":"stale-model","sourceObjects":["rhtv-asset:img"]}},{"id":"legacy","parentNode":"group","type":"rh-image","data":{"subType":"text-image","sourceObjects":["rhtv-asset:img"]}},{"id":"generated","parentId":"group","type":"rh-image","data":{"modelCode":"generation-model","sourceObjects":["rhtv-asset:img"]}},{"id":"target","parentId":"group","type":"rh-image","data":{"params":{"prompt":"edit both references"}}}],"edges":[{"source":"upload","target":"target"},{"source":"legacy","target":"target"}]}`)
	for _, kind := range []string{"GROUP", "CANVAS"} {
		nodes, raw, edges, err := ParseGraph(CanvasCommand{ProjectID: "project", TargetType: kind, TargetID: "group", Graph: graph})
		if err != nil {
			t.Fatal(err)
		}
		if len(nodes) != 3 || nodes[0].ID != "group" || nodes[1].ID != "generated" || nodes[2].ID != "target" {
			t.Fatalf("unexpected execution targets for %s: %+v", kind, nodes)
		}
		if len(raw) != 5 || len(edges) != 2 || len(raw["upload"]) == 0 || len(raw["legacy"]) == 0 {
			t.Fatal("excluded materials were removed from input graph evidence")
		}
	}
	for _, target := range []string{"upload", "legacy"} {
		if _, _, _, err := ParseGraph(CanvasCommand{ProjectID: "project", TargetType: "NODE", TargetID: target, Graph: graph}); !errors.Is(err, ErrMaterialOnly) || !errors.Is(err, ErrInvalid) {
			t.Fatal("standalone material did not produce an explicit compatible refusal", target, err)
		}
	}
}
