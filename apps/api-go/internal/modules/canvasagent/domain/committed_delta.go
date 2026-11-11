package domain

import "encoding/json"

// CommittedDelta compares the actual persisted graph, including normalization
// by the trusted store, with the locked pre-command snapshot.
func CommittedDelta(before, after json.RawMessage) (GraphDelta, error) {
	var left, right map[string]any
	if decodeCommandJSON(before, &left) != nil || decodeCommandJSON(after, &right) != nil {
		return GraphDelta{}, ErrGraphOperation
	}
	delta := GraphDelta{NodesUpsert: []map[string]any{}, NodesRemoved: []string{}, EdgesUpsert: []map[string]any{}, EdgesRemoved: []string{}}
	for _, part := range []struct {
		key     string
		upsert  *[]map[string]any
		removed *[]string
	}{{"nodes", &delta.NodesUpsert, &delta.NodesRemoved}, {"edges", &delta.EdgesUpsert, &delta.EdgesRemoved}} {
		old, oldOrder, err := indexedGraphElements(left[part.key])
		if err != nil {
			return GraphDelta{}, err
		}
		current, order, err := indexedGraphElements(right[part.key])
		if err != nil {
			return GraphDelta{}, err
		}
		for _, id := range order {
			if !sameCommandObject(old[id], current[id]) {
				*part.upsert = append(*part.upsert, current[id])
			}
		}
		for _, id := range oldOrder {
			if current[id] == nil {
				*part.removed = append(*part.removed, id)
			}
		}
	}
	return delta, nil
}
