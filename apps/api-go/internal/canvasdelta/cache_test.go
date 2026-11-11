package canvasdelta

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func shape(id string, x int, data string) string {
	return fmt.Sprintf(`{"id":"%s","type":"rh-text","position":{"x":%d,"y":3},"data":%s}`, id, x, data)
}
func graphFor(nodes, edges string) []byte {
	return []byte(`{"schemaVersion":"1","viewport":{"x":1,"y":2,"zoom":1},"nodes":[` + nodes + `],"edges":[` + edges + `]}`)
}
func TestDeltaFoldedOrderedCanonicalEditsAndGaps(t *testing.T) {
	c := New()
	n1 := shape("a", 1, `{"text":"private"}`)
	n2 := shape("b", 3, `{}`)
	first := graphFor(n1+","+n2, "")
	moved := graphFor(shape("a", 4, `{"text":"private"}`)+","+n2, "")
	third := graphFor(n2+","+shape("a", 4, `{"text":"next"}`), `{"id":"edge","source":"a","target":"b","sourceHandle":null,"targetHandle":null}`)
	c.Record("p", 2, 3, moved, third)
	c.Record("p", 1, 2, first, moved)
	d, ok := c.Read("p", 1, 2, moved)
	if !ok || len(d.Positions) != 1 || d.Positions[0].X != 4 || d.Positions[0].Y != 3 || d.Positions[0].ID != "a" || len(d.UpsertNodes) != 0 {
		t.Fatal(d)
	}
	raw, _ := json.Marshal(d)
	if strings.Contains(string(raw), "private") {
		t.Fatal("emitted untouched text")
	}
	d, ok = c.Read("p", 1, 3, third)
	if !ok || len(d.UpsertNodes) != 1 || len(d.UpsertEdges) != 1 || strings.Join(d.NodeOrder, ",") != "b,a" {
		t.Fatal(d)
	}
	for _, attempt := range []struct {
		project  string
		from, to int64
		graph    []byte
	}{{"q", 1, 3, third}, {"p", 1, 4, third}, {"p", 1, 3, moved}, {"p", 0, 2, first}} {
		if _, ok = c.Read(attempt.project, attempt.from, attempt.to, attempt.graph); ok {
			t.Fatal("unexpected hit", attempt)
		}
	}
	if _, ok = New().Read("p", 1, 2, moved); ok {
		t.Fatal("new process had history")
	}
	// Exact revisions alone cannot join a mixed chain with a different intermediate document.
	c.Record("p", 2, 3, first, third)
	if _, ok = c.Read("p", 1, 3, third); ok {
		t.Fatal("broken hash chain accepted")
	}
}
func TestUnrepresentableBoundsExpiryAndTaskWriteback(t *testing.T) {
	c := New()
	base := graphFor(shape("n", 0, `{"text":"before"}`), "")
	variants := [][]byte{graphFor(shape("n", 0, `{"taskId":"task","output":["value"]}`), ""), graphFor(shape("n", 0, `{"text":"`+strings.Repeat("a", 10000)+`"}`), ""), []byte(strings.Replace(string(base), `"zoom":1`, `"zoom":2`, 1))}
	many := []string{}
	for i := 0; i <= maxTouched; i++ {
		many = append(many, shape(fmt.Sprint(i), 0, `{}`))
	}
	variants = append(variants, graphFor(strings.Join(many, ","), ""))
	for _, next := range variants {
		c.Record("p", 1, 2, base, next)
		if _, ok := c.Read("p", 1, 2, next); ok {
			t.Fatal("unsupported change served as delta")
		}
	}
	move := graphFor(shape("n", 3, `{"text":"before"}`), "")
	c.Record("p", 1, 2, base, move)
	c.fifo.Front().Value.(*entry).at = time.Now().Add(-2 * maxAge)
	if c.Has("p", 1, 2) {
		t.Fatal("expired index retained")
	}
}
func TestPendingCommitNotificationCannotExposeOrImplyCommittedData(t *testing.T) {
	c := New()
	first := graphFor(shape("a", 0, `{}`), "")
	second := graphFor(shape("a", 9, `{}`), "")
	finish := c.Begin("p", 2)
	if !c.Has("p", 1, 2) {
		t.Fatal("listener missed committing writer")
	}
	if _, ok := c.Read("p", 1, 2, second); ok {
		t.Fatal("pending index escaped before commit")
	}
	finish()
	if c.Has("p", 1, 2) {
		t.Fatal("rollback left live hint")
	}
	finish = c.Begin("p", 2)
	ready := make(chan struct{})
	go func() { c.WaitForCommit(context.Background(), "p", 1, 2); close(ready) }()
	c.Record("p", 1, 2, first, second)
	finish()
	<-ready
	if _, ok := c.Read("p", 1, 2, second); !ok {
		t.Fatal("committed delta unavailable")
	}
}
func TestDeltaDoesNotEmitOversizeMergedRows(t *testing.T) {
	var a, b []string
	for i := 0; i < 32; i++ {
		a = append(a, shape(fmt.Sprint(i), 0, `{"text":"old"}`))
		b = append(b, shape(fmt.Sprint(i), 0, `{"text":"`+strings.Repeat("new", 1000)+`"}`))
	}
	before, after := graphFor(strings.Join(a, ","), ""), graphFor(strings.Join(b, ","), "")
	c := New()
	c.Record("p", 1, 2, before, after)
	if !c.Has("p", 1, 2) {
		t.Fatal("expected index before wire size check")
	}
	if _, ok := c.Read("p", 1, 2, after); ok {
		t.Fatal("oversized response escaped")
	}
}
