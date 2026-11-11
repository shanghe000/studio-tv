package domain

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrInvalid = errors.New("invalid execution")
var ErrMaterialOnly = fmt.Errorf("%w: material nodes are not generation targets", ErrInvalid)
var ErrNotFound = errors.New("execution not visible")
var ErrConflict = errors.New("execution idempotency conflict")
var ErrCancellationUnsupported = errors.New("running real execution cannot be canceled by this adapter")
var ErrBusy = errors.New("conversation already has a running turn")

type Output struct {
	ID            string          `json:"id"`
	Type          string          `json:"type"`
	Text          *string         `json:"text,omitempty"`
	AssetID       *string         `json:"assetId,omitempty"`
	MimeType      string          `json:"mimeType,omitempty"`
	Width         *int            `json:"width,omitempty"`
	Height        *int            `json:"height,omitempty"`
	DurationMs    *int64          `json:"durationMs,omitempty"`
	SchemaVersion string          `json:"schemaVersion,omitempty"`
	Data          json.RawMessage `json:"data,omitempty"`
	TestMode      bool            `json:"testMode"`
	DeletedAt     *time.Time      `json:"deletedAt,omitempty"`
}
type Plan struct {
	CanvasBinding          *CanvasBinding      `json:"canvasBinding,omitempty"`
	RouterConversationRef  string              `json:"-"`
	PromptRequirements     *PromptRequirements `json:"-"`
	InputBound             bool                `json:"-"`
	MediaInputFrontier     bool                `json:"-"`
	CatalogVideoRoles      bool                `json:"-"`
	VideoCancelUnsupported bool                `json:"-"`
	InputReferences        []InputReference    `json:"-"`
	HistoryDeletedAt       *time.Time          `json:"historyDeletedAt,omitempty"`
	NodeID                 string              `json:"nodeId"`
	ExecutionID            string              `json:"executionId"`
	State                  string              `json:"state"`
	Progress               *float64            `json:"progress"`
	ProgressDetail         *ProgressDetail     `json:"progressDetail,omitempty"`
	CapabilityRef          string              `json:"capabilityRef"`
	CapabilityVersion      string              `json:"capabilityVersion"`
	Parameters             json.RawMessage     `json:"parameters"`
	Input                  json.RawMessage     `json:"-"`
	Request                json.RawMessage     `json:"-"`
	InvocationRef          *string             `json:"-"`
	Outputs                []Output            `json:"outputs"`
	ErrorCode              *string             `json:"errorCode,omitempty"`
	ErrorMessage           *string             `json:"errorMessage,omitempty"`
	NodeSnapshot           json.RawMessage     `json:"nodeSnapshot,omitempty"`
	TestMode               bool                `json:"testMode"`
}

type ProgressDetail struct {
	Phase       string `json:"phase"`
	Scope       string `json:"scope"`
	CurrentStep *int   `json:"currentStep,omitempty"`
	TotalSteps  *int   `json:"totalSteps,omitempty"`
}

// InputReference is a private acceptance record. Browser graph display fields
// cannot supply history authority, content versions, or resolved input order.
type InputReference struct {
	SourceNodeID, AssetID, AssetVersion, Modality, Role string
	Order, SourceOrder                                  int
	Keys                                                []string
	HistoryTaskID, HistoryExecutionID, HistoryOutputID  string
	HistoryOutputSHA256                                 string
}

// Private policy frozen with a selected STUDIO template and persisted separately
// from the public plan. Graph JSON cannot supply it.
type PromptRequirements struct {
	VisualDocumentText      bool `json:"visualDocumentText,omitempty"`
	RequireImage            bool `json:"requireImage"`
	StoryboardInputFrontier bool `json:"storyboardInputFrontier,omitempty"`
}
type Task struct {
	CanvasManaged    bool   `json:"canvasManaged,omitempty"`
	ExpectedRevision *int64 `json:"-"`
	// Creation precondition for the private context read; not a public task field
	// or a new client-supplied revision. Existing task receipts need no recheck.
	ConversationRevision int64           `json:"-"`
	ID                   string          `json:"id"`
	OwnerID              string          `json:"-"`
	InitiatedBy          string          `json:"-"`
	ProjectID            *string         `json:"projectId"`
	ConversationID       *string         `json:"conversationId,omitempty"`
	MessageID            *string         `json:"messageId,omitempty"`
	Kind                 string          `json:"kind"`
	TargetType           string          `json:"targetType"`
	TargetID             string          `json:"targetId"`
	Name                 string          `json:"name"`
	State                string          `json:"state"`
	Revision             int64           `json:"revision"`
	Plans                []Plan          `json:"plans"`
	TestMode             bool            `json:"testMode"`
	Snapshot             json.RawMessage `json:"snapshot,omitempty"`
	Metadata             json.RawMessage `json:"runtimeMetadata,omitempty"`
	ErrorCode            *string         `json:"errorCode,omitempty"`
	ErrorMessage         *string         `json:"errorMessage,omitempty"`
	CreatedAt            time.Time       `json:"createdAt"`
	UpdatedAt            time.Time       `json:"updatedAt"`
}

func Terminal(s string) bool { return s == "SUCCEEDED" || s == "FAILED" || s == "CANCELED" }

type CanvasCommand struct {
	ExpectedRevision *int64          `json:"expectedRevision,omitempty"`
	ProjectID        string          `json:"projectId"`
	TargetType       string          `json:"targetType"`
	TargetID         string          `json:"targetId"`
	Graph            json.RawMessage `json:"graph"`
	Name             string          `json:"name,omitempty"`
	ExecutionKey     string          `json:"executionKey,omitempty"`
}

// CanvasBinding is a server receipt, never a browser-authored node field.
type CanvasBinding struct {
	ApplicationState string `json:"applicationState"`
	Reason           string `json:"reason,omitempty"`
}
type Node struct {
	ID         string                     `json:"id"`
	Type       string                     `json:"type"`
	ParentNode string                     `json:"parentNode"`
	ParentID   string                     `json:"parentId"`
	Data       map[string]json.RawMessage `json:"data"`
}
type Edge struct {
	Source           string `json:"source"`
	Target           string `json:"target"`
	SourceHandle     string `json:"sourceHandle,omitempty"`
	TargetHandle     string `json:"targetHandle,omitempty"`
	ConditioningRole string `json:"conditioningRole,omitempty"`
}
type Graph struct {
	Nodes []json.RawMessage `json:"nodes"`
	Edges []Edge            `json:"edges"`
}

// IsCanvasMaterialNode distinguishes consumed assets from execution targets.
// Some native uploads predate isUpload and carry a default media subType; that
// display mode alone must not schedule a new model task. Any authored model,
// prompt, tool or parameter configuration keeps the legacy execution behavior.
func IsCanvasMaterialNode(n Node) bool {
	var upload bool
	if json.Unmarshal(n.Data["isUpload"], &upload) == nil && upload {
		return true
	}
	if n.Type != "rh-image" && n.Type != "rh-video" && n.Type != "rh-audio" {
		return false
	}
	var source any
	if json.Unmarshal(n.Data["sourceObjects"], &source) != nil {
		return false
	}
	hasSource := false
	switch value := source.(type) {
	case string:
		hasSource = strings.TrimSpace(value) != ""
	case []any:
		for _, item := range value {
			if ref, ok := item.(string); ok && strings.TrimSpace(ref) != "" {
				hasSource = true
				break
			}
		}
	}
	if !hasSource {
		return false
	}
	nonempty := func(raw json.RawMessage) bool {
		var value any
		if len(raw) == 0 || json.Unmarshal(raw, &value) != nil || value == nil {
			return false
		}
		switch value := value.(type) {
		case string:
			return strings.TrimSpace(value) != ""
		case map[string]any:
			return len(value) > 0
		case []any:
			return len(value) > 0
		default:
			return true
		}
	}
	for _, key := range []string{"modelCode", "capabilityRef", "model", "modelId", "model_id", "capabilityVersion", "modelType", "params", "routerParameters", "prompt", "toolsType", "generateNum"} {
		if nonempty(n.Data[key]) {
			return false
		}
	}
	mode := strings.ReplaceAll(strings.ToUpper(String(n.Data, "subType")), "-", "_")
	switch mode {
	case "", "TEXT_IMAGE", "IMAGE_IMAGE", "TEXT_VIDEO", "IMAGE_VIDEO", "TEXT_AUDIO", "AUDIO_AUDIO":
		return true
	default:
		return false
	}
}

func ParseGraph(cmd CanvasCommand) ([]Node, map[string]json.RawMessage, []Edge, error) {
	if len(cmd.ProjectID) < 1 || len(cmd.ProjectID) > 200 || len(cmd.TargetID) > 200 || len(cmd.Name) > 400 || len(cmd.Graph) > 2<<20 {
		return nil, nil, nil, ErrInvalid
	}
	if cmd.TargetType != "NODE" && cmd.TargetType != "GROUP" && cmd.TargetType != "CANVAS" {
		return nil, nil, nil, ErrInvalid
	}
	var g Graph
	if json.Unmarshal(cmd.Graph, &g) != nil || g.Nodes == nil || g.Edges == nil || len(g.Nodes) > 500 || len(g.Edges) > 2000 {
		return nil, nil, nil, ErrInvalid
	}
	nodes := []Node{}
	raw := map[string]json.RawMessage{}
	all := map[string]Node{}
	for _, body := range g.Nodes {
		var n Node
		if json.Unmarshal(body, &n) != nil || n.ID == "" || len(n.ID) > 200 || all[n.ID].ID != "" {
			return nil, nil, nil, ErrInvalid
		}
		all[n.ID] = n
		raw[n.ID] = body
	}
	for _, e := range g.Edges {
		if all[e.Source].ID == "" || all[e.Target].ID == "" || e.Source == e.Target || len(e.SourceHandle) > 200 || len(e.TargetHandle) > 200 || len(e.ConditioningRole) > 64 {
			return nil, nil, nil, ErrInvalid
		}
	}
	selected := map[string]bool{}
	switch cmd.TargetType {
	case "NODE":
		if all[cmd.TargetID].ID == "" {
			return nil, nil, nil, ErrInvalid
		}
		if IsCanvasMaterialNode(all[cmd.TargetID]) {
			return nil, nil, nil, ErrMaterialOnly
		}
		selected[cmd.TargetID] = true
	case "GROUP":
		if all[cmd.TargetID].ID == "" {
			return nil, nil, nil, ErrInvalid
		}
		selected[cmd.TargetID] = true
		for i := 0; i < len(all); i++ {
			for id, n := range all {
				if selected[n.ParentNode] || selected[n.ParentID] {
					selected[id] = true
				}
			}
		}
	case "CANVAS":
		for id := range all {
			selected[id] = true
		}
	}
	// Stable topological order. Cycles are rejected before a job is accepted.
	pending := map[string]bool{}
	for id := range all {
		pending[id] = true
	}
	for len(pending) > 0 {
		progress := false
		for _, body := range g.Nodes {
			var n Node
			_ = json.Unmarshal(body, &n)
			if !pending[n.ID] {
				continue
			}
			ready := true
			for _, e := range g.Edges {
				if e.Target == n.ID && pending[e.Source] {
					ready = false
					break
				}
			}
			if !ready {
				continue
			}
			delete(pending, n.ID)
			progress = true
			if selected[n.ID] && !IsCanvasMaterialNode(n) {
				nodes = append(nodes, n)
			}
		}
		if !progress {
			return nil, nil, nil, ErrInvalid
		}
	}
	return nodes, raw, g.Edges, nil
}
func String(data map[string]json.RawMessage, keys ...string) string {
	for _, key := range keys {
		var s string
		if json.Unmarshal(data[key], &s) == nil && s != "" {
			return s
		}
	}
	return ""
}
func CapabilityKind(n Node) string {
	sub := strings.ToUpper(String(n.Data, "subType", "toolsType", "modelType"))
	if sub == "" {
		sub = strings.ToUpper(n.Type)
	}
	sub = strings.ReplaceAll(sub, "-", "_")
	aliases := map[string]string{
		"TEXT_IMAGE": "TEXT_TO_IMAGE", "IMAGE_IMAGE": "IMAGE_TO_IMAGE", "TEXT_VIDEO": "TEXT_TO_VIDEO", "IMAGE_VIDEO": "IMAGE_TO_VIDEO", "FIRST_LAST_VIDEO": "IMAGE_TO_VIDEO", "START_VIDEO": "IMAGE_TO_VIDEO", "END_VIDEO": "IMAGE_TO_VIDEO", "START_END_VIDEO": "IMAGE_TO_VIDEO", "OMNI_VIDEO": "OMNI_REFERENCE", "MULTIMODAL_VIDEO": "OMNI_REFERENCE",
		"MULTIMODAL_TEXT": "LLM", "MULTIMODAL_STORYBOARD": "LLM", "TEXT_TEXT": "LLM", "TEXT_SCRIPT": "LLM", "SCRIPT_STORYBOARD": "LLM", "VIDEO_ANALYSIS": "LLM", "IMAGE_RECOGNITION": "LLM", "TEXT_LYRICS": "LLM", "IMAGE_TEXT": "LLM", "VIDEO_TEXT": "LLM",
		"IMAGE_REDRAW": "IMAGE_EDIT", "IMAGE_ERASE": "IMAGE_EDIT", "IMAGE_EXPAND": "IMAGE_EDIT", "IMAGE_CUTOUT_TEXT": "IMAGE_CUTOUT", "IMAGE_UPSCALE": "IMAGE_ENHANCE", "IMAGE_GIGAPIXEL": "IMAGE_ENHANCE", "IMAGE_HD": "IMAGE_ENHANCE", "IMAGE_MULTIANGLE": "IMAGE_VARIATION", "IMAGE_LIGHT": "IMAGE_VARIATION", "IMAGE_MULTI_ANGLE": "IMAGE_VARIATION", "IMAGE_MULTI_ANGLE_LIGHT": "IMAGE_VARIATION",
		"VIDEO_VIDEO": "VIDEO_TO_VIDEO", "VIDEO_EDIT": "VIDEO_TO_VIDEO", "VIDEO_EXTEND": "VIDEO_TO_VIDEO", "VIDEO_MOTION_TRANSFER": "VIDEO_TO_VIDEO", "VIDEO_CLIP_RESHOOT": "VIDEO_TO_VIDEO",
		"VIDEO_UPSCALE": "VIDEO_ENHANCE", "VIDEO_HD": "VIDEO_ENHANCE", "VIDEO_EXPAND": "VIDEO_ENHANCE", "VIDEO_REMOVE_WATERMARK": "VIDEO_ENHANCE", "VIDEO_REMOVE_SUBTITLES": "VIDEO_ENHANCE", "VIDEO_REMOVE_BLUR": "VIDEO_ENHANCE", "VIDEO_DENOISE": "VIDEO_ENHANCE", "VIDEO_INTERPOLATION": "VIDEO_ENHANCE", "VIDEO_FRAME_INTERPOLATION": "VIDEO_ENHANCE", "VIDEO_DEPTH_CONVERTER": "VIDEO_DEPTH",
		"TEXT_AUDIO": "TEXT_TO_AUDIO", "TEXT_MUSIC": "TEXT_TO_MUSIC", "TEXT_SONG": "TEXT_TO_MUSIC", "AUDIO_AUDIO": "AUDIO_TO_AUDIO", "VIDEO_AUDIO": "AUDIO_SEPARATION",
		"TEXT_3D": "GENERATE_3D_MODEL", "IMAGE_3D": "GENERATE_3D_MODEL", "TEXT_TO_3D": "GENERATE_3D_MODEL", "IMAGE_TO_3D": "GENERATE_3D_MODEL", "MULTIVIEW_TO_3D": "GENERATE_3D_MODEL", "WORLD_3D": "GENERATE_3D_WORLD", "TEXT_TO_W3D": "GENERATE_3D_WORLD", "IMAGE_TO_W3D": "GENERATE_3D_WORLD", "VIDEO_TO_W3D": "GENERATE_3D_WORLD",
		"RH_IMAGE": "TEXT_TO_IMAGE", "RH_VIDEO": "TEXT_TO_VIDEO", "RH_AUDIO": "TEXT_TO_AUDIO", "RH_TEXT": "LLM", "RH_SCRIPT": "LLM", "RH_STORYBOARD": "LLM", "RH_3D": "GENERATE_3D_MODEL", "RH_WORLD": "GENERATE_3D_WORLD",
	}
	if v := aliases[sub]; v != "" {
		return v
	}
	return sub
}

// RequiresNativeCancellation excludes local media processors, whose process cancellation
// is controlled by STUDIO. A claimed model task may already have started native work.
func (t Task) RequiresNativeCancellation(claimed bool) bool {
	if Terminal(t.State) || (t.Kind != "CANVAS" && t.Kind != "ASSISTANT") {
		return false
	}
	for _, p := range t.Plans {
		if !p.TestMode && !Terminal(p.State) && (claimed || t.State != "QUEUED" || p.InvocationRef != nil) {
			return true
		}
	}
	return false
}
