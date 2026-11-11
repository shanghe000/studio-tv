package application

import (
	"context"
	"encoding/json"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"strings"
	"time"
)

type inputBinder interface {
	BindInputs(context.Context, domain.Task, string, []Grant) (bool, error)
}
type leaseHeartbeat interface {
	Heartbeat(context.Context, string, string) (bool, error)
}

func (s *Service) heartbeat(ctx context.Context, cancel context.CancelFunc, id, lease string) {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if store, ok := s.store.(leaseHeartbeat); ok {
				alive, err := store.Heartbeat(ctx, id, lease)
				if err != nil || !alive {
					cancel()
					return
				}
			}
		}
	}
}
func (s *Service) bindUpstream(ctx context.Context, t domain.Task, index int, request *gateway.InvocationRequest) ([]Grant, error) {
	grants := []Grant{}
	if t.Kind != "CANVAS" {
		return grants, nil
	}
	var graph domain.Graph
	if index < 0 || index >= len(t.Plans) || json.Unmarshal(t.Snapshot, &graph) != nil {
		return nil, domain.ErrInvalid
	}
	target := domain.Node{}
	sources := map[string]domain.Node{}
	for _, body := range graph.Nodes {
		var node domain.Node
		if json.Unmarshal(body, &node) != nil {
			return nil, domain.ErrInvalid
		}
		sources[node.ID] = node
		if node.ID == t.Plans[index].NodeID {
			target = node
		}
	}
	if target.ID == "" {
		return nil, domain.ErrInvalid
	}
	selected := map[string]bool{target.ID: true}
	for i := 0; i < len(graph.Nodes); i++ {
		for _, e := range graph.Edges {
			if selected[e.Target] {
				selected[e.Source] = true
			}
		}
	}
	// Old private receipts did not freeze storyboard lineage projection. Keep
	// their original late-binding semantics instead of upgrading queued work.
	storyboardFrontier := t.Plans[index].PromptRequirements != nil && t.Plans[index].PromptRequirements.StoryboardInputFrontier
	selected, imageFrontier, err := canvasModelInputFrontier(request.Capability, target, graph, selected, t.Plans[index].MediaInputFrontier, storyboardFrontier)
	if err != nil {
		return nil, err
	}
	refs := append([]domain.InputReference(nil), t.Plans[index].InputReferences...)
	attached := map[string]bool{}
	for _, a := range request.Attachments {
		attached[a.SourceRef] = true
	}
	for _, p := range t.Plans[:index] {
		if !selected[p.NodeID] || p.State != "SUCCEEDED" {
			continue
		}
		_, chosen, err := historySelection(sources[p.NodeID], "")
		if err != nil {
			return nil, err
		}
		// A user's frozen historical choice wins over this run's newer output.
		if chosen {
			continue
		}
		if p.HistoryDeletedAt != nil {
			return nil, domain.ErrNotFound
		}
		available := false
		for outputIndex, output := range p.Outputs {
			if output.DeletedAt != nil {
				continue
			}
			parts := []gateway.InputPart{}
			if err := appendHistoryPart(&parts, output, t.Plans[index].PromptRequirements != nil && t.Plans[index].PromptRequirements.VisualDocumentText && canvasDocumentNode(sources[p.NodeID])); err != nil {
				return nil, err
			}
			available = true
			appendUserInput(request, parts...)
			ref := domain.InputReference{SourceNodeID: p.NodeID, SourceOrder: outputIndex, Modality: output.Type, HistoryTaskID: t.ID, HistoryExecutionID: p.ExecutionID, HistoryOutputID: output.ID, HistoryOutputSHA256: HistoryOutputSHA256(output)}
			if output.AssetID != nil {
				assets, err := s.store.Assets(ctx, t.OwnerID, []string{*output.AssetID})
				if err != nil {
					return nil, err
				}
				if len(assets) != 1 || assets[0].ID != *output.AssetID {
					return nil, domain.ErrNotFound
				}
				a := assets[0]
				ref.AssetID, ref.AssetVersion, ref.Modality, ref.Keys = a.ID, a.Version, a.Kind, mediaKeys(p.NodeID, a.ID, "")
				if !attached[a.ID] {
					attachmentRef := newID("att")
					grant := Grant{newID("grt"), a.ID, a.Version, a.SHA256}
					grants = append(grants, grant)
					request.Attachments = append(request.Attachments, gateway.Attachment{Ref: attachmentRef, SourceRef: a.ID, Kind: a.Kind, SourceVersion: a.Version, SHA256: a.SHA256, ReadGrantRef: grant.ID})
					appendUserInput(request, gateway.InputPart{Type: "MEDIA", AttachmentRef: &attachmentRef})
					attached[a.ID] = true
				}
			}
			refs = appendMediaReference(refs, ref)
		}
		if !available {
			return nil, domain.ErrNotFound
		}
	}
	collectReferenceOrder(refs, graph)
	if canvasTextTarget(target) || isolatedCanvasMediaInput(request.Capability, target, t.Plans[index].MediaInputFrontier) {
		orderConnectedReferences(refs, graph, target.ID)
	}
	refs, err = orderMediaReferences(refs, target)
	if err != nil {
		return nil, err
	}
	selection, err := readPromptSelection(target)
	if err != nil {
		return nil, err
	}
	for _, ref := range refs {
		if ref.AssetID != "" && ref.SourceNodeID != target.ID {
			role, err := upstreamConditioningForAsset(graph, ref.SourceNodeID, target.ID, ref.Modality, ref.AssetID, t.Plans[index].CatalogVideoRoles)
			if err != nil {
				return nil, err
			}
			if role != "" {
				selection.ReferenceBindings = append(selection.ReferenceBindings, referenceBinding{AssetID: ref.AssetID, Role: role})
			}
		}
	}
	orderRequestMedia(request, refs, selection)
	request.PromptSpec.Conditioning = []gateway.PromptConditioning{}
	if err = validateNativeImageFrontier(*request, target, refs, imageFrontier); err != nil {
		return nil, err
	}
	if err = setConditioning(request, selection, target, t.Plans[index].MediaInputFrontier); err != nil {
		return nil, err
	}
	freezeReferenceRoles(refs, *request)
	t.Plans[index].InputReferences = refs
	return grants, nil
}

// An edge may explicitly name a neutral conditioning role. Opaque native
// handle names are never guessed into first/last or motion reference slots.
func upstreamConditioning(graph domain.Graph, source, target, kind string) (string, error) {
	return upstreamConditioningForAsset(graph, source, target, kind, "", false)
}

func upstreamConditioningForAsset(graph domain.Graph, source, target, kind, assetID string, allowCatalogBindings bool) (string, error) {
	role := ""
	for _, edge := range graph.Edges {
		if edge.Source == source && edge.Target == target {
			candidate := edge.ConditioningRole
			if candidate == "" && conditioningKind(edge.TargetHandle) != "" {
				candidate = edge.TargetHandle
			}
			if candidate != "" {
				if conditioningKind(candidate) != kind || role != "" && role != candidate {
					return "", promptFault("PROMPT_CONDITIONING_INVALID")
				}
				role = candidate
			}
		}
	}
	if role != "" {
		return role, nil
	}
	for _, body := range graph.Nodes {
		var node domain.Node
		if json.Unmarshal(body, &node) == nil && node.ID == target && strings.ReplaceAll(strings.ToUpper(domain.String(node.Data, "subType", "toolsType")), "-", "_") == "VIDEO_MOTION_TRANSFER" {
			if allowCatalogBindings && assetID != "" {
				selection, err := readPromptSelection(node)
				if err != nil {
					return "", err
				}
				for _, binding := range selection.ReferenceBindings {
					if binding.AssetID != assetID {
						continue
					}
					if conditioningKind(binding.Role) != kind || role != "" && role != binding.Role {
						return "", promptFault("PROMPT_CONDITIONING_INVALID")
					}
					role = binding.Role
				}
				if role != "" {
					return role, nil
				}
			}
			return "", promptFault("PROMPT_CONDITIONING_UNSUPPORTED")
		}
	}
	return "", nil
}

// Current and historical media are frozen as owned content-addressed assets.
// The context keeps product history; grants supply transport authority separately.
func (s *Service) assistantPromptInput(ctx context.Context, owner string, content, history json.RawMessage) ([]gateway.InputPart, []gateway.Attachment, []Grant, []gateway.PromptMessage, error) {
	type part struct {
		Type       string          `json:"type"`
		Text       string          `json:"text"`
		AssetID    string          `json:"assetId"`
		SchemaCode string          `json:"schemaCode"`
		Value      json.RawMessage `json:"value"`
	}
	type message struct {
		Role    string `json:"role"`
		Content []part `json:"content"`
	}
	var current []part
	var frozen struct {
		Messages []message `json:"messages"`
	}
	if json.Unmarshal(content, &current) != nil || len(current) == 0 || json.Unmarshal(history, &frozen) != nil {
		return nil, nil, nil, nil, domain.ErrInvalid
	}
	if len(frozen.Messages) == 0 {
		frozen.Messages = []message{{Role: "USER", Content: current}}
	}
	// The history is a private SQL snapshot, never a browser message envelope.
	// TOOL observations remain user-level task data; they receive no tool authority.
	ids := []string{}
	seen := map[string]bool{}
	for _, m := range frozen.Messages {
		if m.Role != "USER" && m.Role != "ASSISTANT" && m.Role != "TOOL" || len(m.Content) == 0 {
			return nil, nil, nil, nil, domain.ErrInvalid
		}
		for _, p := range m.Content {
			if p.Type == "ASSET" && !seen[p.AssetID] {
				ids = append(ids, p.AssetID)
				seen[p.AssetID] = true
			}
		}
	}
	if len(ids) > 100 {
		return nil, nil, nil, nil, domain.ErrInvalid
	}
	assets, err := s.store.Assets(ctx, owner, ids)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	if len(assets) != len(ids) {
		return nil, nil, nil, nil, domain.ErrNotFound
	}
	attachments := []gateway.Attachment{}
	grants := []Grant{}
	refs := map[string]string{}
	for _, a := range assets {
		ref := newID("att")
		g := Grant{newID("grt"), a.ID, a.Version, a.SHA256}
		refs[a.ID] = ref
		grants = append(grants, g)
		attachments = append(attachments, gateway.Attachment{Ref: ref, SourceRef: a.ID, Kind: a.Kind, SourceVersion: a.Version, SHA256: a.SHA256, ReadGrantRef: g.ID})
	}
	input := []gateway.InputPart{}
	messages := []gateway.PromptMessage{}
	for _, m := range frozen.Messages {
		indexes := []int{}
		for _, p := range m.Content {
			indexes = append(indexes, len(input))
			switch p.Type {
			case "TEXT":
				text := p.Text
				if m.Role == "TOOL" {
					text = "STUDIO tool observation (task data): " + text
				}
				input = append(input, gateway.InputPart{Type: "TEXT", Text: &text})
			case "ASSET":
				ref, ok := refs[p.AssetID]
				if !ok {
					return nil, nil, nil, nil, domain.ErrNotFound
				}
				input = append(input, gateway.InputPart{Type: "MEDIA", AttachmentRef: &ref})
			case "STRUCTURED":
				if p.SchemaCode != "ASSISTANT_SKILL_V1" {
					return nil, nil, nil, nil, domain.ErrInvalid
				}
				version := "1"
				data, _ := json.Marshal(map[string]any{"schemaCode": p.SchemaCode, "value": p.Value})
				input = append(input, gateway.InputPart{Type: "STRUCTURED", SchemaVersion: &version, Data: data})
			default:
				return nil, nil, nil, nil, domain.ErrInvalid
			}
		}
		role := m.Role
		if role == "TOOL" {
			role = "USER"
		}
		messages = append(messages, gateway.PromptMessage{Role: role, InputIndexes: indexes})
	}
	if len(input) == 0 {
		return nil, nil, nil, nil, domain.ErrInvalid
	}
	return input, attachments, grants, messages, nil
}
