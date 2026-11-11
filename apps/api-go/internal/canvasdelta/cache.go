// Package canvasdelta indexes eligible committed operations. It retains object
// IDs, revision numbers and hashes, never graph JSON, prompts or media URLs.
package canvasdelta

import (
	"bytes"
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/json"
	"sort"
	"sync"
	"time"
)

const (
	maxGraphBytes = 2 << 20
	maxDeltaBytes = 64 << 10
	maxTouched    = 64
	maxChain      = 24
	maxEntries    = 1024
	maxIndexBytes = 4 << 20
	maxAge        = 5 * time.Minute
)

type Position struct {
	ID string  `json:"id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
}
type Delta struct {
	Positions     []Position        `json:"positions"`
	UpsertNodes   []json.RawMessage `json:"upsertNodes"`
	RemoveNodeIDs []string          `json:"removeNodeIds"`
	UpsertEdges   []json.RawMessage `json:"upsertEdges"`
	RemoveEdgeIDs []string          `json:"removeEdgeIds"`
	NodeOrder     []string          `json:"nodeOrder,omitempty"`
	EdgeOrder     []string          `json:"edgeOrder,omitempty"`
}
type graph struct {
	meta         map[string]json.RawMessage
	nodes, edges map[string]json.RawMessage
	ns, es       []string
}

func parse(raw []byte) (*graph, bool) {
	if len(raw) == 0 || len(raw) > maxGraphBytes {
		return nil, false
	}
	g := graph{}
	if json.Unmarshal(raw, &g.meta) != nil || string(g.meta["schemaVersion"]) != "\"1\"" {
		return nil, false
	}
	unpack := func(key string, max int) (map[string]json.RawMessage, []string, bool) {
		var rows []json.RawMessage
		if json.Unmarshal(g.meta[key], &rows) != nil || rows == nil || len(rows) > max {
			return nil, nil, false
		}
		delete(g.meta, key)
		items := make(map[string]json.RawMessage, len(rows))
		ids := make([]string, 0, len(rows))
		for _, row := range rows {
			var o struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(row, &o) != nil || o.ID == "" || len(o.ID) > 200 || items[o.ID] != nil {
				return nil, nil, false
			}
			items[o.ID] = row
			ids = append(ids, o.ID)
		}
		return items, ids, true
	}
	var ok bool
	g.nodes, g.ns, ok = unpack("nodes", 501)
	if !ok {
		return nil, false
	}
	g.edges, g.es, ok = unpack("edges", 2000)
	if !ok {
		return nil, false
	}
	return &g, true
}
func equalFields(a, b map[string]json.RawMessage) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if !bytes.Equal(v, b[k]) {
			return false
		}
	}
	return true
}
func equalIDs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
func movement(a, b json.RawMessage) bool {
	var x, y map[string]json.RawMessage
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil || bytes.Equal(x["position"], y["position"]) {
		return false
	}
	delete(x, "position")
	delete(y, "position")
	return equalFields(x, y)
}
func simpleNode(raw json.RawMessage) bool {
	if len(raw) > 8192 {
		return false
	}
	var n struct {
		Type string                     `json:"type"`
		Data map[string]json.RawMessage `json:"data"`
	}
	if json.Unmarshal(raw, &n) != nil || n.Data == nil {
		return false
	}
	switch n.Type {
	case "group", "rh-text", "rh-image", "rh-video", "rh-audio", "rh-comment", "rh-stack", "__rhtv_meta":
	default:
		return false
	}
	for _, k := range []string{"taskId", "executionId", "estimateTaskId", "nodeOutputHistory", "historyStorage", "output", "generationStartedAt", "progress", "progressDetail", "errorMsg", "userPromptSnapshot", "scriptBodyStorage", "execution"} {
		if _, found := n.Data[k]; found {
			return false
		}
	}
	if status := n.Data["status"]; status != nil && string(status) != "\"idle\"" {
		return false
	}
	return true
}

type key struct {
	project string
	rev     int64
}
type entry struct {
	key                     key
	baseDigest, digest      [32]byte
	positions, nodes, edges []string
	nodeOrder, edgeOrder    bool
	size                    int
	at                      time.Time
}
type Cache struct {
	pending map[key]chan struct{}
	mu      sync.Mutex
	entries map[key]*list.Element
	fifo    list.List
	size    int
}

func New() *Cache { return &Cache{entries: map[key]*list.Element{}} }
func (c *Cache) remove(el *list.Element) {
	e := el.Value.(*entry)
	delete(c.entries, e.key)
	c.size -= e.size
	c.fifo.Remove(el)
}
func (c *Cache) prune(now time.Time) {
	for head := c.fifo.Front(); head != nil; head = c.fifo.Front() {
		if c.size <= maxIndexBytes && c.fifo.Len() <= maxEntries && now.Sub(head.Value.(*entry).at) < maxAge {
			break
		}
		c.remove(head)
	}
}

// Record must be called only after the operation transaction committed. Both
// graphs come from PostgreSQL, including its canonical writeback triggers.
func (c *Cache) Record(project string, from, to int64, before, after []byte) {
	if c == nil || to != from+1 || from < 1 {
		return
	}
	a, ok := parse(before)
	if !ok {
		return
	}
	b, ok := parse(after)
	if !ok || !equalFields(a.meta, b.meta) {
		return
	}
	e := &entry{key: key{project, to}, baseDigest: sha256.Sum256(before), digest: sha256.Sum256(after), nodeOrder: !equalIDs(a.ns, b.ns), edgeOrder: !equalIDs(a.es, b.es)}
	for id, prior := range a.nodes {
		now := b.nodes[id]
		if bytes.Equal(prior, now) {
			continue
		}
		if now != nil && movement(prior, now) {
			e.positions = append(e.positions, id)
			continue
		}
		if !simpleNode(prior) || now != nil && !simpleNode(now) {
			return
		}
		e.nodes = append(e.nodes, id)
	}
	for id, now := range b.nodes {
		if a.nodes[id] == nil {
			if !simpleNode(now) {
				return
			}
			e.nodes = append(e.nodes, id)
		}
	}
	for id, prior := range a.edges {
		if !bytes.Equal(prior, b.edges[id]) {
			e.edges = append(e.edges, id)
		}
	}
	for id := range b.edges {
		if a.edges[id] == nil {
			e.edges = append(e.edges, id)
		}
	}
	if len(e.positions)+len(e.nodes)+len(e.edges) > maxTouched {
		return
	}
	e.size = 256 + len(project)
	for _, ids := range [][]string{e.positions, e.nodes, e.edges} {
		for _, id := range ids {
			e.size += 32 + len(id)
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e.at = time.Now()
	if prev := c.entries[e.key]; prev != nil {
		c.remove(prev)
	}
	c.entries[e.key] = c.fifo.PushBack(e)
	c.size += e.size
	c.prune(e.at)
}

// Read uses the revision and graph from this request's authorized, consistent
// live snapshot. A discontinuity or differing head digest always returns miss.
func (c *Cache) Read(project string, from, to int64, canonical []byte) (*Delta, bool) {
	if c == nil || from < 1 || to <= from || to-from > maxChain {
		return nil, false
	}
	c.mu.Lock()
	c.prune(time.Now())
	chain := make([]*entry, 0, to-from)
	for step := int64(1); step <= to-from; step++ {
		n := from + step
		el := c.entries[key{project, n}]
		if el == nil {
			c.mu.Unlock()
			return nil, false
		}
		chain = append(chain, el.Value.(*entry))
	}
	c.mu.Unlock()
	for i := 1; i < len(chain); i++ {
		if chain[i-1].digest != chain[i].baseDigest {
			return nil, false
		}
	}
	if chain[len(chain)-1].digest != sha256.Sum256(canonical) {
		return nil, false
	}
	g, ok := parse(canonical)
	if !ok {
		return nil, false
	}
	nodes, edges := map[string]bool{}, map[string]bool{}
	nodeOrder, edgeOrder := false, false
	for _, e := range chain {
		for _, id := range e.positions {
			if _, ok := nodes[id]; !ok {
				nodes[id] = false
			}
		}
		for _, id := range e.nodes {
			nodes[id] = true
		}
		for _, id := range e.edges {
			edges[id] = true
		}
		nodeOrder = nodeOrder || e.nodeOrder
		edgeOrder = edgeOrder || e.edgeOrder
	}
	if len(nodes)+len(edges) > maxTouched {
		return nil, false
	}
	d := Empty()
	for _, id := range g.ns {
		full, found := nodes[id]
		if !found {
			continue
		}
		row := g.nodes[id]
		delete(nodes, id)
		if full {
			d.UpsertNodes = append(d.UpsertNodes, row)
		} else {
			var n struct {
				Position struct{ X, Y *float64 } `json:"position"`
			}
			if json.Unmarshal(row, &n) != nil || n.Position.X == nil || n.Position.Y == nil {
				return nil, false
			}
			d.Positions = append(d.Positions, Position{id, *n.Position.X, *n.Position.Y})
		}
	}
	for id := range nodes {
		d.RemoveNodeIDs = append(d.RemoveNodeIDs, id)
	}
	sort.Strings(d.RemoveNodeIDs)
	for _, id := range g.es {
		if edges[id] {
			delete(edges, id)
			d.UpsertEdges = append(d.UpsertEdges, g.edges[id])
		}
	}
	for id := range edges {
		d.RemoveEdgeIDs = append(d.RemoveEdgeIDs, id)
	}
	sort.Strings(d.RemoveEdgeIDs)
	if nodeOrder {
		d.NodeOrder = g.ns
	}
	if edgeOrder {
		d.EdgeOrder = g.es
	}
	body, err := json.Marshal(d)
	if err != nil || len(body) > maxDeltaBytes {
		return nil, false
	}
	return &d, true
}

// Has is a hint for SSE. Read still verifies the complete chain against the
// authorized head. An eviction or another process only costs a full fetch.
func (c *Cache) Has(project string, from, to int64) bool {
	if c == nil || from < 1 || to <= from || to-from > maxChain {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.prune(time.Now())
	for step := int64(1); step <= to-from; step++ {
		i := from + step
		if c.entries[key{project, i}] == nil && c.pending[key{project, i}] == nil {
			return false
		}
	}
	return true
}

// Begin records only a short-lived project/revision notification. PostgreSQL may
// wake a subscriber before the writer's COMMIT returns to Go. The notification
// lets that subscriber wait for the verified index without exposing buffered
// data or placing graph decoding inside the project's write transaction.
func (c *Cache) Begin(project string, rev int64) func() {
	if c == nil {
		return func() {}
	}
	k := key{project, rev}
	ch := make(chan struct{})
	c.mu.Lock()
	if c.pending == nil {
		c.pending = map[key]chan struct{}{}
	}
	if len(c.pending) >= 128 || c.pending[k] != nil {
		c.mu.Unlock()
		return func() {}
	}
	c.pending[k] = ch
	c.mu.Unlock()
	return func() {
		c.mu.Lock()
		if c.pending[k] == ch {
			delete(c.pending, k)
			close(ch)
		}
		c.mu.Unlock()
	}
}
func (c *Cache) WaitForCommit(ctx context.Context, project string, from, to int64) {
	if c == nil || from < 1 || to <= from || to-from > maxChain {
		return
	}
	c.mu.Lock()
	var waits []chan struct{}
	for i := int64(1); i <= to-from; i++ {
		if k := (key{project, from + i}); c.pending[k] != nil && c.entries[k] == nil {
			ch := c.pending[k]
			waits = append(waits, ch)
		}
	}
	c.mu.Unlock()
	if len(waits) == 0 {
		return
	}
	timer := time.NewTimer(30 * time.Millisecond)
	defer timer.Stop()
	for _, ch := range waits {
		select {
		case <-ch:
		case <-timer.C:
			return
		case <-ctx.Done():
			return
		}
	}
}

func Empty() Delta {
	return Delta{Positions: []Position{}, UpsertNodes: []json.RawMessage{}, RemoveNodeIDs: []string{}, UpsertEdges: []json.RawMessage{}, RemoveEdgeIDs: []string{}}
}
