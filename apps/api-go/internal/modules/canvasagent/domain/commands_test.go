package domain

import (
	"encoding/json"
	"errors"
	"testing"
)

const commandGraph = `{"schemaVersion":"1","nodes":[{"id":"rhtv_meta_v1","type":"__rhtv_meta","position":{"x":0,"y":0},"data":{"version":"1","opaque":"preserved"}},{"id":"text","type":"rh-text","position":{"x":10,"y":20},"data":{"title":"old","text":"editable","generatedText":"server output","status":"SUCCESS","taskId":"persisted-task","params":{"prompt":"old prompt","seed":7},"__rhtv":{"native":{"style":{"color":"red"}}}}},{"id":"image","type":"rh-image","position":{"x":30,"y":40},"data":{"title":"image","unknown":{"keep":true}}}],"edges":[{"id":"existing","source":"text","target":"image","sourceHandle":null,"targetHandle":null,"data":{"nativeExtension":true}}],"viewport":{"x":22,"y":33,"zoom":0.7},"unknownRoot":{"keep":true}}`

func parseTestCommand(t *testing.T, operations string) Command {
	t.Helper()
	command, err := ParseCommand(json.RawMessage(`{"schemaVersion":"1","operations":` + operations + `}`))
	if err != nil {
		t.Fatal(err)
	}
	return command
}
func TestTypedCommandsPreserveNativeExtensionsAndServerOutput(t *testing.T) {
	command := parseTestCommand(t, `[{"type":"node.updateInputs","nodeId":"text","inputSchemaVersion":"1","inputs":{"title":"updated","text":"user input","prompt":"new prompt"}},{"type":"node.move","nodeId":"image","position":{"x":100,"y":200}},{"type":"node.create","node":{"id":"video","nodeType":"rh-video","inputSchemaVersion":"1","position":{"x":300,"y":400},"inputs":{"title":"shot","prompt":"fox walks"}}},{"type":"edge.create","edge":{"id":"new_edge","source":"image","target":"video","sourceHandle":null,"targetHandle":null}}]`)
	graph, delta, err := ApplyCommands(json.RawMessage(commandGraph), command)
	if err != nil {
		t.Fatal(err)
	}
	if len(delta.NodesUpsert) != 3 || len(delta.EdgesUpsert) != 1 || len(delta.NodesRemoved) != 0 {
		t.Fatal("delta does not describe the final graph")
	}
	nodes, _, _ := indexedGraphElements(graph["nodes"])
	data := nodes["text"]["data"].(map[string]any)
	if data["text"] != "user input" || data["generatedText"] != "server output" || data["taskId"] != "persisted-task" || data["status"] != "SUCCESS" || data["__rhtv"] == nil || data["params"].(map[string]any)["seed"] != json.Number("7") {
		t.Fatal("editable inputs overwrote unrelated native/server data")
	}
	if nodes["rhtv_meta_v1"]["data"].(map[string]any)["opaque"] != "preserved" || graph["unknownRoot"] == nil || graph["viewport"].(map[string]any)["x"] != json.Number("22") {
		t.Fatal("metadata, extension or viewport was changed")
	}
	edges, _, _ := indexedGraphElements(graph["edges"])
	if edges["existing"]["data"] == nil {
		t.Fatal("untouched edge extension was lost")
	}
}
func TestNodeDeletionRemovesRelatedEdgesAndBatchFailuresDoNotMutateInput(t *testing.T) {
	graph, delta, err := ApplyCommands(json.RawMessage(commandGraph), parseTestCommand(t, `[{"type":"node.delete","nodeId":"text"}]`))
	if err != nil || len(graph["edges"].([]any)) != 0 || len(delta.NodesRemoved) != 1 || delta.NodesRemoved[0] != "text" || len(delta.EdgesRemoved) != 1 || delta.EdgesRemoved[0] != "existing" {
		t.Fatal("node deletion left its dependent edge")
	}
	if _, _, err = ApplyCommands(json.RawMessage(commandGraph), parseTestCommand(t, `[{"type":"node.move","nodeId":"text","position":{"x":111,"y":222}},{"type":"node.delete","nodeId":"missing"}]`)); !errors.Is(err, ErrGraphOperation) {
		t.Fatal("invalid batch succeeded")
	}
	var original map[string]any
	_ = decodeCommandJSON(json.RawMessage(commandGraph), &original)
	nodes, _, _ := indexedGraphElements(original["nodes"])
	if nodes["text"]["position"].(map[string]any)["x"] != json.Number("10") {
		t.Fatal("failed batch mutated original graph")
	}
}
func TestCommandBatchRejectsHiddenNodeLifetimeChanges(t *testing.T) {
	for name, operations := range map[string]string{
		"delete and recreate existing node":     `[{"type":"node.delete","nodeId":"text"},{"type":"node.create","node":{"id":"text","nodeType":"rh-text","inputSchemaVersion":"1","position":{"x":0,"y":0},"inputs":{"text":"replacement"}}}]`,
		"create and delete with unrelated edit": `[{"type":"node.move","nodeId":"image","position":{"x":100,"y":200}},{"type":"node.create","node":{"id":"temporary","nodeType":"rh-video","inputSchemaVersion":"1","position":{"x":0,"y":0},"inputs":{}}},{"type":"node.delete","nodeId":"temporary"}]`,
		"delete recreate delete":                `[{"type":"node.delete","nodeId":"text"},{"type":"node.create","node":{"id":"text","nodeType":"rh-text","inputSchemaVersion":"1","position":{"x":0,"y":0},"inputs":{}}},{"type":"node.delete","nodeId":"text"}]`,
	} {
		t.Run(name, func(t *testing.T) {
			graph, delta, err := ApplyCommands(json.RawMessage(commandGraph), parseTestCommand(t, operations))
			if !errors.Is(err, ErrGraphOperation) || graph != nil || delta.NodesUpsert != nil || delta.NodesRemoved != nil || delta.EdgesUpsert != nil || delta.EdgesRemoved != nil {
				t.Fatal("hidden node lifetime change returned a committable graph or receipt")
			}
		})
	}
}
func TestNodeLifetimeChangesCanUseSeparateCommandsAndOrdinaryEdits(t *testing.T) {
	deleted, _, err := ApplyCommands(json.RawMessage(commandGraph), parseTestCommand(t, `[{"type":"node.updateInputs","nodeId":"text","inputSchemaVersion":"1","inputs":{"text":"edited before deletion"}},{"type":"node.delete","nodeId":"text"}]`))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(deleted)
	if err != nil {
		t.Fatal(err)
	}
	recreated, delta, err := ApplyCommands(raw, parseTestCommand(t, `[{"type":"node.create","node":{"id":"text","nodeType":"rh-text","inputSchemaVersion":"1","position":{"x":0,"y":0},"inputs":{"text":"replacement"}}},{"type":"node.move","nodeId":"text","position":{"x":100,"y":200}}]`))
	if err != nil {
		t.Fatal(err)
	}
	nodes, _, _ := indexedGraphElements(recreated["nodes"])
	data := nodes["text"]["data"].(map[string]any)
	if len(delta.NodesUpsert) != 1 || data["text"] != "replacement" || data["taskId"] != nil || nodes["text"]["position"].(map[string]any)["x"] != float64(100) || len(recreated["edges"].([]any)) != 0 {
		t.Fatal("separate recreate retained the deleted node or rejected its ordinary move")
	}
}
func TestCommandSchemasRejectArbitraryNativeWritesAndUnknownSupport(t *testing.T) {
	for _, raw := range []string{
		`{"schemaVersion":"1","ownerId":"fake","operations":[{"type":"node.delete","nodeId":"text"}]}`,
		`{"schemaVersion":"1","operations":[{"type":"node.create","node":{"id":"x","nodeType":"rh-text","inputSchemaVersion":"1","position":{"x":0,"y":0},"inputs":{"taskId":"fake"}}}]}`,
		`{"schemaVersion":"1","operations":[{"type":"node.move","nodeId":"text","position":{"x":null,"y":0}}]}`,
		`{"schemaVersion":"1","operations":[{"type":"node.move","nodeId":"text","position":{"x":1e999,"y":0}}]}`,
		`{"schemaVersion":"1","operations":[{"type":"edge.create","edge":{"id":"e","source":"text","target":"image"}}]}`,
		`{"schemaVersion":"1","operations":[{"type":"node.delete","nodeId":"text","status":"SUCCESS"}]}`,
	} {
		if _, err := ParseCommand(json.RawMessage(raw)); !errors.Is(err, ErrCommandInvalid) {
			t.Fatalf("arbitrary/invalid write accepted: %s", raw)
		}
	}
	for _, key := range []string{"owner", "status", "progress", "taskId", "output", "generatedText", "historyStorage", "meta", "__rhtv", "params", "imageUrl", "capabilityRef", "systemPrompt"} {
		command := parseTestCommand(t, `[{"type":"node.updateInputs","nodeId":"text","inputSchemaVersion":"1","inputs":{"`+key+`":"injected"}}]`)
		if _, _, err := ApplyCommands(json.RawMessage(commandGraph), command); !errors.Is(err, ErrCommandInvalid) {
			t.Fatalf("reserved input %s accepted", key)
		}
	}
	for _, operation := range []string{`{"type":"node.bindAssets","nodeId":"text"}`, `{"type":"node.create","node":{"id":"x","nodeType":"rh-script","inputSchemaVersion":"1","position":{"x":0,"y":0},"inputs":{}}}`, `{"type":"edge.create","edge":{"id":"e","source":"text","target":"image","sourceHandle":"arbitrary","targetHandle":null}}`} {
		if _, err := ParseCommand(json.RawMessage(`{"schemaVersion":"1","operations":[` + operation + `]}`)); !errors.Is(err, ErrCommandUnsupported) {
			t.Fatal("unsupported operation claimed support")
		}
	}
	for _, operation := range []string{`[{"type":"node.delete","nodeId":"rhtv_meta_v1"}]`, `[{"type":"node.create","node":{"id":"text","nodeType":"rh-text","inputSchemaVersion":"1","position":{"x":0,"y":0},"inputs":{}}}]`, `[{"type":"node.move","nodeId":"text","position":{"x":10,"y":20}}]`} {
		if _, _, err := ApplyCommands(json.RawMessage(commandGraph), parseTestCommand(t, operation)); !errors.Is(err, ErrGraphOperation) {
			t.Fatal("reserved, duplicate or no-op graph mutation succeeded")
		}
	}
	var graph map[string]any
	_ = decodeCommandJSON(json.RawMessage(commandGraph), &graph)
	nodes, _, _ := indexedGraphElements(graph["nodes"])
	nodes["text"]["data"].(map[string]any)["subType"] = "multimodal-storyboard"
	encoded, _ := json.Marshal(graph)
	if _, _, err := ApplyCommands(encoded, parseTestCommand(t, `[{"type":"node.updateInputs","nodeId":"text","inputSchemaVersion":"1","inputs":{"prompt":"wrong mapping"}}]`)); !errors.Is(err, ErrCommandUnsupported) {
		t.Fatal("special native tool accepted ordinary input schema")
	}
}
