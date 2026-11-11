package http

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"unicode/utf8"

	"studiotv.local/service/api/internal/canvasdelta"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
)

const moveFormat = "move-v1"
const moveWriteTag byte = 'M'
const moveEventTag byte = 'E'
const maxMoveRows = 2048
const maxSafeRevision = (1 << 53) - 1

var badMove = errors.New("invalid compact canvas move")

type moveBatch struct {
	SchemaVersion string      `json:"schemaVersion"`
	BatchID       string      `json:"batchId"`
	ClientID      string      `json:"clientId"`
	Observed      *int64      `json:"observedRevision,omitempty"`
	Compare       *int64      `json:"baseRevision,omitempty"`
	ReceiptOnly   bool        `json:"receiptOnly,omitempty"`
	Operations    []movePatch `json:"operations"`
}
type movePatch struct {
	Type   string       `json:"type"`
	NodeID string       `json:"nodeId"`
	Set    [2]moveField `json:"set"`
	Unset  []string     `json:"unset"`
}
type moveField struct {
	Path  [2]string   `json:"path"`
	Value json.Number `json:"value"`
}

func consumeDelimiter(d *json.Decoder, delim json.Delim) bool {
	token, err := d.Token()
	return err == nil && token == delim
}
func moveRevision(d *json.Decoder) (*int64, error) {
	var v *int64
	if err := d.Decode(&v); err != nil || v != nil && (*v < 1 || *v > maxSafeRevision) {
		return nil, badMove
	}
	return v, nil
}
func coordinate(d *json.Decoder) (json.Number, error) {
	// The original decimal spelling participates in the existing operation
	// digest. Avoid a float -> JSON re-encoding before the canonical writer.
	token, e := d.Token()
	n, ok := token.(json.Number)
	if e != nil || !ok || len(n) > 64 {
		return "", badMove
	}
	x, e := n.Float64()
	if e != nil || math.IsInf(x, 0) || math.IsNaN(x) {
		return "", badMove
	}
	return n, nil
}

type roomBinding struct{ clientID, proof, lease string }

func decodeMove(raw []byte, bound *roomBinding) (roomWrite, error) {
	var w roomWrite
	if len(raw) < 2 || len(raw) > roomFrameLimit || raw[0] != moveWriteTag || !utf8.Valid(raw[1:]) {
		return w, badMove
	}
	d := json.NewDecoder(bytes.NewReader(raw[1:]))
	d.UseNumber()
	b := moveBatch{SchemaVersion: "1"}
	if !consumeDelimiter(d, '[') {
		return w, badMove
	}
	for _, field := range []*string{&w.RequestID, &b.BatchID} {
		if d.Decode(field) != nil {
			return w, badMove
		}
	}
	var client, proof, lease *string
	for _, field := range []**string{&client, &proof, &lease} {
		if d.Decode(field) != nil {
			return w, badMove
		}
	}
	switch {
	case client == nil && proof == nil && lease == nil && bound != nil:
		b.ClientID, w.Proof, w.Lease = bound.clientID, bound.proof, bound.lease
	case client != nil && proof != nil && lease != nil && len(*proof) >= 32 && len(*proof) <= 96 && len(*lease) == 36:
		b.ClientID, w.Proof, w.Lease = *client, *proof, *lease
	default:
		return w, badMove
	}
	w.binding = roomBinding{b.ClientID, w.Proof, w.Lease}
	if !domain.ValidCommandID(w.RequestID) || !domain.ValidCommandID(b.BatchID) || !domain.ValidCommandID(b.ClientID) {
		return w, badMove
	}
	var err error
	if b.Observed, err = moveRevision(d); err != nil {
		return w, err
	}
	if b.Compare, err = moveRevision(d); err != nil {
		return w, err
	}
	base, err := moveRevision(d)
	if err != nil {
		return w, err
	}
	if base != nil {
		w.BaseRevision = *base
	}
	token, err := d.Token()
	only, ok := token.(bool)
	if err != nil || !ok || !consumeDelimiter(d, '[') {
		return w, badMove
	}
	b.ReceiptOnly = only
	for d.More() {
		if len(b.Operations) >= maxMoveRows || !consumeDelimiter(d, '[') {
			return w, badMove
		}
		var id string
		if d.Decode(&id) != nil || !domain.ValidCommandID(id) {
			return w, badMove
		}
		x, e := coordinate(d)
		if e != nil {
			return w, e
		}
		y, e := coordinate(d)
		if e != nil || !consumeDelimiter(d, ']') {
			return w, badMove
		}
		b.Operations = append(b.Operations, movePatch{"node.patch", id, [2]moveField{{[2]string{"position", "x"}, x}, {[2]string{"position", "y"}, y}}, []string{}})
	}
	if len(b.Operations) == 0 || !consumeDelimiter(d, ']') || !consumeDelimiter(d, ']') {
		return w, badMove
	}
	if _, err = d.Token(); err != io.EOF {
		return w, badMove
	}
	w.Type = "write"
	w.Body, err = json.Marshal(b)
	if err != nil || len(w.Body) > 2*1024*1024 {
		return w, badMove
	}
	return w, nil
}

// A typed, strict projection protects JSON/WS evolution: future fields,
// explicit null/empty order changes and every structural change stay in the
// original event envelope. All document state originates from a committed read.
func compactMoveEvent(project string, f roomEvent) []byte {
	if f.Event != "canvas.delta" {
		return nil
	}
	var v struct {
		SchemaVersion string          `json:"schemaVersion"`
		ProjectID     string          `json:"projectId"`
		Kind          string          `json:"kind"`
		FromRevision  int64           `json:"fromRevision"`
		GraphRevision int64           `json:"graphRevision"`
		EventCursor   string          `json:"eventCursor"`
		UpdatedAt     string          `json:"updatedAt"`
		Available     *bool           `json:"nodeExecutionAvailable"`
		States        json.RawMessage `json:"nodeStates"`
		Delta         struct {
			Positions     []canvasdelta.Position `json:"positions"`
			UpsertNodes   []json.RawMessage      `json:"upsertNodes"`
			RemoveNodeIDs []string               `json:"removeNodeIds"`
			UpsertEdges   []json.RawMessage      `json:"upsertEdges"`
			RemoveEdgeIDs []string               `json:"removeEdgeIds"`
		} `json:"delta"`
	}
	if roomDecode(f.Data, &v) != nil || v.SchemaVersion != "1" || v.ProjectID != project || v.EventCursor != f.ID || v.Kind != "DELTA" || v.Available == nil || len(v.States) == 0 || v.States[0] != '[' || v.UpdatedAt == "" || v.FromRevision < 1 || v.GraphRevision <= v.FromRevision || v.GraphRevision > maxSafeRevision {
		return nil
	}
	d := v.Delta
	if len(d.Positions) == 0 || d.UpsertNodes == nil || d.UpsertEdges == nil || d.RemoveNodeIDs == nil || d.RemoveEdgeIDs == nil || len(d.UpsertNodes)+len(d.UpsertEdges)+len(d.RemoveNodeIDs)+len(d.RemoveEdgeIDs) != 0 {
		return nil
	}
	rows := make([][3]any, len(d.Positions))
	for i, p := range d.Positions {
		rows[i] = [3]any{p.ID, p.X, p.Y}
	}
	body, err := json.Marshal([7]any{f.ID, v.FromRevision, v.GraphRevision, v.UpdatedAt, *v.Available, v.States, rows})
	if err != nil {
		return nil
	}
	return append([]byte{moveEventTag}, body...)
}
