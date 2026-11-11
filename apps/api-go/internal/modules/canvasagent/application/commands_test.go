package application

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestCanvasCommandHashFreezesPathPreconditionAndBody(t *testing.T) {
	a := json.RawMessage(`{"schemaVersion":"1","operations":[{"type":"node.move","nodeId":"node_a","position":{"x":1,"y":2}}]}`)
	b := json.RawMessage(`{"operations":[{"nodeId":"node_a","position":{"y":2,"x":1},"type":"node.move"}],"schemaVersion":"1"}`)
	first, err := CanvasCommandHash("project_a", 1, a)
	second, otherErr := CanvasCommandHash("project_a", 1, b)
	if err != nil || otherErr != nil || first != second {
		t.Fatal("canonical object order changed request identity")
	}
	for _, input := range []struct {
		project  string
		revision int64
		body     json.RawMessage
	}{
		{"project_b", 1, a}, {"project_a", 2, a}, {"project_a", 1, json.RawMessage(`{"schemaVersion":"1","operations":[{"type":"node.move","nodeId":"node_a","position":{"x":3,"y":2}}]}`)},
	} {
		hash, err := CanvasCommandHash(input.project, input.revision, input.body)
		if err != nil || hash == first {
			t.Fatal("path, If-Match or body change retained the old request identity")
		}
	}
	if _, err := NormalizeCommandKey(uuid.Nil.String()); err == nil {
		t.Fatal("nil UUID accepted as an idempotency key")
	}
}
