package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/httpapi"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	execdomain "studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/modules/media/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"time"
)

type StudioEditPort interface {
	EditFile(context.Context, string, string, string, string, int64, domain.EditCommand) (domain.EditResult, error)
}

type RenderResult struct {
	Content       []byte
	MimeType      string
	DurationMs    int64
	Width, Height int
}
type StudioRenderer interface {
	Render(context.Context, domain.StudioBundle) (RenderResult, error)
}
type RenderFile struct {
	Name, MimeType string
	Content        []byte
	DurationMs     int64
	Width, Height  int
}
type StudioPort interface {
	Snapshot(context.Context, string, string, int64) (domain.StudioBundle, error)
	Visible(context.Context, string, string) error
	SaveFile(context.Context, string, string, RenderFile) error
	File(context.Context, string, string) (RenderFile, error)
	Renders(context.Context, string, string) ([]execdomain.Task, error)
	Hide(context.Context, string, string, int64) error
}
type StudioService struct {
	store      execution.Store
	repository StudioPort
	renderer   StudioRenderer
	importer   execution.AssetImporter
}

func NewStudio(store execution.Store, repo StudioPort, renderer StudioRenderer, importer execution.AssetImporter) (*StudioService, error) {
	if store == nil || repo == nil || renderer == nil || importer == nil {
		return nil, errors.New("studio dependencies required")
	}
	return &StudioService{store, repo, renderer, importer}, nil
}
func (s *StudioService) Submit(ctx context.Context, owner, id, key string, revision int64, cmd domain.RenderCommand) (execdomain.Task, error) {
	parsed, err := uuid.Parse(key)
	if err != nil || revision < 1 || cmd.Validate() != nil {
		return execdomain.Task{}, domain.ErrInvalid
	}
	bundle, err := s.repository.Snapshot(ctx, owner, id, revision)
	if err != nil {
		return execdomain.Task{}, err
	}
	bundle.Command = cmd
	if bundle.Validate() != nil {
		return execdomain.Task{}, domain.ErrInvalid
	}
	vaultPort, ok := s.importer.(interface {
		EnsureVault(context.Context, string, string) (string, error)
	})
	if !ok {
		return execdomain.Task{}, errors.New("studio asset vault unavailable")
	}
	if bundle.ProjectID == nil {
		vault, e := vaultPort.EnsureVault(ctx, owner, "STUDIO_ASSETS")
		if e != nil {
			return execdomain.Task{}, e
		}
		bundle.ProjectID = &vault
	}
	input, _ := json.Marshal(bundle)
	snapshot, _ := json.Marshal(map[string]any{"studioProjectId": id, "studioRevision": revision, "command": cmd})
	hash := sha256.Sum256(input)
	now := time.Now().UTC()
	task := execdomain.Task{ID: "tsk_" + uuid.NewString(), OwnerID: owner, ProjectID: bundle.ProjectID, Kind: "STUDIO", TargetType: "STUDIO", TargetID: id, Name: "Studio render", State: "QUEUED", Revision: 1, Snapshot: snapshot, CreatedAt: now, UpdatedAt: now, Plans: []execdomain.Plan{{NodeID: id, ExecutionID: "exe_" + uuid.NewString(), State: "QUEUED", CapabilityRef: "local-chromium-ffmpeg", CapabilityVersion: "1", Parameters: snapshot, Input: input, Outputs: []execdomain.Output{}}}}
	return s.store.Create(ctx, task, parsed.String(), hex.EncodeToString(hash[:]), nil)
}
func (s *StudioService) Get(ctx context.Context, owner, id string) (execdomain.Task, error) {
	t, err := s.store.Get(ctx, owner, id)
	if err != nil {
		return t, err
	}
	if t.Kind != "STUDIO" {
		return execdomain.Task{}, execdomain.ErrNotFound
	}
	if err = s.repository.Visible(ctx, owner, t.TargetID); err != nil {
		return execdomain.Task{}, err
	}
	return t, nil
}
func (s *StudioService) Renders(ctx context.Context, owner, id string) ([]execdomain.Task, error) {
	return s.repository.Renders(ctx, owner, id)
}
func (s *StudioService) Delete(ctx context.Context, owner, id string, revision int64) error {
	t, e := s.Get(ctx, owner, id)
	if e != nil {
		return e
	}
	if t.Revision != revision {
		return httpapi.Fail(412, "REVISION_CONFLICT", "渲染任务已改变，请刷新后重试。")
	}
	if !execdomain.Terminal(t.State) {
		canceled, e := s.store.Cancel(ctx, owner, id)
		if e != nil {
			return e
		}
		if canceled.State != "CANCELED" || canceled.Revision != revision+1 {
			return httpapi.Fail(412, "REVISION_CONFLICT", "渲染任务已改变，请刷新后重试。")
		}
		revision = canceled.Revision
	}
	return s.repository.Hide(ctx, owner, id, revision)
}
func (s *StudioService) File(ctx context.Context, owner, project, filename string) (RenderFile, error) {
	if !domain.ValidPath(filename) || filename != fmt.Sprintf("%s.%s", stringsTrimExtension(filename), extension(filename)) {
		return RenderFile{}, domain.ErrInvalid
	}
	id := stringsTrimExtension(filename)
	t, err := s.Get(ctx, owner, id)
	if err != nil {
		return RenderFile{}, err
	}
	if t.TargetID != project || t.State != "SUCCEEDED" {
		return RenderFile{}, execdomain.ErrNotFound
	}
	file, err := s.repository.File(ctx, owner, id)
	if err == nil && file.Name != filename {
		return RenderFile{}, execdomain.ErrNotFound
	}
	return file, err
}
func stringsTrimExtension(v string) string {
	for i := len(v) - 1; i >= 0; i-- {
		if v[i] == '.' {
			return v[:i]
		}
	}
	return v
}
func extension(v string) string {
	for i := len(v) - 1; i >= 0; i-- {
		if v[i] == '.' {
			return v[i+1:]
		}
	}
	return ""
}
func (s *StudioService) Process(ctx context.Context, t execdomain.Task, lease string) (bool, error) {
	if t.Kind != "STUDIO" || len(t.Plans) != 1 {
		return false, domain.ErrInvalid
	}
	b, err := domain.DecodeBundle(t.Plans[0].Input)
	if err != nil {
		return s.fail(ctx, t, lease, "STUDIO_SNAPSHOT_INVALID")
	}
	if err = s.repository.Visible(ctx, t.OwnerID, b.ID); err != nil {
		return s.fail(ctx, t, lease, "STUDIO_PROJECT_UNAVAILABLE")
	}
	t.State = "RUNNING"
	t.Plans[0].State = "RUNNING"
	if ok, e := s.store.Save(ctx, t, lease); e != nil || !ok {
		return ok, e
	}
	processing, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	done := make(chan struct{})
	defer close(done)
	heartbeatTask := t
	heartbeatTask.Plans = append([]execdomain.Plan(nil), t.Plans...)
	go func() {
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		heartbeat := time.Now()
		for {
			select {
			case <-done:
				return
			case <-processing.Done():
				return
			case <-ticker.C:
				current, e := s.store.Get(processing, t.OwnerID, t.ID)
				if e != nil || current.State == "CANCELED" {
					cancel()
					return
				}
				if time.Since(heartbeat) > 20*time.Second {
					ok, e := s.store.Save(processing, heartbeatTask, lease)
					if e != nil || !ok {
						cancel()
						return
					}
					heartbeat = time.Now()
				}
			}
		}
	}()
	var result RenderResult
	checkpointFound := false
	if checkpoint, ok := s.repository.(interface {
		Checkpoint(context.Context, string, string) (RenderFile, error)
	}); ok {
		if file, e := checkpoint.Checkpoint(ctx, t.OwnerID, t.ID); e == nil {
			result = RenderResult{Content: file.Content, MimeType: file.MimeType, DurationMs: file.DurationMs, Width: file.Width, Height: file.Height}
			checkpointFound = true
		} else if !errors.Is(e, execdomain.ErrNotFound) {
			return false, e
		}
	}
	if !checkpointFound {
		result, err = s.renderer.Render(processing, b)
	}
	if err != nil {
		current, e := s.store.Get(ctx, t.OwnerID, t.ID)
		if e == nil && current.State == "CANCELED" {
			return false, nil
		}
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		return s.fail(ctx, t, lease, "STUDIO_RENDER_FAILED")
	}
	current, err := s.store.Get(ctx, t.OwnerID, t.ID)
	if err != nil {
		return false, err
	}
	if current.State == "CANCELED" {
		return false, nil
	}
	filename := t.ID + "." + b.Command.Format
	if err = s.repository.SaveFile(ctx, t.OwnerID, t.ID, RenderFile{Name: filename, MimeType: result.MimeType, Content: result.Content, DurationMs: result.DurationMs, Width: result.Width, Height: result.Height}); err != nil {
		return s.fail(ctx, t, lease, "STUDIO_OUTPUT_SAVE_FAILED")
	}
	output := execdomain.Output{ID: "out_" + t.Plans[0].ExecutionID, Type: "STRUCTURED", SchemaVersion: "studio-render/1", Data: json.RawMessage(fmt.Sprintf(`{"filename":%q,"durationMs":%d}`, filename, result.DurationMs)), MimeType: result.MimeType, Width: &result.Width, Height: &result.Height, DurationMs: &result.DurationMs}
	if t.ProjectID != nil {
		hash := sha256.Sum256(result.Content)
		kind := "VIDEO"
		asset, e := s.importer.Import(ctx, t.OwnerID, *t.ProjectID, t.Plans[0].ExecutionID+"/output", gateway.Artifact{Ref: t.Plans[0].ExecutionID, Kind: &kind, MediaType: result.MimeType, SizeBytes: int64(len(result.Content)), SHA256: hex.EncodeToString(hash[:])}, result.Content)
		if e != nil {
			return s.fail(ctx, t, lease, "STUDIO_IMPORT_FAILED")
		}
		output.Type = "ARTIFACT"
		output.AssetID = &asset.ID
	}
	t.State = "SUCCEEDED"
	t.Plans[0].State = "SUCCEEDED"
	t.Plans[0].Outputs = []execdomain.Output{output}
	return s.store.Save(ctx, t, lease)
}
func (s *StudioService) fail(ctx context.Context, t execdomain.Task, lease, code string) (bool, error) {
	t.State = "FAILED"
	t.ErrorCode = &code
	for i := range t.Plans {
		t.Plans[i].State = "FAILED"
		t.Plans[i].ErrorCode = &code
	}
	return s.store.Save(ctx, t, lease)
}
