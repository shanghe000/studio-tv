package application

import (
	"encoding/json"
	"strings"

	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

// Native S08 videos compile their own shot prompt but keep script -> board ->
// video lineage. Only a trusted H3 target bound to one exact native board may
// exclude that board's script edge. Other H3 text/reference semantics stay intact.
func nativeStoryboardVideoInputFrontier(cap gateway.CapabilitySelection, node domain.Node, graph domain.Graph, selected map[string]bool, trusted ...bool) (map[string]bool, error) {
	if len(trusted) == 0 || !trusted[0] || !h3CanvasInput(cap, node, trusted...) {
		return selected, nil
	}
	selection, err := readPromptSelection(node)
	if err != nil {
		return nil, err
	}
	if selection.SceneCode != "" {
		return selected, nil
	}
	var storyboard bool
	if len(node.Data["isStoryboard"]) == 0 {
		return selected, nil
	}
	if json.Unmarshal(node.Data["isStoryboard"], &storyboard) != nil {
		return nil, promptFault("PROMPT_CONDITIONING_INVALID")
	}
	if !storyboard {
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
	boards := map[string]domain.Node{}
	for _, edge := range graph.Edges {
		source := nodes[edge.Source]
		if edge.Target == node.ID && selected[source.ID] && source.Type == "rh-image" &&
			domain.String(source.Data, "sceneCode") == "storyboard-prompt-board" && edge.ConditioningRole == "" &&
			(edge.SourceHandle == "" || edge.SourceHandle == "output") && (edge.TargetHandle == "" || edge.TargetHandle == "input") {
			boards[source.ID] = source
		}
	}
	if len(boards) == 0 {
		return selected, nil
	}
	if len(boards) != 1 {
		return nil, promptFault("PROMPT_CONDITIONING_INVALID")
	}
	var targetRow string
	if json.Unmarshal(node.Data["storyboardRowId"], &targetRow) != nil || strings.TrimSpace(targetRow) == "" {
		return nil, promptFault("PROMPT_CONDITIONING_INVALID")
	}
	var params map[string]json.RawMessage
	var prompt string
	if json.Unmarshal(node.Data["params"], &params) != nil || json.Unmarshal(params["prompt"], &prompt) != nil || strings.TrimSpace(prompt) == "" {
		return nil, promptFault("PROMPT_CONDITIONING_INVALID")
	}
	for _, board := range boards {
		var boardRow string
		if json.Unmarshal(board.Data["storyboardRowId"], &boardRow) != nil || boardRow != targetRow {
			return nil, promptFault("PROMPT_CONDITIONING_INVALID")
		}
		stops, err := nativeStoryboardImageLineageStops(board, graph, selected)
		if err != nil || len(stops) == 0 {
			return selected, err
		}
		return nativeStoryboardLineageFrontier(node.ID, board.ID, graph, selected, stops), nil
	}
	return selected, nil
}
