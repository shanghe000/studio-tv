package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	ErrCommandInvalid          = errors.New("invalid canvas command")
	ErrCommandUnsupported      = errors.New("canvas command or node schema is not implemented")
	ErrAgentContextUnavailable = errors.New("registered agent tool calls are not implemented")
	ErrGraphOperation          = errors.New("invalid canvas graph operation")
	ErrCommandConflict         = errors.New("canvas idempotency key used for another request")
	ErrCommandUnavailable      = errors.New("canvas command persistence unavailable")
	ErrCommandReceiptNotFound  = errors.New("canvas command receipt not visible")
)

type CommandVersionConflict struct{ Current int64 }

func (e *CommandVersionConflict) Error() string { return "canvas revision changed" }

const MaxCommandOperations = 100
const MaxCommandGraphNodes = 10000
const MaxCommandGraphEdges = 20000

var commandID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

func ValidCommandID(id string) bool { return commandID.MatchString(id) }

type Command struct {
	SchemaVersion   string
	Operations      []Operation
	HasAgentContext bool
}
type Operation struct {
	Type               string
	Node               *CommandNode
	NodeID             string
	InputSchemaVersion string
	Inputs             map[string]json.RawMessage
	Position           *Position
	Edge               *CommandEdge
	EdgeID             string
	Capability         *CommandCapability
}
type CommandCapability struct {
	Ref, Version                 string
	Parameters                   json.RawMessage
	Kind, ParameterSchemaVersion string // resolved by the application, never parsed from callers
}
type CommandNode struct {
	ID                 string                     `json:"id"`
	NodeType           string                     `json:"nodeType"`
	InputSchemaVersion string                     `json:"inputSchemaVersion"`
	Position           Position                   `json:"position"`
	Inputs             map[string]json.RawMessage `json:"inputs"`
}
type CommandEdge struct {
	ID           string  `json:"id"`
	Source       string  `json:"source"`
	Target       string  `json:"target"`
	SourceHandle *string `json:"sourceHandle"`
	TargetHandle *string `json:"targetHandle"`
}
type GraphDelta struct {
	NodesUpsert  []map[string]any `json:"nodesUpsert"`
	NodesRemoved []string         `json:"nodesRemoved"`
	EdgesUpsert  []map[string]any `json:"edgesUpsert"`
	EdgesRemoved []string         `json:"edgesRemoved"`
}
type CommandReceipt struct {
	CommandID     string     `json:"commandId"`
	ProjectID     string     `json:"projectId"`
	State         string     `json:"state"`
	BaseRevision  int64      `json:"baseRevision"`
	GraphRevision int64      `json:"graphRevision"`
	EventCursor   string     `json:"eventCursor"`
	Delta         GraphDelta `json:"delta"`
	CommittedAt   time.Time  `json:"committedAt"`
}

// ParseCommand validates every transport field before graph mutation. Inputs
// remain a strict per-node schema, never an arbitrary native data merge.
func ParseCommand(raw json.RawMessage) (Command, error) {
	var command Command
	body, err := commandObject(raw, []string{"schemaVersion", "operations"}, "agentContext")
	if err != nil || json.Unmarshal(body["schemaVersion"], &command.SchemaVersion) != nil || command.SchemaVersion != "1" {
		return command, ErrCommandInvalid
	}
	var operations []json.RawMessage
	if json.Unmarshal(body["operations"], &operations) != nil || len(operations) < 1 || len(operations) > MaxCommandOperations {
		return command, ErrCommandInvalid
	}
	if agent, exists := body["agentContext"]; exists {
		context, err := commandObject(agent, []string{"runId", "toolCallId"})
		if err != nil || !validRawID(context["runId"]) || !validRawID(context["toolCallId"]) {
			return command, ErrCommandInvalid
		}
		command.HasAgentContext = true
	}
	for _, rawOperation := range operations {
		operation, err := parseOperation(rawOperation)
		if err != nil {
			return Command{}, err
		}
		command.Operations = append(command.Operations, operation)
	}
	return command, nil
}
func parseOperation(raw json.RawMessage) (Operation, error) {
	var operation Operation
	var rawObject map[string]json.RawMessage
	if json.Unmarshal(raw, &rawObject) != nil || rawObject == nil || !rawCommandString(rawObject["type"], 1, 100) {
		return operation, ErrCommandInvalid
	}
	var discriminator struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(raw, &discriminator) != nil {
		return operation, ErrCommandInvalid
	}
	operation.Type = discriminator.Type
	var fields []string
	switch operation.Type {
	case "node.create":
		fields = []string{"type", "node"}
	case "node.updateInputs":
		fields = []string{"type", "nodeId", "inputSchemaVersion", "inputs"}
	case "node.move":
		fields = []string{"type", "nodeId", "position"}
	case "node.delete":
		fields = []string{"type", "nodeId"}
	case "node.selectCapability":
		fields = []string{"type", "nodeId", "capabilityRef", "capabilityVersion", "parameters"}
	case "edge.create":
		fields = []string{"type", "edge"}
	case "edge.delete":
		fields = []string{"type", "edgeId"}
	default:
		return operation, ErrCommandUnsupported
	}
	body, err := commandObject(raw, fields)
	if err != nil {
		return operation, err
	}
	if operation.Type == "node.selectCapability" {
		if !rawCommandString(body["capabilityRef"], 1, 200) || !rawCommandString(body["capabilityVersion"], 1, 100) {
			return operation, ErrCommandInvalid
		}
		var params map[string]json.RawMessage
		if json.Unmarshal(body["parameters"], &params) != nil || params == nil || len(body["parameters"]) > 16384 {
			return operation, ErrCommandInvalid
		}
		c := &CommandCapability{Parameters: body["parameters"]}
		_ = json.Unmarshal(body["capabilityRef"], &c.Ref)
		_ = json.Unmarshal(body["capabilityVersion"], &c.Version)
		operation.Capability = c
	}
	if rawID, exists := body["nodeId"]; exists {
		if !validRawID(rawID) {
			return operation, ErrCommandInvalid
		}
		_ = json.Unmarshal(rawID, &operation.NodeID)
	}
	if rawID, exists := body["edgeId"]; exists {
		if !validRawID(rawID) {
			return operation, ErrCommandInvalid
		}
		_ = json.Unmarshal(rawID, &operation.EdgeID)
	}
	if position, exists := body["position"]; exists {
		value, err := parsePosition(position)
		if err != nil {
			return operation, err
		}
		operation.Position = &value
	}
	if inputs, exists := body["inputs"]; exists {
		if json.Unmarshal(inputs, &operation.Inputs) != nil || operation.Inputs == nil || len(operation.Inputs) == 0 || !rawCommandString(body["inputSchemaVersion"], 1, 100) || json.Unmarshal(body["inputSchemaVersion"], &operation.InputSchemaVersion) != nil {
			return operation, ErrCommandInvalid
		}
	}
	if nodeRaw, exists := body["node"]; exists {
		nodeBody, err := commandObject(nodeRaw, []string{"id", "nodeType", "inputSchemaVersion", "position", "inputs"})
		if err != nil || !validRawID(nodeBody["id"]) || !rawCommandString(nodeBody["nodeType"], 1, 100) || !rawCommandString(nodeBody["inputSchemaVersion"], 1, 100) {
			return operation, ErrCommandInvalid
		}
		var node CommandNode
		if decodeCommandJSON(nodeRaw, &node) != nil || node.Inputs == nil {
			return operation, ErrCommandInvalid
		}
		node.Position, err = parsePosition(nodeBody["position"])
		if err != nil {
			return operation, err
		}
		if _, err = validatedInputs(node.NodeType, node.InputSchemaVersion, node.Inputs); err != nil {
			return operation, err
		}
		operation.Node = &node
	}
	if edgeRaw, exists := body["edge"]; exists {
		edgeBody, err := commandObject(edgeRaw, []string{"id", "source", "target", "sourceHandle", "targetHandle"})
		if err != nil || !validRawID(edgeBody["id"]) || !validRawID(edgeBody["source"]) || !validRawID(edgeBody["target"]) {
			return operation, ErrCommandInvalid
		}
		var edge CommandEdge
		if decodeCommandJSON(edgeRaw, &edge) != nil {
			return operation, ErrCommandInvalid
		}
		if edge.SourceHandle != nil || edge.TargetHandle != nil {
			return operation, ErrCommandUnsupported
		}
		operation.Edge = &edge
	}
	return operation, nil
}
func commandObject(raw json.RawMessage, required []string, optional ...string) (map[string]json.RawMessage, error) {
	var object map[string]json.RawMessage
	if !utf8.Valid(raw) || json.Unmarshal(raw, &object) != nil || object == nil {
		return nil, ErrCommandInvalid
	}
	allowed := map[string]bool{}
	for _, key := range append(required, optional...) {
		allowed[key] = true
	}
	for key := range object {
		if !allowed[key] {
			return nil, ErrCommandInvalid
		}
	}
	for _, key := range required {
		if _, exists := object[key]; !exists {
			return nil, ErrCommandInvalid
		}
	}
	return object, nil
}
func decodeCommandJSON(raw json.RawMessage, out any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	if err := decoder.Decode(out); err != nil {
		return err
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return ErrCommandInvalid
	}
	return nil
}
func validRawID(raw json.RawMessage) bool {
	var id string
	return json.Unmarshal(raw, &id) == nil && ValidCommandID(id)
}
func rawCommandString(raw json.RawMessage, min, max int) bool {
	raw = bytes.TrimSpace(raw)
	var value string
	if len(raw) == 0 || raw[0] != '"' || json.Unmarshal(raw, &value) != nil || !utf8.ValidString(value) {
		return false
	}
	length := utf8.RuneCountInString(value)
	return length >= min && length <= max
}
func parsePosition(raw json.RawMessage) (Position, error) {
	var position Position
	body, err := commandObject(raw, []string{"x", "y"})
	if err != nil {
		return position, err
	}
	for _, key := range []string{"x", "y"} {
		if bytes.Equal(bytes.TrimSpace(body[key]), []byte("null")) {
			return position, ErrCommandInvalid
		}
	}
	if decodeCommandJSON(raw, &position) != nil || math.IsNaN(position.X) || math.IsInf(position.X, 0) || math.IsNaN(position.Y) || math.IsInf(position.Y, 0) {
		return position, ErrCommandInvalid
	}
	return position, nil
}
func validatedInputs(nodeType, version string, inputs map[string]json.RawMessage) (map[string]string, error) {
	if version != "1" || (nodeType != "rh-text" && nodeType != "rh-image" && nodeType != "rh-video") {
		return nil, ErrCommandUnsupported
	}
	values := map[string]string{}
	for key, raw := range inputs {
		if key != "title" && key != "prompt" && !(nodeType == "rh-text" && key == "text") {
			return nil, ErrCommandInvalid
		}
		var value string
		if len(raw) == 0 || raw[0] != '"' || json.Unmarshal(raw, &value) != nil || !utf8.ValidString(value) || strings.ContainsRune(value, '\x00') {
			return nil, ErrCommandInvalid
		}
		limit := 200000
		if key == "title" {
			limit = 120
		}
		if utf8.RuneCountInString(value) > limit {
			return nil, ErrCommandInvalid
		}
		values[key] = value
	}
	return values, nil
}

// ApplyCommands copies the current graph and touches only server-recognized
// editable fields. Existing metadata and native extensions remain untouched.
func ApplyCommands(raw json.RawMessage, command Command) (map[string]any, GraphDelta, error) {
	if command.SchemaVersion != "1" || len(command.Operations) < 1 || len(command.Operations) > MaxCommandOperations {
		return nil, GraphDelta{}, ErrCommandInvalid
	}
	if command.HasAgentContext {
		return nil, GraphDelta{}, ErrAgentContextUnavailable
	}
	// A receipt describes the committed graph, so it cannot expose a node's
	// intermediate deletion/recreation. Keep every node lifetime change in its
	// own batch, including a create/delete pair alongside unrelated edits.
	lifecycleIDs := map[string]bool{}
	for _, operation := range command.Operations {
		id := ""
		switch operation.Type {
		case "node.create":
			if operation.Node == nil {
				return nil, GraphDelta{}, ErrGraphOperation
			}
			id = operation.Node.ID
		case "node.delete":
			id = operation.NodeID
		default:
			continue
		}
		if lifecycleIDs[id] {
			return nil, GraphDelta{}, ErrGraphOperation
		}
		lifecycleIDs[id] = true
	}
	var graph map[string]any
	if decodeCommandJSON(raw, &graph) != nil || graph == nil {
		return nil, GraphDelta{}, ErrGraphOperation
	}
	nodes, nodeOrder, err := indexedGraphElements(graph["nodes"])
	if err != nil {
		return nil, GraphDelta{}, err
	}
	edges, edgeOrder, err := indexedGraphElements(graph["edges"])
	if err != nil {
		return nil, GraphDelta{}, err
	}
	beforeNodes, beforeNodeOrder, _ := indexedGraphElements(graph["nodes"])
	beforeEdges, beforeEdgeOrder, _ := indexedGraphElements(graph["edges"])
	// Maps returned by the original indexing share values. Snapshot each value
	// before any mutation so normalized deltas describe actual committed data.
	for id, node := range beforeNodes {
		beforeNodes[id] = cloneCommandObject(node)
	}
	for id, edge := range beforeEdges {
		beforeEdges[id] = cloneCommandObject(edge)
	}
	for _, operation := range command.Operations {
		switch operation.Type {
		case "node.create":
			node := operation.Node
			if node == nil || node.ID == "rhtv_meta_v1" || nodes[node.ID] != nil {
				return nil, GraphDelta{}, ErrGraphOperation
			}
			inputs, err := validatedInputs(node.NodeType, node.InputSchemaVersion, node.Inputs)
			if err != nil {
				return nil, GraphDelta{}, err
			}
			data := map[string]any{}
			mergeCommandInputs(data, inputs)
			nodes[node.ID] = map[string]any{"id": node.ID, "type": node.NodeType, "position": map[string]any{"x": node.Position.X, "y": node.Position.Y}, "data": data}
			nodeOrder = append(nodeOrder, node.ID)
		case "node.updateInputs", "node.move", "node.delete", "node.selectCapability":
			node := nodes[operation.NodeID]
			if node == nil || operation.NodeID == "rhtv_meta_v1" {
				return nil, GraphDelta{}, ErrGraphOperation
			}
			kind, _ := node["type"].(string)
			if kind != "rh-text" && kind != "rh-image" && kind != "rh-video" {
				return nil, GraphDelta{}, ErrCommandUnsupported
			}
			data, _ := node["data"].(map[string]any)
			if operation.Type == "node.selectCapability" {
				if data == nil || !ordinaryCommandNode(kind, data) || operation.Capability == nil {
					return nil, GraphDelta{}, ErrCommandUnsupported
				}
				c := operation.Capability
				allowed := map[string]map[string]string{"rh-text": {"LLM": "text-text", "IMAGE_UNDERSTANDING": "multimodal-text"}, "rh-image": {"TEXT_TO_IMAGE": "text-image", "IMAGE_TO_IMAGE": "image-image"}, "rh-video": {"TEXT_TO_VIDEO": "text-video", "IMAGE_TO_VIDEO": "image-video"}}
				sub := allowed[kind][c.Kind]
				if sub == "" || c.ParameterSchemaVersion == "" {
					return nil, GraphDelta{}, ErrCommandUnsupported
				}
				var params map[string]any
				if decodeCommandJSON(c.Parameters, &params) != nil || params == nil {
					return nil, GraphDelta{}, ErrCommandInvalid
				}
				data["modelCode"], data["capabilityRef"], data["capabilityVersion"], data["parameterSchemaVersion"] = c.Ref, c.Ref, c.Version, c.ParameterSchemaVersion
				data["routerParameters"], data["subType"] = params, sub
				native, _ := data["params"].(map[string]any)
				if native == nil {
					native = map[string]any{}
					data["params"] = native
				}
				delete(native, "reasoning_effort")
				if effort, ok := params["reasoningEffort"].(string); ok {
					native["reasoning_effort"] = effort
				}
			} else if operation.Type == "node.updateInputs" {
				if data == nil {
					return nil, GraphDelta{}, ErrGraphOperation
				}
				if !ordinaryCommandNode(kind, data) {
					return nil, GraphDelta{}, ErrCommandUnsupported
				}
				inputs, err := validatedInputs(kind, operation.InputSchemaVersion, operation.Inputs)
				if err != nil {
					return nil, GraphDelta{}, err
				}
				mergeCommandInputs(data, inputs)
			} else if operation.Type == "node.move" {
				if operation.Position == nil {
					return nil, GraphDelta{}, ErrCommandInvalid
				}
				position, ok := node["position"].(map[string]any)
				if !ok {
					return nil, GraphDelta{}, ErrGraphOperation
				}
				position["x"], position["y"] = operation.Position.X, operation.Position.Y
			} else {
				delete(nodes, operation.NodeID)
				for id, edge := range edges {
					if edge["source"] == operation.NodeID || edge["target"] == operation.NodeID {
						delete(edges, id)
					}
				}
			}
		case "edge.create":
			edge := operation.Edge
			if edge == nil || edges[edge.ID] != nil || edge.Source == edge.Target || !commandEndpoint(nodes[edge.Source]) || !commandEndpoint(nodes[edge.Target]) {
				return nil, GraphDelta{}, ErrGraphOperation
			}
			edges[edge.ID] = map[string]any{"id": edge.ID, "source": edge.Source, "target": edge.Target, "sourceHandle": nil, "targetHandle": nil}
			edgeOrder = append(edgeOrder, edge.ID)
		case "edge.delete":
			if edges[operation.EdgeID] == nil {
				return nil, GraphDelta{}, ErrGraphOperation
			}
			delete(edges, operation.EdgeID)
		default:
			return nil, GraphDelta{}, ErrCommandUnsupported
		}
	}
	if len(nodes) > MaxCommandGraphNodes || len(edges) > MaxCommandGraphEdges {
		return nil, GraphDelta{}, ErrGraphOperation
	}
	graph["nodes"] = orderedCommandElements(nodes, nodeOrder)
	graph["edges"] = orderedCommandElements(edges, edgeOrder)
	delta := GraphDelta{NodesUpsert: []map[string]any{}, NodesRemoved: []string{}, EdgesUpsert: []map[string]any{}, EdgesRemoved: []string{}}
	for _, id := range uniqueCommandOrder(nodeOrder) {
		if node := nodes[id]; node != nil && !sameCommandObject(beforeNodes[id], node) {
			delta.NodesUpsert = append(delta.NodesUpsert, node)
		}
	}
	for _, id := range beforeNodeOrder {
		if nodes[id] == nil {
			delta.NodesRemoved = append(delta.NodesRemoved, id)
		}
	}
	for _, id := range uniqueCommandOrder(edgeOrder) {
		if edge := edges[id]; edge != nil && !sameCommandObject(beforeEdges[id], edge) {
			delta.EdgesUpsert = append(delta.EdgesUpsert, edge)
		}
	}
	for _, id := range beforeEdgeOrder {
		if edges[id] == nil {
			delta.EdgesRemoved = append(delta.EdgesRemoved, id)
		}
	}
	if len(delta.NodesUpsert)+len(delta.NodesRemoved)+len(delta.EdgesUpsert)+len(delta.EdgesRemoved) == 0 {
		return nil, delta, ErrGraphOperation
	}
	return graph, delta, nil
}
func ordinaryCommandNode(kind string, data map[string]any) bool {
	if params, exists := data["params"]; exists {
		if _, ok := params.(map[string]any); !ok {
			return false
		}
	}
	for _, key := range []string{"sceneCode", "promptSelection"} {
		if _, exists := data[key]; exists {
			return false
		}
	}
	allowed := map[string]map[string]bool{
		"rh-text":  {"": true, "text-text": true, "TEXT_TEXT": true, "LLM": true, "multimodal-text": true},
		"rh-image": {"": true, "text-image": true, "TEXT_TO_IMAGE": true, "image-image": true},
		"rh-video": {"": true, "text-video": true, "TEXT_TO_VIDEO": true, "image-video": true},
	}
	for _, key := range []string{"subType", "toolsType"} {
		if value, exists := data[key]; exists {
			text, ok := value.(string)
			if !ok || !allowed[kind][text] {
				return false
			}
		}
	}
	return true
}
func commandEndpoint(node map[string]any) bool {
	if node == nil || node["id"] == "rhtv_meta_v1" {
		return false
	}
	kind, _ := node["type"].(string)
	return kind == "rh-text" || kind == "rh-image" || kind == "rh-video"
}
func mergeCommandInputs(data map[string]any, inputs map[string]string) {
	for key, value := range inputs {
		if key == "prompt" {
			params, _ := data["params"].(map[string]any)
			if params == nil {
				params = map[string]any{}
				data["params"] = params
			}
			params["prompt"] = value
		} else {
			data[key] = value
		}
	}
}
func indexedGraphElements(value any) (map[string]map[string]any, []string, error) {
	list, ok := value.([]any)
	if !ok {
		return nil, nil, ErrGraphOperation
	}
	indexed := map[string]map[string]any{}
	order := []string{}
	for _, element := range list {
		object, ok := element.(map[string]any)
		if !ok {
			return nil, nil, ErrGraphOperation
		}
		id, ok := object["id"].(string)
		if !ok || id == "" || indexed[id] != nil {
			return nil, nil, ErrGraphOperation
		}
		indexed[id] = object
		order = append(order, id)
	}
	return indexed, order, nil
}
func cloneCommandObject(value map[string]any) map[string]any {
	raw, _ := json.Marshal(value)
	var cloned map[string]any
	_ = decodeCommandJSON(raw, &cloned)
	return cloned
}
func sameCommandObject(a, b map[string]any) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return bytes.Equal(left, right)
}
func uniqueCommandOrder(order []string) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, id := range order {
		if !seen[id] {
			seen[id] = true
			result = append(result, id)
		}
	}
	return result
}
func orderedCommandElements(elements map[string]map[string]any, order []string) []any {
	result := []any{}
	for _, id := range uniqueCommandOrder(order) {
		if element := elements[id]; element != nil {
			result = append(result, element)
		}
	}
	return result
}
