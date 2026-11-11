package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	execdomain "studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/modules/media/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"studiotv.local/service/api/internal/principal"
)

type Command struct {
	ExpectedRevision *int64          `json:"expectedRevision,omitempty"`
	Graph            json.RawMessage `json:"graph,omitempty"`
	ProjectID        string          `json:"projectId"`
	NodeID           string          `json:"nodeId,omitempty"`
	OperateType      string          `json:"operateType,omitempty"`
	Operation        string          `json:"operation,omitempty"`
	BizID            string          `json:"bizId,omitempty"`
	CanvasID         string          `json:"canvasId,omitempty"`
	BizType          string          `json:"bizType,omitempty"`
	Executor         string          `json:"executor,omitempty"`
	Spec             json.RawMessage `json:"spec"`
}
type Service struct {
	store         execution.Store
	reader        InputPort
	importer      execution.AssetImporter
	engine        Engine
	studio        *StudioService
	projectAccess func(context.Context, string, string) (string, error)
}

func New(store execution.Store, reader InputPort, importer execution.AssetImporter, engine Engine) (*Service, error) {
	if store == nil || reader == nil || importer == nil || engine == nil {
		return nil, errors.New("media dependencies required")
	}
	return &Service{store: store, reader: reader, importer: importer, engine: engine}, nil
}
func (s *Service) WithProjectAccess(f func(context.Context, string, string) (string, error)) {
	s.projectAccess = f
}
func mediaActor(t execdomain.Task) string {
	if t.InitiatedBy != "" {
		return t.InitiatedBy
	}
	return t.OwnerID
}
func (s *Service) Submit(ctx context.Context, owner, key string, cmd Command) (execdomain.Task, error) {
	parsedKey, err := uuid.Parse(key)
	if err != nil || owner == "" || cmd.ProjectID == "" || len(cmd.ProjectID) > 64 || len(cmd.NodeID) > 200 || cmd.Executor != "" && cmd.Executor != "FFMPEG" || cmd.BizType != "" && cmd.BizType != "CANVAS" {
		return execdomain.Task{}, domain.ErrInvalid
	}
	if cmd.Operation == "" {
		cmd.Operation = cmd.OperateType
	}
	if cmd.Operation == "" {
		var hint struct {
			Tracks []struct {
				Type string `json:"type"`
			} `json:"tracks"`
		}
		if json.Unmarshal(cmd.Spec, &hint) == nil && len(hint.Tracks) > 0 {
			switch hint.Tracks[0].Type {
			case "compress":
				cmd.Operation = "COMPRESS"
			case "split":
				cmd.Operation = "TRIM"
			case "video":
				cmd.Operation = "CONCAT"
			}
		}
	}
	op, err := domain.Operation(cmd.Operation)
	if err != nil {
		return execdomain.Task{}, err
	}
	spec, err := domain.Parse(cmd.Spec)
	if err != nil {
		return execdomain.Task{}, err
	}
	if op == "COMPRESS" && spec.Output.CRF == nil {
		value := 31
		spec.Output.CRF = &value
	}
	if op == "EXTRACT_AUDIO" || op == "AUDIO_EXTRACT" {
		spec.Output = &domain.Output{Container: "wav"}
	}
	ids := []string{}
	for _, in := range spec.Inputs {
		ids = append(ids, in.AssetID)
	}
	actor := principal.Actor(ctx, owner)
	ctx = principal.WithActor(ctx, actor)
	storage := owner
	if s.projectAccess != nil {
		storage, err = s.projectAccess(ctx, actor, cmd.ProjectID)
		if err != nil {
			return execdomain.Task{}, err
		}
	}
	assets, err := s.reader.Read(ctx, actor, ids)
	if err != nil {
		return execdomain.Task{}, err
	}
	testMode := false
	grants := []execution.Grant{}
	for _, a := range assets {
		testMode = testMode || a.TestMode
		if a.Kind != "VIDEO" && a.Kind != "AUDIO" && a.Kind != "IMAGE" {
			return execdomain.Task{}, domain.ErrInvalid
		}
		if a.DurationMs != nil && *a.DurationMs > 600000 {
			return execdomain.Task{}, domain.ErrInvalid
		}
		grants = append(grants, execution.Grant{ID: "mgr_" + uuid.NewString(), AssetID: a.ID, Version: a.Version, SHA256: a.SHA256})
	}
	cmd.Operation = op
	cmd.OperateType = ""
	cmd.BizID = ""
	cmd.CanvasID = ""
	cmd.BizType = ""
	cmd.Executor = ""
	cmd.Spec, _ = json.Marshal(spec)
	snapshot, _ := json.Marshal(cmd)
	hash := sha256.Sum256(snapshot)
	id := "tsk_" + uuid.NewString()
	node := cmd.NodeID
	if node == "" {
		node = "media"
	}
	now := time.Now().UTC()
	task := execdomain.Task{TestMode: testMode, ID: id, OwnerID: storage, InitiatedBy: actor, ProjectID: &cmd.ProjectID, Kind: "MEDIA", TargetType: "NODE", TargetID: node, Name: op, State: "QUEUED", Revision: 1, Plans: []execdomain.Plan{{TestMode: testMode, NodeID: node, ExecutionID: "exe_" + uuid.NewString(), State: "QUEUED", CapabilityRef: "local-ffmpeg", CapabilityVersion: "1", Parameters: cmd.Spec, Input: cmd.Spec, Outputs: []execdomain.Output{}}}, Snapshot: snapshot, CreatedAt: now, UpdatedAt: now}
	if cmd.ExpectedRevision != nil {
		if cmd.NodeID == "" || *cmd.ExpectedRevision < 1 {
			return execdomain.Task{}, domain.ErrInvalid
		}
		if _, _, err := execdomain.CanvasGuard(cmd.Graph, node); err != nil {
			return execdomain.Task{}, err
		}
		task.ExpectedRevision = cmd.ExpectedRevision
		task.Snapshot = cmd.Graph
	} else if len(cmd.Graph) > 0 {
		return execdomain.Task{}, domain.ErrInvalid
	}
	normalized := parsedKey.String()
	if actor != storage {
		normalized = uuid.NewSHA1(uuid.NameSpaceOID, []byte("studio-media-actor/"+actor+"/"+normalized)).String()
	}
	return s.store.Create(ctx, task, normalized, hex.EncodeToString(hash[:]), grants)
}
func (s *Service) Process(ctx context.Context, task execdomain.Task, lease string) (bool, error) {
	if task.Kind == "STUDIO" && s.studio != nil {
		return s.studio.Process(ctx, task, lease)
	}
	if task.Kind != "MEDIA" {
		return false, domain.ErrInvalid
	}
	if len(task.Plans) != 1 || task.ProjectID == nil {
		return false, domain.ErrInvalid
	}
	ctx = principal.WithActor(ctx, mediaActor(task))
	if s.projectAccess != nil {
		storage, e := s.projectAccess(ctx, mediaActor(task), *task.ProjectID)
		if e != nil || storage != task.OwnerID {
			return s.fail(ctx, task, lease, "PROJECT_ACCESS_REVOKED")
		}
	}
	spec, err := domain.Parse(task.Plans[0].Input)
	if err != nil {
		return s.fail(ctx, task, lease, "MEDIA_SPEC_INVALID")
	}
	ids := []string{}
	for _, in := range spec.Inputs {
		ids = append(ids, in.AssetID)
	}
	inputs, err := s.reader.Read(ctx, mediaActor(task), ids)
	if err != nil {
		return s.fail(ctx, task, lease, "INPUT_ASSET_UNAVAILABLE")
	}
	task.State = "RUNNING"
	task.Plans[0].State = "RUNNING"
	if saved, e := s.store.Save(ctx, task, lease); e != nil || !saved {
		return saved, e
	}
	processing, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	done := make(chan struct{})
	defer close(done)
	// Completion mutates task; the heartbeat reads only its independent snapshot.
	heartbeatTask := task
	heartbeatTask.Plans = append([]execdomain.Plan(nil), task.Plans...)
	go func() {
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		lastHeartbeat := time.Now()
		for {
			select {
			case <-done:
				return
			case <-processing.Done():
				return
			case <-ticker.C:
				if s.projectAccess != nil {
					storage, e := s.projectAccess(processing, mediaActor(heartbeatTask), *heartbeatTask.ProjectID)
					if e != nil || storage != heartbeatTask.OwnerID {
						cancel()
						return
					}
				}
				current, e := s.store.Get(processing, mediaActor(heartbeatTask), heartbeatTask.ID)
				if e != nil || current.State == "CANCELED" {
					cancel()
					return
				}
				if time.Since(lastHeartbeat) > 20*time.Second {
					saved, e := s.store.Save(processing, heartbeatTask, lease)
					if e != nil || !saved {
						cancel()
						return
					}
					lastHeartbeat = time.Now()
				}
			}
		}
	}()
	result, err := s.engine.Execute(processing, spec, inputs)
	if err != nil {
		current, e := s.store.Get(ctx, mediaActor(task), task.ID)
		if e == nil && current.State == "CANCELED" {
			return false, nil
		}
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		return s.fail(ctx, task, lease, "MEDIA_PROCESSING_FAILED")
	}
	current, err := s.store.Get(ctx, mediaActor(task), task.ID)
	if err != nil {
		return s.fail(ctx, task, lease, "PROJECT_ACCESS_REVOKED")
	}
	if current.State == "CANCELED" {
		return false, nil
	}
	hash := sha256.Sum256(result.Content)
	fixtureLabel := ""
	if task.TestMode {
		fixtureLabel = "MOCK source fixture; transformed by real local FFmpeg"
	}
	art := gateway.Artifact{TestMode: task.TestMode, FixtureLabel: fixtureLabel, Ref: task.Plans[0].ExecutionID, OutputRef: task.Plans[0].ExecutionID, Kind: &result.Kind, MediaType: result.MimeType, SizeBytes: int64(len(result.Content)), SHA256: hex.EncodeToString(hash[:])}
	asset, err := s.importer.Import(ctx, task.OwnerID, *task.ProjectID, task.Plans[0].ExecutionID+"/output", art, result.Content)
	if err != nil {
		return s.fail(ctx, task, lease, "MEDIA_IMPORT_FAILED")
	}
	task.State = "SUCCEEDED"
	task.Plans[0].State = "SUCCEEDED"
	task.Plans[0].Outputs = []execdomain.Output{{ID: "out_" + task.Plans[0].ExecutionID, Type: "ARTIFACT", TestMode: task.TestMode, AssetID: &asset.ID, MimeType: asset.MimeType, Width: asset.Width, Height: asset.Height, DurationMs: asset.DurationMs}}
	return s.store.Save(ctx, task, lease)
}

func (s *Service) OutputURL(ctx context.Context, owner, session, id string) (string, error) {
	port, ok := s.reader.(URLPort)
	if !ok {
		return "", errors.New("media asset URL port unavailable")
	}
	return port.URL(ctx, owner, session, id)
}
func (s *Service) fail(ctx context.Context, t execdomain.Task, lease, code string) (bool, error) {
	t.State = "FAILED"
	t.ErrorCode = &code
	for i := range t.Plans {
		t.Plans[i].State = "FAILED"
		t.Plans[i].ErrorCode = &code
	}
	return s.store.Save(ctx, t, lease)
}
func (s *Service) Get(ctx context.Context, owner, id string) (execdomain.Task, error) {
	task, err := s.store.Get(ctx, owner, id)
	if err != nil {
		return task, err
	}
	if task.Kind != "MEDIA" {
		return execdomain.Task{}, execdomain.ErrNotFound
	}
	return task, nil
}
func (s *Service) Cancel(ctx context.Context, owner, id string) (execdomain.Task, error) {
	if _, err := s.Get(ctx, owner, id); err != nil {
		return execdomain.Task{}, err
	}
	return s.store.Cancel(ctx, owner, id)
}

func (s *Service) WithStudio(studio *StudioService) *Service { s.studio = studio; return s }
