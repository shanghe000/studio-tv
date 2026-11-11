package observability

import "slices"

// ClientSnapshot contains the browser's bounded view of a submission attempt.
// Numeric node indexes are local to the snapshot and cannot carry URLs, prompts
// or arbitrary node data. The authenticated request supplies project and actor.
type SnapshotClick struct {
	Visible      bool  `json:"visible"`
	Disabled     bool  `json:"disabled"`
	AriaDisabled *bool `json:"ariaDisabled,omitempty"`
}
type SnapshotDom struct {
	Host                bool  `json:"host"`
	Draggable           *bool `json:"draggable,omitempty"`
	Dragging            *bool `json:"dragging,omitempty"`
	Selected            *bool `json:"selected,omitempty"`
	BusyOverlay         *bool `json:"busyOverlay,omitempty"`
	CancelVisible       *bool `json:"cancelVisible,omitempty"`
	GenerateVisible     bool  `json:"generateVisible"`
	GenerateDisabled    *bool `json:"generateDisabled,omitempty"`
	ControlAriaDisabled *bool `json:"controlAriaDisabled,omitempty"`
	ReadOnly            *bool `json:"readOnly,omitempty"`
	Group               *bool `json:"group,omitempty"`
}
type SnapshotProjection struct {
	MountedTarget     bool   `json:"mountedTarget"`
	CommandTarget     bool   `json:"commandTarget"`
	MountedMaxConnect string `json:"mountedMaxConnect"`
	CommandMaxConnect string `json:"commandMaxConnect"`
	MountedInputs     int    `json:"mountedInputs"`
	CommandInputs     int    `json:"commandInputs"`
	AddedSources      int    `json:"addedSources"`
	RemovedSources    int    `json:"removedSources"`
	OrderChanged      bool   `json:"orderChanged"`
}
type ClientSnapshot struct {
	Click         *SnapshotClick      `json:"click,omitempty"`
	Dom           *SnapshotDom        `json:"dom,omitempty"`
	Projection    *SnapshotProjection `json:"projection,omitempty"`
	Source        string              `json:"source,omitempty"`
	SchemaVersion string              `json:"schemaVersion"`
	Phase         string              `json:"phase"`
	Control       string              `json:"control"`
	TargetType    string              `json:"targetType"`
	NodeCount     int                 `json:"nodeCount"`
	EdgeCount     int                 `json:"edgeCount"`
	Incoming      int                 `json:"incoming"`
	Outgoing      int                 `json:"outgoing"`
	Children      int                 `json:"children"`
	Target        *int                `json:"target,omitempty"`
	CommandNodes  *int                `json:"commandNodes,omitempty"`
	CommandEdges  *int                `json:"commandEdges,omitempty"`
	Nodes         []SnapshotNode      `json:"nodes"`
	Links         []SnapshotLink      `json:"links"`
	Revision      *int64              `json:"revision,omitempty"`
	PendingSync   *bool               `json:"pendingSync,omitempty"`
	SyncBlocked   *bool               `json:"syncBlocked,omitempty"`
	SyncBusy      *bool               `json:"syncBusy,omitempty"`
}

type SnapshotNode struct {
	ParentMismatch  bool   `json:"parentMismatch,omitempty"`
	X               *int   `json:"x,omitempty"`
	Y               *int   `json:"y,omitempty"`
	Dragging        bool   `json:"dragging,omitempty"`
	HistoryCount    int    `json:"historyCount"`
	PortraitResult  bool   `json:"portraitResult,omitempty"`
	PoseReference   bool   `json:"poseReference,omitempty"`
	PromptHidden    bool   `json:"promptHidden,omitempty"`
	Index           int    `json:"index"`
	Kind            string `json:"kind"`
	Parent          *int   `json:"parent,omitempty"`
	Selected        bool   `json:"selected,omitempty"`
	Draggable       *bool  `json:"draggable,omitempty"`
	Selectable      *bool  `json:"selectable,omitempty"`
	ParentExtent    bool   `json:"parentExtent,omitempty"`
	Status          string `json:"status,omitempty"`
	Tool            string `json:"tool,omitempty"`
	Upload          bool   `json:"upload,omitempty"`
	Generating      bool   `json:"generating,omitempty"`
	HasTask         bool   `json:"hasTask,omitempty"`
	HasModel        bool   `json:"hasModel,omitempty"`
	HistorySelected bool   `json:"historySelected,omitempty"`
	Outputs         int    `json:"outputs"`
	Sources         int    `json:"sources"`
	Presets         int    `json:"presets"`
}

type SnapshotLink struct {
	Source int `json:"source"`
	Target int `json:"target"`
}

var snapshotKinds = []string{"rh-image", "rh-video", "rh-audio", "rh-text", "rh-script", "rh-storyboard", "rh-group", "group", "rh-role", "rh-scene", "rh-entity", "rh-ai", "rh-video-analysis", "rh-remake-request", "rh-video-remake", "rh-director", "rh-comment", "rh-world", "rh-w3d", "rh-fastcut", "unknown"}
var snapshotStatuses = []string{"", "idle", "pending", "queued", "uploading", "generating", "running", "finished", "success", "succeeded", "failed", "error", "canceled", "cancelled"}
var snapshotTools = []string{"", "IMAGE_PORTRAIT", "IMAGE_EXPRESSION", "IMAGE_POSE", "IMAGE_IMAGE", "IMAGE_LIGHT", "IMAGE_MULTIANGLE", "IMAGE_CUTOUT_TEXT", "IMAGE_REDRAW", "IMAGE_ERASE", "IMAGE_ENHANCE", "GRID_CROP", "VIDEO_AUDIO", "IMAGE_CUTOUT", "IMAGE_EXPAND"}

func validSnapshotCounts(values ...int) bool {
	for _, n := range values {
		if n < 0 || n > 100000 {
			return false
		}
	}
	return true
}

func snapshotOptionalInt(value *int, minimum, maximum int) bool {
	return value == nil || *value >= minimum && *value <= maximum
}

func (s *ClientSnapshot) Valid() bool {
	if s == nil || s.SchemaVersion != "1" {
		return false
	}
	if !slices.Contains([]string{"", "MOUNTED", "COMMAND"}, s.Source) ||
		!slices.Contains([]string{"READINESS", "PREPARE", "SYNC", "SUBMIT"}, s.Phase) ||
		!slices.Contains([]string{"COMMAND", "GENERATE", "RETRY", "GROUP", "SHORTCUT", "MEDIA"}, s.Control) ||
		!slices.Contains([]string{"NODE", "GROUP", "CANVAS"}, s.TargetType) {
		return false
	}
	if s.Click != nil && !slices.Contains([]string{"GENERATE", "RETRY", "SHORTCUT", "GROUP"}, s.Control) {
		return false
	}
	if !validSnapshotCounts(s.NodeCount, s.EdgeCount, s.Incoming, s.Outgoing, s.Children) ||
		s.Nodes == nil || len(s.Nodes) > 8 || s.Links == nil || len(s.Links) > 12 {
		return false
	}
	if !snapshotOptionalInt(s.CommandNodes, 0, 100000) || !snapshotOptionalInt(s.CommandEdges, 0, 100000) ||
		s.Revision != nil && (*s.Revision < 0 || *s.Revision > 9007199254740991) {
		return false
	}
	if p := s.Projection; p != nil {
		shapes := []string{"ABSENT", "ALL_NULL", "LIMITED", "OTHER"}
		if !slices.Contains(shapes, p.MountedMaxConnect) || !slices.Contains(shapes, p.CommandMaxConnect) ||
			!validSnapshotCounts(p.MountedInputs, p.CommandInputs, p.AddedSources, p.RemovedSources) {
			return false
		}
	}
	indexes := map[int]bool{}
	for _, n := range s.Nodes {
		if n.Index < 0 || n.Index >= s.NodeCount || indexes[n.Index] || !snapshotOptionalInt(n.Parent, 0, s.NodeCount-1) {
			return false
		}
		if !snapshotOptionalInt(n.X, -1000000, 1000000) || !snapshotOptionalInt(n.Y, -1000000, 1000000) ||
			!validSnapshotCounts(n.HistoryCount, n.Outputs, n.Sources, n.Presets) {
			return false
		}
		if !slices.Contains(snapshotKinds, n.Kind) || !slices.Contains(snapshotStatuses, n.Status) || !slices.Contains(snapshotTools, n.Tool) {
			return false
		}
		indexes[n.Index] = true
	}
	if s.Target != nil && !indexes[*s.Target] {
		return false
	}
	for _, e := range s.Links {
		if !indexes[e.Source] || !indexes[e.Target] {
			return false
		}
	}
	return true
}
