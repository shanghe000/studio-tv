package domain

import (
	"encoding/json"
	"testing"
)

func TestGraphTargetClosureAndDAGValidation(t *testing.T) {
	graph := json.RawMessage(`{"nodes":[{"id":"group","type":"group"},{"id":"image","parentNode":"group","type":"rh-image","data":{}},{"id":"video","parentId":"group","type":"rh-video","data":{}},{"id":"other","type":"rh-text","data":{}}],"edges":[{"source":"image","target":"video"}]}`)
	nodes, _, _, err := ParseGraph(CanvasCommand{ProjectID: "prj", TargetType: "GROUP", TargetID: "group", Graph: graph})
	if err != nil || len(nodes) != 3 || nodes[1].ID != "image" || nodes[2].ID != "video" {
		t.Fatalf("group order %#v %v", nodes, err)
	}
	nodes, _, _, err = ParseGraph(CanvasCommand{ProjectID: "prj", TargetType: "NODE", TargetID: "video", Graph: graph})
	if err != nil || len(nodes) != 1 || nodes[0].ID != "video" {
		t.Fatalf("node target %#v %v", nodes, err)
	}
	for _, bad := range []string{`{"nodes":[{"id":"a"},{"id":"a"}],"edges":[]}`, `{"nodes":[{"id":"a"},{"id":"b"}],"edges":[{"source":"a","target":"b"},{"source":"b","target":"a"}]}`, `{"nodes":[{"id":"a"}],"edges":[{"source":"missing","target":"a"}]}`} {
		if _, _, _, err = ParseGraph(CanvasCommand{ProjectID: "prj", TargetType: "CANVAS", Graph: json.RawMessage(bad)}); err == nil {
			t.Fatalf("accepted invalid graph %s", bad)
		}
	}
}
