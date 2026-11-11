package application

import (
	"encoding/json"
	"strings"

	"studiotv.local/service/api/internal/modules/execution/domain"
)

// The native selected-text action links original -> excerpt -> image. The
// excerpt's current text is the authored input; its original is lineage. Keep
// the full graph snapshot, but do not send the original article as another
// prompt. Explicit direct inputs and text reachable through independent paths
// retain their existing semantics. This only applies to ordinary image forms.
func nativeImageTextInputFrontier(node domain.Node, graph domain.Graph, selected map[string]bool) (map[string]bool, error) {
	subType := strings.ReplaceAll(strings.ToUpper(domain.String(node.Data, "subType")), "-", "_")
	if node.Type != "rh-image" || domain.String(node.Data, "toolsType") != "" || string(node.Data["isStoryboard"]) == "true" || string(node.Data["isPortraitAdjustResult"]) == "true" || subType != "TEXT_IMAGE" && subType != "IMAGE_IMAGE" {
		return selected, nil
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
		if edge.Target != node.ID || !selected[edge.Source] || edge.ConditioningRole != "" || edge.SourceHandle != "" && edge.SourceHandle != "output" || edge.TargetHandle != "" && edge.TargetHandle != "input" {
			continue
		}
		source := nodes[edge.Source]
		// Explicit output-history selections keep their separate authority.
		// editedSourceText deliberately treats text:"" as current even when
		// content still holds a previous result; never resurrect that result.
		if _, current := editedSourceText(source); current && domain.String(source.Data, "selectedHistoryOutputId") == "" && domain.String(source.Data, "selectedOutputHistoryId") == "" {
			stops[source.ID] = true
		}
	}
	if len(stops) == 0 {
		return selected, nil
	}
	reachable := map[string]bool{node.ID: true}
	queue := []string{node.ID}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		if stops[current] {
			continue
		}
		for _, edge := range graph.Edges {
			if edge.Target == current && selected[edge.Source] && !reachable[edge.Source] {
				reachable[edge.Source] = true
				queue = append(queue, edge.Source)
			}
		}
	}
	frontier := map[string]bool{}
	for id, include := range selected {
		if include && (nodes[id].Type != "rh-text" || reachable[id]) {
			frontier[id] = true
		}
	}
	return frontier, nil
}
