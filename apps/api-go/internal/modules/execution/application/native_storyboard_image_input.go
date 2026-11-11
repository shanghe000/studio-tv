package application

import (
	"encoding/json"
	"strings"

	"studiotv.local/service/api/internal/modules/execution/domain"
)

// The native board builder compiles only its selected rows into params.prompt.
// Its direct script edge is lineage, not a second prompt containing all shots.
// Keep the graph/history intact; restrict only the current model input frontier.
func nativeStoryboardImageInputFrontier(node domain.Node, graph domain.Graph, selected map[string]bool) (map[string]bool, error) {
	stops, err := nativeStoryboardImageLineageStops(node, graph, selected)
	if err != nil || len(stops) == 0 {
		return selected, err
	}
	return nativeStoryboardLineageFrontier(node.ID, node.ID, graph, selected, stops), nil
}

func nativeStoryboardImageLineageStops(node domain.Node, graph domain.Graph, selected map[string]bool) (map[string]bool, error) {
	if node.Type != "rh-image" {
		return nil, nil
	}
	selection, err := readPromptSelection(node)
	if err != nil {
		return nil, err
	}
	if selection.SceneCode != "storyboard-prompt-board" {
		return nil, nil
	}
	invalid := func() (map[string]bool, error) { return nil, promptFault("PROMPT_CONDITIONING_INVALID") }
	var board bool
	var rowIDs []string
	var params map[string]json.RawMessage
	var prompt string
	if json.Unmarshal(node.Data["isStoryboard"], &board) != nil || !board ||
		json.Unmarshal(node.Data["storyboardRowIds"], &rowIDs) != nil || len(rowIDs) == 0 || len(rowIDs) > 500 ||
		json.Unmarshal(node.Data["params"], &params) != nil ||
		json.Unmarshal(params["prompt"], &prompt) != nil || strings.TrimSpace(prompt) == "" {
		return invalid()
	}
	wanted := map[string]bool{}
	for _, id := range rowIDs {
		if strings.TrimSpace(id) == "" || wanted[id] {
			return invalid()
		}
		wanted[id] = true
	}
	nodes := map[string]domain.Node{}
	for _, raw := range graph.Nodes {
		var source domain.Node
		if json.Unmarshal(raw, &source) != nil {
			return nil, domain.ErrInvalid
		}
		nodes[source.ID] = source
	}
	stops := map[string]bool{}
	for _, edge := range graph.Edges {
		if edge.Target == node.ID && selected[edge.Source] && nodes[edge.Source].Type == "rh-script" &&
			edge.ConditioningRole == "" && (edge.SourceHandle == "" || edge.SourceHandle == "output") &&
			(edge.TargetHandle == "" || edge.TargetHandle == "input") {
			stops[edge.Source] = true
		}
	}
	if len(stops) == 0 {
		return nil, nil
	}
	// Native boards originate from one script table, including merged rows.
	// Ambiguous tables or unresolvable row IDs must not silently lose context.
	if len(stops) != 1 {
		return invalid()
	}
	for id := range stops {
		// Captured native tables use output.rows; earlier native table states
		// keep the same rows as output itself. Never infer rows from prose.
		rawRows := nodes[id].Data["output"]
		if strings.HasPrefix(strings.TrimSpace(string(rawRows)), "{") {
			var table struct {
				Rows json.RawMessage `json:"rows"`
			}
			if json.Unmarshal(rawRows, &table) != nil {
				return invalid()
			}
			rawRows = table.Rows
		}
		var rows []struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(rawRows, &rows) != nil || len(rows) == 0 || len(rows) > 500 {
			return invalid()
		}
		known := map[string]bool{}
		for _, row := range rows {
			if strings.TrimSpace(row.ID) == "" || known[row.ID] {
				return invalid()
			}
			known[row.ID] = true
		}
		for row := range wanted {
			if !known[row] {
				return invalid()
			}
		}
	}
	return stops, nil
}

func nativeStoryboardLineageFrontier(targetID, boardID string, graph domain.Graph, selected, stops map[string]bool) map[string]bool {
	// Traverse the full graph, not just the already filtered media frontier:
	// shared ancestors may still belong to an independent explicit input path.
	reachable := map[string]bool{targetID: true}
	queue := []string{targetID}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		for _, edge := range graph.Edges {
			lineage := edge.Target == boardID && stops[edge.Source] && edge.ConditioningRole == "" &&
				(edge.SourceHandle == "" || edge.SourceHandle == "output") && (edge.TargetHandle == "" || edge.TargetHandle == "input")
			if edge.Target == current && !lineage && !reachable[edge.Source] {
				reachable[edge.Source] = true
				queue = append(queue, edge.Source)
			}
		}
	}
	frontier := map[string]bool{}
	for id, include := range selected {
		if include && reachable[id] {
			frontier[id] = true
		}
	}
	return frontier
}
