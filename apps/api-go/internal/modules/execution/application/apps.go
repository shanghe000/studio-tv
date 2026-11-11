package application

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"studiotv.local/service/api/internal/modules/execution/domain"
	"strconv"
	"strings"
)

type AppField struct {
	NodeID string `json:"nodeId"`
	Name   string `json:"fieldName"`
	Type   string `json:"fieldType"`
	Data   string `json:"fieldData"`
}
type AppDefinition struct {
	ID, Name string
	Revision int64
	Fields   []AppField
}
type AppCatalog interface {
	Definition(context.Context, string, string) (AppDefinition, error)
}
type AppInput struct {
	NodeID string          `json:"nodeId"`
	Name   string          `json:"fieldName"`
	Value  json.RawMessage `json:"fieldValue"`
}
type AppCommand struct {
	ProjectID         string          `json:"projectId"`
	NodeID            string          `json:"nodeId"`
	AppID             string          `json:"appId"`
	AppRevision       int64           `json:"appRevision"`
	Inputs            []AppInput      `json:"inputNodes"`
	CapabilityRef     string          `json:"capabilityRef"`
	CapabilityVersion string          `json:"capabilityVersion"`
	Parameters        json.RawMessage `json:"parameters"`
}

func (s *Service) WithApps(port AppCatalog) { s.apps = port }
func (s *Service) App(ctx context.Context, owner, key string, cmd AppCommand) (domain.Task, error) {
	if s.apps == nil {
		return domain.Task{}, domain.ErrInvalid
	}
	def, e := s.apps.Definition(ctx, owner, cmd.AppID)
	if e != nil {
		return domain.Task{}, e
	}
	if def.Revision != cmd.AppRevision {
		return domain.Task{}, domain.ErrConflict
	}
	if cmd.NodeID == "" || len(cmd.NodeID) > 200 || cmd.CapabilityRef == "" || cmd.CapabilityVersion == "" || len(cmd.Inputs) != len(def.Fields) || len(cmd.Inputs) > 200 {
		return domain.Task{}, domain.ErrInvalid
	}
	declared := map[string]AppField{}
	for _, field := range def.Fields {
		declared[field.NodeID+"\x00"+field.Name] = field
	}
	used := map[string]bool{}
	texts := []string{}
	assets := []string{}
	expectedKinds := map[string]string{}
	for _, input := range cmd.Inputs {
		id := input.NodeID + "\x00" + input.Name
		field, ok := declared[id]
		if !ok || used[id] || len(input.Value) > 200000 {
			return domain.Task{}, domain.ErrInvalid
		}
		used[id] = true
		text, asset, e := validateAppValue(field, input.Value)
		if e != nil {
			return domain.Task{}, e
		}
		if text != "" {
			texts = append(texts, field.Name+": "+text)
		}
		if asset != "" {
			assets = append(assets, asset)
			if previous := expectedKinds[asset]; previous != "" && previous != strings.ToUpper(field.Type) {
				return domain.Task{}, domain.ErrInvalid
			}
			expectedKinds[asset] = strings.ToUpper(field.Type)
		}
	}
	scoped, storage, e := s.projectScope(ctx, owner, cmd.ProjectID)
	if e != nil {
		return domain.Task{}, e
	}
	if len(assets) > 0 {
		owned, e := s.store.Assets(scoped, storage, assets)
		if e != nil {
			return domain.Task{}, e
		}
		if len(owned) != len(assets) {
			return domain.Task{}, domain.ErrNotFound
		}
		for _, asset := range owned {
			if expectedKinds[asset.ID] != asset.Kind {
				return domain.Task{}, domain.ErrInvalid
			}
		}
	}
	// This is an explicit model TEST MODE invocation using the saved app's actual
	// input form. Missing vendor workflow definitions are not invented or executed.
	nodes := []any{map[string]any{"id": cmd.NodeID, "type": "rh-ai", "data": map[string]any{
		"webappId": def.ID, "appRevision": def.Revision, "capabilityRef": cmd.CapabilityRef, "capabilityVersion": cmd.CapabilityVersion,
		"prompt": strings.Join(texts, "\n"), "assetIds": assets, "routerParameters": cmd.Parameters,
		"applicationInput": map[string]any{"schemaVersion": "1", "appId": def.ID, "appRevision": def.Revision, "inputNodes": cmd.Inputs},
	}}}
	graph, _ := json.Marshal(map[string]any{"nodes": nodes, "edges": []any{}})
	return s.Canvas(ctx, owner, key, domain.CanvasCommand{ProjectID: cmd.ProjectID, TargetType: "NODE", TargetID: cmd.NodeID, Graph: graph, Name: def.Name})
}
func validateAppValue(field AppField, raw json.RawMessage) (string, string, error) {
	var value any
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return "", "", domain.ErrInvalid
	}
	var options []json.RawMessage
	_ = json.Unmarshal([]byte(field.Data), &options)
	var limits struct {
		Min *float64 `json:"min"`
		Max *float64 `json:"max"`
	}
	if len(options) > 1 {
		_ = json.Unmarshal(options[1], &limits)
	}
	kind := strings.ToUpper(field.Type)
	switch kind {
	case "IMAGE", "VIDEO", "AUDIO", "FILE":
		text, ok := value.(string)
		if !ok || !strings.HasPrefix(text, "rhtv-asset:") || len(text) <= 11 || len(text) > 211 {
			return "", "", domain.ErrInvalid
		}
		return "", strings.TrimPrefix(text, "rhtv-asset:"), nil
	case "INT", "INTEGER", "FLOAT", "DOUBLE", "NUMBER":
		number, ok := value.(float64)
		if !ok {
			if text, isText := value.(string); isText {
				var parseErr error
				number, parseErr = strconv.ParseFloat(strings.TrimSpace(text), 64)
				if parseErr != nil {
					return "", "", domain.ErrInvalid
				}
			} else {
				return "", "", domain.ErrInvalid
			}
		}
		if math.IsNaN(number) || math.IsInf(number, 0) || (kind == "INT" || kind == "INTEGER") && math.Trunc(number) != number || limits.Min != nil && number < *limits.Min || limits.Max != nil && number > *limits.Max {
			return "", "", domain.ErrInvalid
		}
		return fmt.Sprint(number), "", nil
	case "BOOLEAN", "BOOL":
		boolean, ok := value.(bool)
		if !ok {
			return "", "", domain.ErrInvalid
		}
		return fmt.Sprint(boolean), "", nil
	default:
		text, ok := value.(string)
		if !ok || strings.ContainsRune(text, 0) {
			return "", "", domain.ErrInvalid
		}
		if len(options) > 0 {
			var choices []any
			if json.Unmarshal(options[0], &choices) == nil && len(choices) > 0 {
				matched := false
				for _, choice := range choices {
					if fmt.Sprint(choice) == text {
						matched = true
					}
				}
				if !matched {
					return "", "", domain.ErrInvalid
				}
			}
		}
		return text, "", nil
	}
}
