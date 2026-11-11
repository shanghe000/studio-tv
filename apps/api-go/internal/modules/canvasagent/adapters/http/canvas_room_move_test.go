package http

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestRoomCompactMoveWireIsLosslessAndStrict(t *testing.T) {
	const proposed = `M["r","b","c","0123456789abcdef0123456789abcdef","00000000-0000-4000-a000-000000000001",4,7,7,false,[["n1",0.000001,-123.45678901234568],["n2",1e-7,2]]]`
	w, e := decodeMove([]byte(proposed), nil)
	if e != nil || w.RequestID != "r" || w.BaseRevision != 7 {
		t.Fatal(w, e)
	}
	wanted := `{"schemaVersion":"1","batchId":"b","clientId":"c","observedRevision":4,"baseRevision":7,"operations":[{"type":"node.patch","nodeId":"n1","set":[{"path":["position","x"],"value":0.000001},{"path":["position","y"],"value":-123.45678901234568}],"unset":[]},{"type":"node.patch","nodeId":"n2","set":[{"path":["position","x"],"value":1e-7},{"path":["position","y"],"value":2}],"unset":[]}]}`
	if string(w.Body) != wanted {
		t.Fatalf("digest material changed: %s", w.Body)
	}
	short := strings.Replace(proposed, `"c","0123456789abcdef0123456789abcdef","00000000-0000-4000-a000-000000000001"`, `null,null,null`, 1)
	reused, e := decodeMove([]byte(short), &w.binding)
	if e != nil || !bytes.Equal(reused.Body, w.Body) || reused.Proof != w.Proof || reused.Lease != w.Lease {
		t.Fatal("ambiguous compact binding")
	}
	for _, bad := range []string{
		short, strings.Replace(short, "null,null,null", `"c",null,null`, 1),
		strings.Replace(proposed, "4,7,7", "-1,7,7", 1),
		strings.Replace(proposed, "1e-7", "1e999999", 1),
		strings.Replace(proposed, "0.000001", `"0"`, 1),
		strings.Replace(proposed, "false", "null", 1),
		strings.Replace(proposed, `["n2",1e-7,2]`, `["n2",1e-7,2,"ignored"]`, 1),
		strings.Replace(proposed, `["n2",1e-7,2]`, strings.Repeat(`["n",1,2],`, 2048)+`["n",1,2]`, 1),
		proposed + "null", strings.Repeat("a", roomFrameLimit+1),
	} {
		if _, err := decodeMove([]byte(bad), nil); err == nil {
			t.Fatal("accepted malformed movement")
		}
	}
	// A new field or even an explicitly empty order list must not be erased.
	f := roomEvent{Type: "event", Event: "canvas.delta", ID: "6", Data: json.RawMessage(`{"schemaVersion":"1","kind":"DELTA","projectId":"p","graphRevision":4,"eventCursor":"6","updatedAt":"2026-11-04T00:00:00Z","nodeExecutionAvailable":true,"nodeStates":[{"nodeId":"n"}],"fromRevision":3,"delta":{"positions":[{"id":"n","x":3.2,"y":4}],"upsertNodes":[],"upsertEdges":[],"removeNodeIds":[],"removeEdgeIds":[]}}`)}
	if got := string(compactMoveEvent("p", f)); got != `E["6",3,4,"2026-11-04T00:00:00Z",true,[{"nodeId":"n"}],[["n",3.2,4]]]` {
		t.Fatal(got)
	}
	for _, fragment := range []string{`"nodeOrder":[],`, `"edgeOrder":null,`, `"anotherField":false,`} {
		mixed := f
		mixed.Data = []byte(strings.Replace(string(f.Data), `"positions":`, fragment+`"positions":`, 1))
		if compactMoveEvent("p", mixed) != nil {
			t.Fatal("unknown/ordered delta discarded")
		}
	}
}
