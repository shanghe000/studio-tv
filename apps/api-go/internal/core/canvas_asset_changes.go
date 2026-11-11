package core

import (
	"sort"
	"strconv"
	"strings"
)

// Preserve an existing, inaccessible history item when an unrelated field is
// edited. New uses still need live asset permission, including copying a ref
// from history to the active output, adding a node, or duplicating an input.
type assetUse struct{ node, kind, path, id string }

func canvasAssetUses(graph map[string]any) map[assetUse]int {
	uses := map[assetUse]int{}
	var walk func(any, assetUse, string)
	walk = func(v any, at assetUse, key string) {
		switch x := v.(type) {
		case string:
			if strings.HasPrefix(x, "rhtv-asset:") {
				at.id = strings.TrimPrefix(x, "rhtv-asset:")
			} else if key == "assetId" && x != "" {
				at.id = x
			} else {
				return
			}
			uses[at]++
		case map[string]any:
			for k, child := range x {
				next := at
				next.path += "/" + strconv.Quote(k)
				walk(child, next, k)
			}
		case []any:
			at.path += "/[]"
			for _, child := range x {
				walk(child, at, "")
			}
		}
	}
	for key, v := range graph {
		if key != "nodes" && key != "edges" {
			walk(v, assetUse{path: strconv.Quote(key)}, key)
			continue
		}
		list, _ := v.([]any)
		for _, raw := range list {
			row, _ := raw.(map[string]any)
			id, _ := row["id"].(string)
			kind, _ := row["type"].(string)
			walk(row, assetUse{node: id, kind: kind, path: key}, "")
		}
	}
	return uses
}
func addedCanvasAssetIDs(before, after map[string]any) []string {
	old := canvasAssetUses(before)
	added := map[string]bool{}
	for use, n := range canvasAssetUses(after) {
		if n > old[use] {
			added[use.id] = true
		}
	}
	ids := make([]string, 0, len(added))
	for id := range added {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
