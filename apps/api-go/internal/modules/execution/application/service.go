package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"studiotv.local/service/api/internal/observability"
	"studiotv.local/service/api/internal/principal"
	"strings"
	"time"
)

type Processor interface {
	Process(context.Context, domain.Task, string) (bool, error)
}
type Service struct {
	store         Store
	gateway       gateway.ExecutionGateway
	importer      AssetImporter
	processor     Processor
	apps          AppCatalog
	styles        StyleCatalog
	canvasContext CanvasContextReader
	realExecution bool
	projectAccess func(context.Context, string, string) (string, error)
}

func New(store Store, g gateway.ExecutionGateway, importer AssetImporter) (*Service, error) {
	if store == nil || g == nil || importer == nil {
		return nil, errors.New("execution ports are required")
	}
	return &Service{store: store, gateway: g, importer: importer}, nil
}

// WithProjectAccess resolves only the storage owner, preserving the true caller.
func (s *Service) WithProjectAccess(f func(context.Context, string, string) (string, error)) {
	s.projectAccess = f
}
func (s *Service) projectScope(ctx context.Context, actor, project string) (context.Context, string, error) {
	actor = principal.Actor(ctx, actor)
	ctx = principal.WithActor(ctx, actor)
	storage := actor
	if s.projectAccess != nil {
		var err error
		storage, err = s.projectAccess(ctx, actor, project)
		if err != nil {
			return ctx, "", err
		}
	}
	return principal.WithProject(ctx, project), storage, nil
}
func taskActor(t domain.Task) string {
	if t.InitiatedBy != "" {
		return t.InitiatedBy
	}
	return t.OwnerID
}
func actorKey(key, actor, storage string) string {
	if actor == storage {
		return key
	}
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte("studio-canvas-actor/"+actor+"/"+key)).String()
}

// WithRealExecution is an explicit deployment policy; credentials alone do not enable inference.
func (s *Service) WithRealExecution(enabled bool) { s.realExecution = enabled }
func (s *Service) CanExecute(c gateway.Capability) bool {
	return c.Available && (c.TestMode || s.realExecution)
}
func (s *Service) WithProcessor(p Processor)               { s.processor = p }
func (s *Service) WithCanvasContext(p CanvasContextReader) { s.canvasContext = p }
func newID(prefix string) string                           { return prefix + "_" + strings.ReplaceAll(uuid.NewString(), "-", "") }
func keyHash(key string, value any) (string, string, error) {
	id, err := uuid.Parse(key)
	if err != nil || id == uuid.Nil {
		return "", "", domain.ErrInvalid
	}
	body, err := json.Marshal(value)
	if err != nil {
		return "", "", domain.ErrInvalid
	}
	var canonical any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err = dec.Decode(&canonical); err != nil {
		return "", "", domain.ErrInvalid
	}
	body, err = json.Marshal(canonical)
	if err != nil {
		return "", "", domain.ErrInvalid
	}
	sum := sha256.Sum256(body)
	return id.String(), hex.EncodeToString(sum[:]), nil
}
func (s *Service) Canvas(ctx context.Context, owner, key string, cmd domain.CanvasCommand) (domain.Task, error) {
	if owner == "" {
		return domain.Task{}, domain.ErrNotFound
	}
	key, hash, err := keyHash(key, cmd)
	if err != nil {
		return domain.Task{}, err
	}
	ctx, storage, err := s.projectScope(ctx, owner, cmd.ProjectID)
	if err != nil {
		return domain.Task{}, err
	}
	key = actorKey(key, principal.Actor(ctx, owner), storage)
	return s.canvas(ctx, storage, key, hash, cmd)
}

func (s *Service) canvas(ctx context.Context, owner, key, hash string, cmd domain.CanvasCommand) (domain.Task, error) {
	nodes, snapshots, edges, err := domain.ParseGraph(cmd)
	if err != nil {
		return domain.Task{}, err
	}
	if cmd.ExpectedRevision != nil {
		if *cmd.ExpectedRevision < 1 || cmd.TargetType != "NODE" || len(nodes) != 1 {
			return domain.Task{}, domain.ErrInvalid
		}
		switch nodes[0].Type {
		case "rh-text", "rh-image", "rh-video", "rh-audio":
		default:
			return domain.Task{}, domain.ErrInvalid
		}
	}
	catalog, err := s.capabilities(ctx, owner, "")
	if err != nil {
		return domain.Task{}, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	t := domain.Task{ID: newID("tsk"), OwnerID: owner, InitiatedBy: principal.Actor(ctx, owner), ProjectID: &cmd.ProjectID, Kind: "CANVAS", TargetType: cmd.TargetType, TargetID: cmd.TargetID, Name: cmd.Name, State: "QUEUED", Revision: 1, Plans: []domain.Plan{}, Snapshot: cmd.Graph, CreatedAt: now, UpdatedAt: now}
	t.ExpectedRevision = cmd.ExpectedRevision
	grants := []Grant{}
	planned := map[string]bool{}
	selectedCapabilities := map[string]gateway.Capability{}
	for _, n := range nodes {
		// References and layout containers are never jobs, even if an imported
		// node retained a model field. Keep their data and edges in the graph.
		switch n.Type {
		case "group", "rh-group", "comment", "rh-comment", "__rhtv_meta", "rh-script-asset", "rh-resource":
			continue
		}
		requested := domain.String(n.Data, "capabilityRef", "modelCode")
		version := domain.String(n.Data, "capabilityVersion")
		var cap gateway.Capability
		for _, c := range catalog.Items {
			if requested != "" && c.Ref == requested || requested == "" && domain.CapabilityKind(n) == c.Kind && gateway.PreferCapability(c, cap) {
				cap = c
				if requested != "" && (version == "" || c.Version == version) {
					break
				}
			}
		}
		if version != "" && (cap.Ref == "" || cap.Version != version) {
			cap, err = s.exactCapability(ctx, owner, requested, version, catalog)
			if err != nil {
				return t, err
			}
		}
		selectedCapabilities[n.ID] = cap
		if cap.Available {
			planned[n.ID] = true
		}
	}
	for _, node := range nodes {
		cap := selectedCapabilities[node.ID]
		if cap.Ref == "" {
			if cmd.TargetType == "NODE" {
				return t, domain.ErrInvalid
			}
			continue
		}
		if !cap.Available {
			if code := gateway.CredentialUnavailableCode(cap); code != "" {
				return t, &gateway.Fault{Code: code}
			}
			return t, &gateway.Fault{Code: "CAPABILITY_UNAVAILABLE"}
		}
		if !s.CanExecute(cap) {
			return t, &gateway.Fault{Code: "MODEL_EXECUTION_DISABLED"}
		}
		selection, e := readPromptSelection(node)
		if e != nil {
			return t, e
		}
		if e = s.resolveStyles(ctx, owner, &selection); e != nil {
			return t, e
		}
		templateKind := cap.Kind
		if cap.Kind == "IMAGE_UNDERSTANDING" {
			templateKind = "LLM"
		}
		template, e := selectTemplate(selection, templateKind)
		if cap.Kind == "IMAGE_UNDERSTANDING" {
			template.requiresImage = true
		}
		if cap.Model != nil && cap.Kind == "IMAGE_TO_IMAGE" {
			template.requiresImage = true
		}
		if e != nil {
			return t, e
		}
		params := node.Data["routerParameters"]
		if len(params) == 0 {
			params = json.RawMessage(`{}`)
		}
		if err = validateParameters(cap, params); err != nil {
			return t, err
		}
		selected := map[string]bool{node.ID: true}
		for i := 0; i < len(snapshots); i++ {
			for _, e := range edges {
				if selected[e.Target] {
					selected[e.Source] = true
				}
			}
		}
		parts := []gateway.InputPart{}
		assetIDs := []string{}
		inputRefs := []domain.InputReference{}
		var frozenGraph domain.Graph
		_ = json.Unmarshal(cmd.Graph, &frozenGraph)
		selected, imageFrontier, e := canvasModelInputFrontier(gateway.CapabilitySelection{Ref: cap.Ref, Version: cap.Version}, node, frozenGraph, selected, canvasMediaCapability(cap))
		if e != nil {
			return t, e
		}
		ordinaryPrompt := (canvasTextTarget(node) || isolatedCanvasMediaInput(gateway.CapabilitySelection{Ref: cap.Ref, Version: cap.Version}, node, canvasMediaCapability(cap))) && len(selection.Messages) == 0 && domain.String(node.Data, "toolsType", "sceneCode", "toolsSourceUrl") == "" && string(node.Data["isStoryboard"]) != "true"
		var direct map[string]bool
		visualDocument := visualDocumentInput(cap)
		inputOrder := frozenGraph.Nodes
		if ordinaryPrompt {
			inputOrder, direct = canvasSourceOrder(frozenGraph, node.ID)
		}
		for _, body := range inputOrder {
			var source domain.Node
			_ = json.Unmarshal(body, &source)
			if !selected[source.ID] {
				continue
			}
			currentProvenance := false
			if source.ID != node.ID {
				query, chosen, selectionErr := historySelection(source, cmd.ProjectID)
				if selectionErr != nil {
					return t, selectionErr
				}
				if chosen {
					h, ref, historyErr := s.selectedHistoryInput(ctx, owner, query)
					if historyErr != nil {
						return t, historyErr
					}
					if historyErr = appendHistoryPart(&parts, h.Output, visualDocument && canvasDocumentNode(source)); historyErr != nil {
						return t, historyErr
					}
					inputRefs = appendMediaReference(inputRefs, ref)
					continue
				}
				if planned[source.ID] {
					continue
				}
				historical, available, historyErr := s.currentHistoryInputs(ctx, owner, cmd.ProjectID, source)
				if historyErr != nil {
					return t, historyErr
				}
				if available {
					if canvasMediaNode(source) && isolatedCanvasMediaInput(gateway.CapabilitySelection{Ref: cap.Ref, Version: cap.Version}, node, canvasMediaCapability(cap)) {
						historical, e = displayedHistoryInputs(source, historical)
						if e != nil {
							return t, e
						}
					}
					for outputIndex, h := range historical {
						ref, historyErr := historyReference(HistoryInputQuery{ProjectID: cmd.ProjectID, NodeID: source.ID, ExecutionID: h.ExecutionID}, h)
						if historyErr != nil {
							return t, historyErr
						}
						if historyErr = appendHistoryPart(&parts, h.Output, visualDocument && canvasDocumentNode(source)); historyErr != nil {
							return t, historyErr
						}
						ref.SourceOrder = outputIndex
						inputRefs = appendMediaReference(inputRefs, ref)
					}
					continue
				}
				currentID, _ := currentHistoryID(source)
				currentProvenance = currentID != ""
			}
			if hasPrivilegedInput(body) {
				return t, promptFault("UNTRUSTED_PROMPT_INSTRUCTIONS")
			}
			// An upstream media node contributes pixels/samples, not the prompt
			// or explicit reference configuration used to produce those samples.
			if source.ID != node.ID && isolatedCanvasMediaInput(gateway.CapabilitySelection{Ref: cap.Ref, Version: cap.Version}, node, canvasMediaCapability(cap)) && canvasMediaNode(source) {
				source.Data = sourceDisplayData(source)
			}
			sourceSelection := selection
			if source.ID != node.ID {
				sourceSelection, e = readPromptSelection(source)
				if e != nil {
					return t, e
				}
				if e = s.resolveStyles(ctx, owner, &sourceSelection); e != nil {
					return t, e
				}
				if styleData := sourceSelection.Conditions["styleLibrary"]; hasSelection(sourceSelection.PresetSelections) {
					version := "1"
					data, _ := json.Marshal(map[string]any{"schemaCode": "STUDIO_PROMPT_CONDITIONS_V1", "sourceNodeRef": source.ID, "conditions": map[string]json.RawMessage{"styleLibrary": styleData}})
					parts = append(parts, gateway.InputPart{Type: "STRUCTURED", SchemaVersion: &version, Data: data})
				}
			}
			text := nodePrompt(source)
			if source.ID != node.ID {
				if currentText, edited := editedSourceText(source); edited {
					text = currentText
				}
			}
			if source.ID == node.ID && len(selection.Messages) > 0 {
				text = ""
			}
			if direct[source.ID] && source.Type == "rh-text" && strings.TrimSpace(nodePrompt(node)) != "" && (string(source.Data["_isPromptTextNode"]) == "true" || string(source.Data["agentCreated"]) == "true" && strings.HasSuffix(domain.String(source.Data, "title", "label"), "提示词")) {
				text = ""
			}
			if text != "" {
				parts = append(parts, gateway.InputPart{Type: "TEXT", Text: &text})
			}
			if applicationInput := source.Data["applicationInput"]; len(applicationInput) > 0 {
				version := "1"
				parts = append(parts, canvasDocumentPart(applicationInput, version, visualDocument && source.ID != node.ID && canvasDocumentNode(source)))
			}
			mediaData := source.Data
			if source.ID == node.ID && isolatedCanvasMediaInput(gateway.CapabilitySelection{Ref: cap.Ref, Version: cap.Version}, node, canvasMediaCapability(cap)) {
				mediaData = canvasGenerationInputData(source)
			}
			if currentProvenance || source.ID != node.ID && (imageFrontier != nil && source.Type == "rh-image" || isolatedCanvasMediaInput(gateway.CapabilitySelection{Ref: cap.Ref, Version: cap.Version}, node, canvasMediaCapability(cap)) && canvasMediaNode(source)) {
				mediaData = sourceDisplayData(source)
			}
			if hasSelection(sourceSelection.PresetSelections) || sourceSelection.nativePanoramaMode {
				mediaNode := source
				mediaNode.Data = mediaData
				mediaData, e = withoutStyleSelectors(mediaNode)
				if e != nil {
					return t, e
				}
			}
			refs, e := mediaReferences(mediaData, source.ID)
			if e != nil {
				return t, e
			}
			for _, ref := range refs {
				inputRefs = appendMediaReference(inputRefs, ref)
			}
		}
		if ordinaryPrompt {
			var mentions []struct{ Type, Text string }
			_ = json.Unmarshal(node.Data["mentionAssets"], &mentions)
			for _, mention := range mentions {
				if strings.EqualFold(mention.Type, "TEXT") {
					if value := strings.TrimSpace(mention.Text); value != "" {
						parts = append(parts, gateway.InputPart{Type: "TEXT", Text: &value})
					}
				}
			}
		}
		seen := map[string]bool{}
		for _, ref := range inputRefs {
			if ref.AssetID != "" && !seen[ref.AssetID] {
				assetIDs = append(assetIDs, ref.AssetID)
				seen[ref.AssetID] = true
			}
		}
		if len(assetIDs) > 100 {
			return t, domain.ErrInvalid
		}
		assets, err := s.store.Assets(ctx, owner, assetIDs)
		if err != nil {
			return t, err
		}
		byID := map[string]Asset{}
		for _, a := range assets {
			byID[a.ID] = a
		}
		if len(byID) != len(assetIDs) {
			return t, domain.ErrNotFound
		}
		if err = validateMediaAssets(cap, assets); err != nil {
			return t, err
		}
		for i := range inputRefs {
			if inputRefs[i].AssetID != "" {
				a := byID[inputRefs[i].AssetID]
				if a.ID == "" {
					return t, domain.ErrNotFound
				}
				inputRefs[i].AssetVersion, inputRefs[i].Modality = a.Version, a.Kind
				if inputRefs[i].SourceNodeID != node.ID {
					role, roleErr := upstreamConditioningForAsset(frozenGraph, inputRefs[i].SourceNodeID, node.ID, a.Kind, a.ID, profiledVideoCapability(cap))
					if roleErr != nil {
						return t, roleErr
					}
					if role != "" {
						selection.ReferenceBindings = append(selection.ReferenceBindings, referenceBinding{AssetID: a.ID, Role: role})
					}
				}
			}
		}
		if canvasTextTarget(node) || isolatedCanvasMediaInput(gateway.CapabilitySelection{Ref: cap.Ref, Version: cap.Version}, node, canvasMediaCapability(cap)) {
			orderConnectedReferences(inputRefs, frozenGraph, node.ID)
		}
		inputRefs, err = orderMediaReferences(inputRefs, node)
		if err != nil {
			return t, err
		}
		attachments := []gateway.Attachment{}
		messageAssets := map[string]bool{}
		for _, message := range selection.Messages {
			for _, id := range message.AssetIDs {
				messageAssets[id] = true
			}
		}
		attachmentRefs := map[string]string{}
		for _, inputRef := range inputRefs {
			if inputRef.AssetID == "" || attachmentRefs[inputRef.AssetID] != "" {
				continue
			}
			a := byID[inputRef.AssetID]
			ref := newID("att")
			grant := Grant{newID("grt"), a.ID, a.Version, a.SHA256}
			grants = append(grants, grant)
			attachments = append(attachments, gateway.Attachment{Ref: ref, SourceRef: a.ID, Kind: a.Kind, SourceVersion: a.Version, SHA256: a.SHA256, ReadGrantRef: grant.ID})
			attachmentRefs[a.ID] = ref
			if !messageAssets[a.ID] {
				parts = append(parts, gateway.InputPart{Type: "MEDIA", AttachmentRef: &ref})
			}
		}
		if len(parts) == 0 && len(selection.Messages) == 0 {
			version := "1"
			body, _ := json.Marshal(map[string]string{"kind": cap.Kind, "nodeRef": node.ID})
			parts = append(parts, gateway.InputPart{Type: "STRUCTURED", SchemaVersion: &version, Data: body})
		}
		eid := newID("exe")
		request := gateway.InvocationRequest{SchemaVersion: "1", OperationRef: eid, Capability: gateway.CapabilitySelection{Ref: cap.Ref, Version: cap.Version}, Correlation: &gateway.Correlation{ProjectRef: cmd.ProjectID}, Input: []gateway.InputPart{}, Attachments: attachments, Parameters: params, ParameterSchemaVersion: cap.ParameterSchemaVersion, PromptSpec: template.spec()}
		appendUserInput(&request, parts...)
		for _, message := range selection.Messages {
			indexes := []int{}
			if message.Text != nil {
				indexes = append(indexes, len(request.Input))
				request.Input = append(request.Input, gateway.InputPart{Type: "TEXT", Text: message.Text})
			}
			for _, id := range message.AssetIDs {
				ref, exists := attachmentRefs[id]
				if !exists {
					return t, domain.ErrNotFound
				}
				indexes = append(indexes, len(request.Input))
				request.Input = append(request.Input, gateway.InputPart{Type: "MEDIA", AttachmentRef: &ref})
			}
			request.PromptSpec.Messages = append(request.PromptSpec.Messages, gateway.PromptMessage{Role: message.Role, InputIndexes: indexes})
		}
		appendPromptConditions(&request, selection)
		if err = validateNativeImageFrontier(request, node, inputRefs, imageFrontier); err != nil {
			return t, err
		}
		if err = setConditioning(&request, selection, node, canvasMediaCapability(cap)); err != nil {
			return t, err
		}
		freezeReferenceRoles(inputRefs, request)
		// Model dependencies are bound at execution time. Validate reference
		// requirements then, after their real upstream artifacts are available.
		preflightTemplate := template
		if len(assets) == 0 {
			for _, edge := range edges {
				if selected[edge.Source] && planned[edge.Source] {
					preflightTemplate.requiresImage = false
				}
			}
		}
		if err = validatePromptInputs(request, cap, preflightTemplate); err != nil {
			return t, err
		}
		raw, _ := json.Marshal(request)
		input, _ := json.Marshal(request.Input)
		t.Plans = append(t.Plans, domain.Plan{NodeID: node.ID, ExecutionID: eid, State: "QUEUED", CapabilityRef: cap.Ref, CapabilityVersion: cap.Version, Parameters: params, Input: input, Request: raw, InputReferences: inputRefs, MediaInputFrontier: canvasMediaCapability(cap), CatalogVideoRoles: profiledVideoCapability(cap), VideoCancelUnsupported: !cap.TestMode && profiledVideoCapability(cap) && !cap.SupportsCancel, Outputs: []domain.Output{}, NodeSnapshot: snapshots[node.ID], TestMode: cap.TestMode, PromptRequirements: &domain.PromptRequirements{RequireImage: template.requiresImage, StoryboardInputFrontier: true, VisualDocumentText: visualDocument}})
		t.TestMode = t.TestMode || cap.TestMode
	}
	if len(t.Plans) == 0 {
		return t, domain.ErrInvalid
	}
	return s.store.Create(ctx, t, key, hash, grants)
}
func validateParameters(cap gateway.Capability, raw json.RawMessage) error {
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return domain.ErrInvalid
	}
	if credentialParameter(value) {
		return promptFault("PROVIDER_CREDENTIAL_PARAMETER_FORBIDDEN")
	}
	var schema map[string]any
	if json.Unmarshal(cap.ParameterSchema, &schema) != nil {
		return &gateway.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	if compiler.AddResource("https://capability.local/schema", schema) != nil {
		return &gateway.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	compiled, err := compiler.Compile("https://capability.local/schema")
	if err != nil {
		return &gateway.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	if compiled.Validate(value) != nil {
		return domain.ErrInvalid
	}
	return nil
}
func mediaIDs(data map[string]json.RawMessage) ([]string, error) {
	refs, err := mediaReferences(data, "")
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, ref := range refs {
		ids = append(ids, ref.AssetID)
	}
	return ids, nil
}

type AssistantCommand struct {
	CapabilityRef     string          `json:"capabilityRef"`
	CapabilityVersion string          `json:"capabilityVersion"`
	MessageID         string          `json:"messageId"`
	Parameters        json.RawMessage `json:"parameters"`
}

func (s *Service) Assistant(ctx context.Context, owner, cid, key string, cmd AssistantCommand) (domain.Task, error) {
	key, hash, err := keyHash(key, struct {
		ConversationID string
		Command        AssistantCommand
	}{cid, cmd})
	if err != nil {
		return domain.Task{}, err
	}
	input, err := s.store.Conversation(ctx, owner, cid, cmd.MessageID)
	if err != nil {
		return domain.Task{}, err
	}
	if input.ProjectID != nil {
		var e error
		ctx, _, e = s.projectScope(ctx, owner, *input.ProjectID)
		if e != nil {
			return domain.Task{}, e
		}
	}
	ctx = principal.WithProject(ctx, "") // Private conversation inputs use the actual caller read grants.
	catalog, err := s.capabilities(ctx, owner, "")
	if err != nil {
		return domain.Task{}, err
	}
	var cap gateway.Capability
	for _, c := range catalog.Items {
		if c.Ref == cmd.CapabilityRef && c.Version == cmd.CapabilityVersion {
			cap = c
			break
		}
	}
	if cap.Ref == "" && cmd.CapabilityVersion != "" {
		cap, err = s.exactCapability(ctx, owner, cmd.CapabilityRef, cmd.CapabilityVersion, catalog)
		if err != nil {
			return domain.Task{}, err
		}
	}
	if cap.Ref == "" || !textualCapability(cap) || !cap.Available {
		return domain.Task{}, domain.ErrInvalid
	}
	if !s.CanExecute(cap) {
		return domain.Task{}, &gateway.Fault{Code: "MODEL_EXECUTION_DISABLED"}
	}
	template, configured := assistantTemplate(input.Kind)
	if cap.Kind == "IMAGE_UNDERSTANDING" {
		template.requiresImage = true
	}
	if !configured {
		return domain.Task{}, promptFault("PROMPT_TEMPLATE_NOT_CONFIGURED")
	}
	if err = validateParameters(cap, cmd.Parameters); err != nil {
		return domain.Task{}, err
	}
	parts, attachments, grants, messages, err := s.assistantPromptInput(ctx, owner, input.Content, input.Context)
	if err != nil {
		return domain.Task{}, err
	}
	hasCanvasContext := input.Kind == "CANVAS" && input.ProjectID != nil && s.canvasContext != nil
	if hasCanvasContext {
		canvas, readErr := s.canvasContext.ReadCanvasContext(ctx, owner, *input.ProjectID)
		if readErr != nil {
			return domain.Task{}, readErr
		}
		parts, messages, err = appendCanvasContext(parts, messages, canvas)
		if err != nil {
			return domain.Task{}, err
		}
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	eid := newID("exe")
	t := domain.Task{ID: newID("tsk"), OwnerID: owner, InitiatedBy: principal.Actor(ctx, owner), ProjectID: input.ProjectID, ConversationID: &cid, ConversationRevision: input.Revision, MessageID: &cmd.MessageID, Kind: "ASSISTANT", TargetType: "CONVERSATION", TargetID: cid, State: "QUEUED", Revision: 1, TestMode: cap.TestMode, CreatedAt: now, UpdatedAt: now}
	routerConversation := routerConversationKey(cid, cmd.MessageID, cap, input)
	if hasCanvasContext {
		routerConversation = canvasRouterConversationKey(cid, cmd.MessageID, cap)
	}
	request := gateway.InvocationRequest{SchemaVersion: "1", OperationRef: eid, Capability: gateway.CapabilitySelection{Ref: cap.Ref, Version: cap.Version}, Correlation: &gateway.Correlation{ConversationRef: routerConversation}, Input: parts, Attachments: attachments, Parameters: cmd.Parameters, ParameterSchemaVersion: cap.ParameterSchemaVersion, ContextSnapshot: input.Context, PromptSpec: template.spec()}
	request.PromptSpec.Messages = messages
	if err = setConditioning(&request, promptSelection{}, domain.Node{}); err != nil {
		return domain.Task{}, err
	}
	if err = validatePromptInputs(request, cap, template); err != nil {
		return domain.Task{}, err
	}
	if err = s.validateRequestMedia(ctx, owner, cap, request); err != nil {
		return domain.Task{}, err
	}
	if input.ProjectID != nil {
		request.Correlation.ProjectRef = *input.ProjectID
	}
	raw, _ := json.Marshal(request)
	t.Plans = []domain.Plan{{NodeID: cid, ExecutionID: eid, State: "QUEUED", CapabilityRef: cap.Ref, CapabilityVersion: cap.Version, Parameters: cmd.Parameters, Request: raw, Outputs: []domain.Output{}, TestMode: cap.TestMode, PromptRequirements: &domain.PromptRequirements{RequireImage: template.requiresImage}, RouterConversationRef: routerConversation, VideoCancelUnsupported: !cap.TestMode && profiledVideoCapability(cap) && !cap.SupportsCancel}}
	return s.store.Create(ctx, t, key, hash, grants)
}

func (s *Service) capabilities(ctx context.Context, owner, kind string) (gateway.CapabilityPage, error) {
	all := gateway.CapabilityPage{Items: []gateway.Capability{}}
	cursor := ""
	seen := map[string]bool{}
	refs := map[string]bool{}
	for page := 0; page < 100; page++ {
		result, err := s.gateway.Capabilities(ctx, gateway.Actor{SubjectRef: principal.Actor(ctx, owner)}, gateway.CapabilityQuery{Kind: kind, Cursor: cursor, Limit: 100})
		if err != nil {
			return all, err
		}
		for _, capability := range result.Items {
			key := capability.Ref + "/" + capability.Version
			if refs[key] {
				return all, promptFault("PROTOCOL_MISMATCH")
			}
			refs[key] = true
			all.Items = append(all.Items, capability)
		}
		if result.NextCursor == nil || *result.NextCursor == "" {
			return all, nil
		}
		cursor = *result.NextCursor
		if seen[cursor] || len(result.Items) == 0 {
			return all, promptFault("PROTOCOL_MISMATCH")
		}
		seen[cursor] = true
	}
	return all, promptFault("PROTOCOL_MISMATCH")
}

// exactCapability never substitutes latest metadata for a frozen selection.
// Legacy gateways without the optional extension may use only a catalog item
// that already matches both parts; configured gateways always query the pair.
func (s *Service) exactCapability(ctx context.Context, owner, ref, version string, catalog gateway.CapabilityPage) (gateway.Capability, error) {
	if owner == "" {
		return gateway.Capability{}, domain.ErrNotFound
	}
	if !gateway.ValidCapabilityVersionQuery(ref, version) {
		return gateway.Capability{}, domain.ErrInvalid
	}
	if exact, ok := s.gateway.(gateway.ExactCapabilityGateway); ok {
		cap, err := exact.CapabilityVersion(ctx, gateway.Actor{SubjectRef: principal.Actor(ctx, owner)}, ref, version)
		if err != nil {
			return gateway.Capability{}, err
		}
		if cap.Ref != ref || cap.Version != version {
			return gateway.Capability{}, promptFault("PROTOCOL_MISMATCH")
		}
		return cap, nil
	}
	for _, cap := range catalog.Items {
		if cap.Ref == ref && cap.Version == version {
			return cap, nil
		}
	}
	return gateway.Capability{}, promptFault("CAPABILITY_NOT_FOUND")
}

func (s *Service) frozenCapability(ctx context.Context, owner, ref, version string) (gateway.Capability, error) {
	if _, ok := s.gateway.(gateway.ExactCapabilityGateway); ok {
		return s.exactCapability(ctx, owner, ref, version, gateway.CapabilityPage{})
	}
	catalog, err := s.capabilities(ctx, owner, "")
	if err != nil {
		return gateway.Capability{}, err
	}
	return s.exactCapability(ctx, owner, ref, version, catalog)
}
func (s *Service) Get(ctx context.Context, owner, id string) (domain.Task, error) {
	return s.store.Get(ctx, owner, id)
}
func (s *Service) Cancel(ctx context.Context, owner, id string) (domain.Task, error) {
	current, e := s.store.Get(ctx, owner, id)
	if e != nil {
		return current, e
	}
	if !domain.Terminal(current.State) {
		for _, p := range current.Plans {
			if strings.HasPrefix(p.CapabilityRef, "h3-") || p.VideoCancelUnsupported {
				return current, promptFault("VIDEO_CANCEL_UNSUPPORTED")
			}
		}
	}
	t, err := s.store.Cancel(ctx, owner, id)
	if err != nil {
		return t, err
	}
	ctx = principal.WithActor(ctx, taskActor(t))
	for _, p := range t.Plans {
		if p.InvocationRef != nil {
			_, _ = s.gateway.Cancel(ctx, gateway.Actor{SubjectRef: principal.Actor(ctx, owner)}, *p.InvocationRef, gateway.CancelRequest{})
		}
	}
	return t, nil
}
func (s *Service) Events(ctx context.Context, owner, id string, after int64) (EventPage, error) {
	return s.store.Events(ctx, owner, id, after)
}
func (s *Service) History(ctx context.Context, owner string, q HistoryQuery) (HistoryPage, error) {
	return s.store.History(ctx, owner, q)
}
func (s *Service) DeleteHistory(ctx context.Context, owner string, ids []string) ([]string, error) {
	return s.store.DeleteHistory(ctx, owner, ids)
}
func (s *Service) DeleteOutput(ctx context.Context, owner, eid, oid string, rev int64) (domain.Task, error) {
	return s.store.DeleteOutput(ctx, owner, eid, oid, rev)
}

// Run owns no HTTP request lifetime. Leases allow a new process to resume work.
func (s *Service) Run(ctx context.Context) {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			lease := uuid.NewString()
			t, ok, err := s.store.Claim(ctx, lease)
			if err != nil || !ok {
				continue
			}
			job, cancel := context.WithTimeout(ctx, 5*time.Minute)
			heartbeatDone := make(chan struct{})
			go func() { defer close(heartbeatDone); s.heartbeat(job, cancel, t.ID, lease) }()
			s.execute(job, t, lease)
			cancel()
			<-heartbeatDone
		}
	}
}
func (s *Service) execute(ctx context.Context, t domain.Task, lease string) {
	ctx = observability.WithLogID(ctx, observability.TaskLogID(t.ID))
	ctx = principal.WithActor(ctx, taskActor(t))
	if t.Kind != "CANVAS" && t.Kind != "ASSISTANT" {
		if s.processor != nil {
			_, _ = s.processor.Process(ctx, t, lease)
		}
		return
	}
	ctx = principal.WithActor(ctx, taskActor(t))
	if t.ProjectID != nil && t.Kind == "CANVAS" {
		ctx = principal.WithProject(ctx, *t.ProjectID)
	}
	actor := gateway.Actor{SubjectRef: taskActor(t)}
	t.State = "RUNNING"
	if ok, err := s.store.Save(ctx, t, lease); err != nil || !ok {
		return
	}
	var activePlan *domain.Plan
	fail := func(err error) {
		if ctx.Err() != nil {
			return
		}
		var fault *gateway.Fault
		if errors.As(err, &fault) && fault.Retryable {
			if recorder, ok := s.store.(interface {
				RecordRetry(context.Context, domain.Task, string)
			}); ok {
				recorder.RecordRetry(ctx, t, fault.Code)
			}
			return
		}
		code := "MODEL_EXECUTION_FAILED"
		if errors.As(err, &fault) {
			code = fault.Code
		}
		t.State = "FAILED"
		t.ErrorCode = &code
		var media *MediaInputError
		if errors.As(err, &media) {
			if message, ok := domain.MediaErrorMessage(code, &media.Message); ok {
				t.ErrorMessage = &message
				if activePlan != nil {
					activePlan.ErrorMessage = &message
				}
			}
		}
		_, knownOfficial := gateway.OfficialVideoErrorMessage(code)
		if (knownOfficial || code == "MEDIA_INPUT_INVALID") && activePlan != nil {
			activePlan.State = "FAILED"
			activePlan.ErrorCode = &code
		}
		_, _ = s.store.Save(ctx, t, lease)
	}
	if t.ProjectID != nil {
		if s.projectAccess == nil && taskActor(t) != t.OwnerID {
			fail(promptFault("PROJECT_ACCESS_REVOKED"))
			return
		}
		if s.projectAccess != nil {
			storage, e := s.projectAccess(ctx, taskActor(t), *t.ProjectID)
			if e != nil || t.Kind == "CANVAS" && storage != t.OwnerID {
				fail(promptFault("PROJECT_ACCESS_REVOKED"))
				return
			}
		}
	}
	// A receipt cannot change the capability mode frozen into the plan.
	rejectReceiptMode := func(p *domain.Plan, inv gateway.Invocation) bool {
		if inv.TestMode == p.TestMode && (inv.TestMode || s.realExecution) {
			return false
		}
		p.InvocationRef = &inv.Ref
		p.State = "FAILED"
		code := "MODEL_RECEIPT_MODE_MISMATCH"
		p.ErrorCode = &code
		fail(promptFault(code))
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, _ = s.gateway.Cancel(cleanup, actor, inv.Ref, gateway.CancelRequest{})
		cancel()
		return true
	}
	for i := range t.Plans {
		p := &t.Plans[i]
		activePlan = p
		if p.State == "SUCCEEDED" {
			continue
		}
		var request gateway.InvocationRequest
		if json.Unmarshal(p.Request, &request) != nil {
			fail(domain.ErrInvalid)
			return
		}
		if request.Capability.Ref != p.CapabilityRef || request.Capability.Version != p.CapabilityVersion || !gateway.ValidCapabilityVersionQuery(p.CapabilityRef, p.CapabilityVersion) {
			fail(promptFault("PROTOCOL_MISMATCH"))
			return
		}
		if t.ConversationID != nil {
			conversation := p.RouterConversationRef
			if conversation == "" {
				conversation = *t.ConversationID
			}
			session, err := s.gateway.EnsureSession(ctx, actor, conversation)
			if err != nil {
				fail(err)
				return
			}
			request.SessionRef = &session.Ref
		}
		if p.InvocationRef == nil {
			if t.ProjectID != nil && s.projectAccess != nil {
				if _, err := s.projectAccess(ctx, taskActor(t), *t.ProjectID); err != nil {
					fail(promptFault("PROJECT_ACCESS_REVOKED"))
					return
				}
			}
			if request.PromptSpec == nil || p.PromptRequirements == nil {
				fail(promptFault("PROMPT_SPEC_INVALID"))
				return
			}
			if !p.InputBound {
				grants, err := s.bindUpstream(ctx, t, i, &request)
				if err != nil {
					fail(err)
					return
				}
				if len(grants) > 0 || len(p.InputReferences) > 0 || len(request.Attachments) > 0 {
					binder, ok := s.store.(inputBinder)
					if !ok {
						fail(domain.ErrInvalid)
						return
					}
					ok, err = binder.BindInputs(ctx, t, lease, grants)
					if err != nil {
						fail(err)
						return
					}
					if !ok {
						return
					}
				}
				p.InputBound = true
				p.Request, _ = json.Marshal(request)
				p.Input, _ = json.Marshal(request.Input)
				if ok, err := s.store.Save(ctx, t, lease); err != nil || !ok {
					return
				}
			} else if len(p.InputReferences) > 0 || len(request.Attachments) > 0 {
				binder, ok := s.store.(inputBinder)
				if !ok {
					fail(domain.ErrInvalid)
					return
				}
				alive, err := binder.BindInputs(ctx, t, lease, nil)
				if err != nil {
					fail(err)
					return
				}
				if !alive {
					return
				}
			}
			cap, err := s.frozenCapability(ctx, t.OwnerID, p.CapabilityRef, p.CapabilityVersion)
			if err != nil {
				fail(err)
				return
			}
			if !cap.Available {
				if code := gateway.CredentialUnavailableCode(cap); code != "" {
					fail(promptFault(code))
					return
				}
			}
			if !s.CanExecute(cap) || cap.TestMode != p.TestMode {
				fail(promptFault("MODEL_EXECUTION_DISABLED"))
				return
			}
			if request.ParameterSchemaVersion != cap.ParameterSchemaVersion {
				fail(promptFault("PROTOCOL_MISMATCH"))
				return
			}
			if err = validateParameters(cap, request.Parameters); err != nil {
				fail(err)
				return
			}
			template := promptTemplate{requiresImage: p.PromptRequirements.RequireImage || cap.Model != nil && cap.Kind == "IMAGE_TO_IMAGE"}
			if err = validatePromptInputs(request, cap, template); err != nil {
				fail(err)
				return
			}
			if err = s.validateRequestMedia(ctx, t.OwnerID, cap, request); err != nil {
				fail(err)
				return
			}
			idemp := uuid.NewSHA1(uuid.NameSpaceOID, []byte(p.ExecutionID)).String()
			inv, err := s.gateway.Submit(ctx, actor, gateway.Submission{IdempotencyKey: idemp, Request: request})
			if err != nil {
				fail(err)
				return
			}
			if rejectReceiptMode(p, inv) {
				return
			}
			p.InvocationRef = &inv.Ref
			p.State = "RUNNING"
			p.TestMode = inv.TestMode
			t.TestMode = t.TestMode || inv.TestMode
			if ok, err := s.store.Save(ctx, t, lease); err != nil || !ok {
				cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				_, _ = s.gateway.Cancel(cleanup, actor, inv.Ref, gateway.CancelRequest{})
				cancel()
				return
			}
		}
		var inv gateway.Invocation
		for {
			if t.ProjectID != nil && s.projectAccess != nil {
				storage, e := s.projectAccess(ctx, taskActor(t), *t.ProjectID)
				if e != nil || t.Kind == "CANVAS" && storage != t.OwnerID {
					cleanup, cancel := context.WithTimeout(principal.WithActor(context.Background(), taskActor(t)), 5*time.Second)
					_, _ = s.gateway.Cancel(cleanup, actor, *p.InvocationRef, gateway.CancelRequest{})
					cancel()
					fail(promptFault("PROJECT_ACCESS_REVOKED"))
					return
				}
			}
			var err error
			inv, err = s.gateway.Invocation(ctx, actor, *p.InvocationRef)
			if err != nil {
				fail(err)
				return
			}
			if rejectReceiptMode(p, inv) {
				return
			}
			if domain.Terminal(inv.State) {
				break
			}
			if observePlanProgress(p, inv) {
				if ok, err := s.store.Save(ctx, t, lease); err != nil || !ok {
					return
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(250 * time.Millisecond):
			}
			if current, err := s.store.Get(ctx, taskActor(t), t.ID); err != nil || current.State == "CANCELED" {
				if err != nil {
					fail(promptFault("PROJECT_ACCESS_REVOKED"))
				}
				return
			}
		}
		partialImages := hasPartialImageBatch(request, inv)
		if inv.State != "SUCCEEDED" && !partialImages {
			observePlanProgress(p, inv)
			p.State = inv.State
			t.State = inv.State
			if inv.NormalizedError != nil {
				code := inv.NormalizedError.Code
				p.ErrorCode = &code
				t.ErrorCode = &code
				if message, ok := domain.MediaErrorMessage(code, &inv.NormalizedError.Message); ok {
					p.ErrorMessage, t.ErrorMessage = &message, &message
				}
			}
			_, _ = s.store.Save(ctx, t, lease)
			return
		}
		if err := validatePromptOutput(request, inv); err != nil {
			fail(err)
			return
		}
		outputs := []domain.Output{}
		artifacts := map[string]gateway.Artifact{}
		for _, a := range inv.Artifacts {
			artifacts[a.Ref] = a
		}
		for _, part := range inv.OutputParts {
			out := domain.Output{ID: part.OutputRef, Type: part.Type, TestMode: inv.TestMode || part.TestMode}
			switch part.Type {
			case "TEXT":
				if part.Text == nil {
					fail(domain.ErrInvalid)
					return
				}
				out.Text = part.Text
				if request.PromptSpec != nil && request.PromptSpec.OutputContract != nil && request.PromptSpec.OutputContract.Type == "JSON_SCHEMA" {
					// Validation above has already checked this exact output against the frozen schema.
					out.Type, out.SchemaVersion, out.Data, out.Text = "STRUCTURED", "1", json.RawMessage(*part.Text), nil
				}
			case "ARTIFACT":
				out.Type = "ASSET"
				if part.ArtifactRef == nil || t.ProjectID == nil {
					fail(domain.ErrInvalid)
					return
				}
				art, exists := artifacts[*part.ArtifactRef]
				if !exists || art.OutputRef != part.OutputRef {
					fail(domain.ErrInvalid)
					return
				}
				body, err := s.gateway.ArtifactContent(ctx, actor, art)
				if err != nil {
					fail(err)
					return
				}
				a, err := s.importer.Import(ctx, t.OwnerID, *t.ProjectID, p.ExecutionID+"/"+part.OutputRef, art, body)
				if err != nil {
					fail(err)
					return
				}
				out.AssetID = &a.ID
				out.MimeType = a.MimeType
				out.Width = a.Width
				out.Height = a.Height
				out.DurationMs = a.DurationMs
			case "STRUCTURED":
				if part.SchemaVersion == nil || !json.Valid(part.Data) {
					fail(domain.ErrInvalid)
					return
				}
				out.SchemaVersion = *part.SchemaVersion
				out.Data = part.Data
			default:
				fail(domain.ErrInvalid)
				return
			}
			outputs = append(outputs, out)
		}
		p.Outputs = outputs
		p.State = inv.State
		if inv.State == "SUCCEEDED" {
			completePlanProgress(p)
		} else {
			observePlanProgress(p, inv)
		}
		metadata, _ := json.Marshal(map[string]any{"execution": inv.Execution, "usage": inv.Usage, "context": inv.Context, "testMode": inv.TestMode})
		t.Metadata = metadata
		if partialImages {
			t.State = inv.State
			if inv.NormalizedError != nil {
				code := inv.NormalizedError.Code
				p.ErrorCode, t.ErrorCode = &code, &code
			}
		}
		if ok, err := s.store.Save(ctx, t, lease); err != nil || !ok {
			return
		}
		if partialImages {
			return
		}
	}
	t.State = "SUCCEEDED"
	_, _ = s.store.Save(ctx, t, lease)
}
func (s *Service) HistoryDetail(ctx context.Context, owner, eid string) (History, error) {
	reader, ok := s.store.(interface {
		HistoryDetail(context.Context, string, string) (History, error)
	})
	if !ok {
		return History{}, domain.ErrInvalid
	}
	return reader.HistoryDetail(ctx, owner, eid)
}
func Description(t domain.Task) string { return fmt.Sprintf("%s:%s", t.Kind, t.State) }

func (s *Service) DeleteHistoryIdempotent(ctx context.Context, owner, key string, ids []string) ([]string, error) {
	key, hash, err := keyHash(key, ids)
	if err != nil {
		return nil, err
	}
	store, ok := s.store.(interface {
		DeleteHistoryIdempotent(context.Context, string, []string, string, string) ([]string, error)
	})
	if !ok {
		return nil, domain.ErrInvalid
	}
	return store.DeleteHistoryIdempotent(ctx, owner, ids, key, hash)
}

func (s *Service) ActiveAssistant(ctx context.Context, owner, cid string) ([]domain.Task, error) {
	if owner == "" || cid == "" {
		return nil, domain.ErrNotFound
	}
	port, ok := s.store.(interface {
		ActiveAssistant(context.Context, string, string) ([]domain.Task, error)
	})
	if !ok {
		return nil, &gateway.Fault{Code: "NOT_IMPLEMENTED"}
	}
	return port.ActiveAssistant(ctx, owner, cid)
}
