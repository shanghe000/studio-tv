// Package application owns the longform orchestration boundary. Native runtime
// paths, credentials and provider IDs never become browser authority.
package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"studiotv.local/service/api/internal/principal"
	"time"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/httpapi"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

type Caller struct {
	Identity httpapi.Identity
	ClientID string
}
type Reference struct {
	Kind       string `json:"kind"`
	AssetID    string `json:"assetId"`
	Role       string `json:"role,omitempty"`
	VideoIndex *int   `json:"videoIndex,omitempty"`
}
type Create struct {
	RequestID    string          `json:"requestId"`
	CanvasID     string          `json:"canvasId"`
	NodeID       string          `json:"nodeId"`
	Title        string          `json:"title"`
	Settings     json.RawMessage `json:"settings"`
	CommonPrompt string          `json:"commonPrompt"`
	Segments     json.RawMessage `json:"segments"`
	References   []Reference     `json:"references"`
}
type Binding struct {
	NodeVersion, NodeIncarnation                            int64
	ID, ActorID, StorageOwnerID, CanvasID, NodeID, RemoteID string
	Snapshot, CreateBody                                    json.RawMessage
}
type Request struct {
	ID, Hash, ProjectID string
	Body, Response      json.RawMessage
}
type Archived struct {
	ArtifactID  string
	Asset       execution.Asset
	Composition bool
}
type Repository interface {
	PrepareCreate(context.Context, Caller, Create, string) (Binding, Request, error)
	Get(context.Context, string, string, bool) (Binding, error)
	List(context.Context, string, string, string) ([]Binding, error)
	PrepareAction(context.Context, Caller, string, json.RawMessage, string) (Binding, Request, error)
	Save(context.Context, Binding, json.RawMessage, []Archived, *Request) (Binding, error)
	Pending(context.Context) ([]Binding, error)
	PendingRequests(context.Context, Binding) ([]Request, error)
	Reject(context.Context, Binding, Request, string, int) error
}
type Importer interface {
	ImportLongform(context.Context, string, string, string, gateway.Artifact, []byte) (execution.Asset, error)
}
type Service struct {
	repo    Repository
	gateway gateway.LongformGateway
	assets  Importer
	enabled bool
}

func New(repo Repository, g gateway.LongformGateway, assets Importer, enabled bool) *Service {
	return &Service{repo, g, assets, enabled}
}
func (s *Service) ready() error {
	if !s.enabled || s.gateway == nil {
		return httpapi.Fail(501, "LONGFORM_NOT_CONFIGURED", "分段长片服务尚未启用。")
	}
	return nil
}
func (s *Service) Capabilities(ctx context.Context, actor string) (json.RawMessage, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	raw, e := s.gateway.LongformCapabilities(ctx, gateway.Actor{SubjectRef: actor})
	if e != nil {
		return nil, e
	}
	var caps map[string]json.RawMessage
	if json.Unmarshal(raw, &caps) != nil || caps == nil {
		return nil, &gateway.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	caps["productLimits"], _ = json.Marshal(map[string]int64{"maxRequestBytes": 4 << 20, "maxProjectResponseBytes": 16 << 20, "maxImportBytes": 1 << 30})
	return json.Marshal(caps)
}
func digest(v any) string {
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func validRequestID(id string) bool { u, e := uuid.Parse(id); return e == nil && u.String() == id }
func ValidateCreate(c Create) error {
	if len(c.Segments) > 4<<20 || !validRequestID(c.RequestID) || c.CanvasID == "" || c.NodeID == "" || len(c.Title) > 200 || len(c.CommonPrompt) > 60000 || len(c.Settings) > 60000 || !json.Valid(c.Settings) {
		return httpapi.Fail(400, "LONGFORM_INVALID", "长片参数不完整。")
	}
	var segs []map[string]any
	if json.Unmarshal(c.Segments, &segs) != nil || len(segs) < 1 || len(segs) > 100 {
		return httpapi.Fail(400, "LONGFORM_INVALID", "需要1至100个片段。")
	}
	seen := map[string]bool{}
	for _, v := range segs {
		id, _ := v["id"].(string)
		p, _ := v["prompt"].(string)
		if id == "" || len(id) > 100 || seen[id] || p == "" || len(p) > 60000 {
			return httpapi.Fail(400, "LONGFORM_INVALID", "片段标识和剧情需要完整且不能重复。")
		}
		seen[id] = true
	}
	return ValidateReferences(c.References)
}
func (s *Service) Create(ctx context.Context, c Caller, in Create) (json.RawMessage, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	if err := ValidateCreate(in); err != nil {
		return nil, err
	}
	b, r, e := s.repo.PrepareCreate(ctx, c, in, digest(in))
	if e != nil {
		return nil, e
	}
	if len(r.Response) > 0 {
		return s.present(b, r.Response)
	}
	raw, e := s.gateway.LongformCreate(ctx, gateway.Actor{SubjectRef: b.ActorID}, r.Body)
	if e != nil {
		s.rejected(ctx, b, r, e)
		return nil, e
	}
	b, e = s.reconcile(ctx, b, raw, &r)
	if e != nil {
		return nil, e
	}
	return s.present(b, b.Snapshot)
}
func (s *Service) Get(ctx context.Context, actor, id string) (json.RawMessage, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	b, e := s.repo.Get(ctx, actor, id, false)
	if e != nil {
		return nil, e
	}
	b, e = s.refresh(ctx, b)
	if e != nil {
		return nil, e
	}
	return s.present(b, b.Snapshot)
}
func (s *Service) List(ctx context.Context, actor, canvas, node string) (map[string]any, error) {
	bs, e := s.repo.List(ctx, actor, canvas, node)
	if e != nil {
		return nil, e
	}
	items := []json.RawMessage{}
	for _, b := range bs {
		if len(b.Snapshot) > 0 && string(b.Snapshot) != "null" {
			p, err := s.present(b, b.Snapshot)
			if err != nil {
				return nil, err
			}
			items = append(items, p)
		} else {
			p, _ := json.Marshal(map[string]any{"id": b.ID, "canvasId": b.CanvasID, "nodeId": b.NodeID, "status": "PENDING", "revision": 0})
			items = append(items, p)
		}
	}
	return map[string]any{"items": items}, nil
}
func ValidateAction(raw json.RawMessage) error {
	if len(raw) > 4<<20 {
		return httpapi.Fail(413, "LONGFORM_TOO_LARGE", "长片参数超过4MiB，请拆分项目。")
	}
	var a map[string]json.RawMessage
	if json.Unmarshal(raw, &a) != nil {
		return httpapi.Fail(400, "LONGFORM_INVALID", "长片操作无效。")
	}
	var id, typ string
	var rev int64
	if json.Unmarshal(a["requestId"], &id) != nil || !validRequestID(id) || json.Unmarshal(a["expectedRevision"], &rev) != nil || rev < 0 || json.Unmarshal(a["type"], &typ) != nil {
		return httpapi.Fail(400, "LONGFORM_INVALID", "操作标识和当前状态无效。")
	}
	allowed := map[string]bool{"requestId": true, "expectedRevision": true, "type": true, "canvasId": true}
	extras := map[string][]string{"updateDraft": {"patch"}, "generateAll": {}, "retrySegment": {"segmentId", "prompt", "seed", "settings", "references", "commonPrompt"}, "regenerateFrom": {"segmentId"}, "keepFollowing": {"segmentId"}, "append": {"segments"}, "adoptCandidate": {"segmentId", "candidateId"}, "composeSelected": {}, "stopAfterSegment": {}}
	fields, ok := extras[typ]
	if !ok {
		return httpapi.Fail(400, "LONGFORM_INVALID", "此长片操作不支持。")
	}
	for _, f := range fields {
		allowed[f] = true
	}
	for k := range a {
		if !allowed[k] {
			return httpapi.Fail(400, "LONGFORM_INVALID", "长片操作含不支持的参数。")
		}
	}
	return nil
}
func (s *Service) Action(ctx context.Context, c Caller, id string, raw json.RawMessage) (json.RawMessage, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	if err := ValidateAction(raw); err != nil {
		return nil, err
	}
	var v any
	_ = decode(raw, &v)
	b, r, e := s.repo.PrepareAction(ctx, c, id, raw, digest(v))
	if e != nil {
		return nil, e
	}
	if len(r.Response) > 0 {
		return s.present(b, r.Response)
	}
	response, e := s.gateway.LongformAction(ctx, gateway.Actor{SubjectRef: b.ActorID}, b.RemoteID, r.Body)
	if e != nil {
		s.rejected(ctx, b, r, e)
		return nil, e
	}
	b, e = s.reconcile(ctx, b, response, &r)
	if e != nil {
		return nil, e
	}
	return s.present(b, b.Snapshot)
}
func (s *Service) refresh(ctx context.Context, b Binding) (Binding, error) {
	current, e := s.repo.Get(ctx, b.ActorID, b.ID, true)
	if e != nil {
		return b, e
	}
	b = current

	if b.RemoteID == "" {
		rs, e := s.repo.PendingRequests(ctx, b)
		if e != nil {
			return b, e
		}
		for _, r := range rs {
			raw, e := s.gateway.LongformCreate(ctx, gateway.Actor{SubjectRef: b.ActorID}, r.Body)
			if e != nil {
				s.rejected(ctx, b, r, e)
				return b, e
			}
			b, e = s.reconcile(ctx, b, raw, &r)
			if e != nil {
				return b, e
			}
		}
		return b, nil
	}
	rs, e := s.repo.PendingRequests(ctx, b)
	if e != nil {
		return b, e
	}
	for _, r := range rs {
		raw, e := s.gateway.LongformAction(ctx, gateway.Actor{SubjectRef: b.ActorID}, b.RemoteID, r.Body)
		if e != nil {
			s.rejected(ctx, b, r, e)
			return b, e
		}
		b, e = s.reconcile(ctx, b, raw, &r)
		if e != nil {
			return b, e
		}
	}
	raw, e := s.gateway.LongformProject(ctx, gateway.Actor{SubjectRef: b.ActorID}, b.RemoteID)
	if e != nil {
		return b, e
	}
	return s.reconcile(ctx, b, raw, nil)
}
func (s *Service) reconcile(ctx context.Context, b Binding, raw json.RawMessage, req *Request) (Binding, error) {
	var project map[string]any
	if decode(raw, &project) != nil {
		return b, &gateway.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	remote, _ := project["id"].(string)
	if _, err := uuid.Parse(remote); err != nil || b.RemoteID != "" && b.RemoteID != remote {
		return b, &gateway.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	b.RemoteID = remote
	archived := []Archived{}
	// Output bodies are fetched from signed service routes, never from arbitrary
	// URLs in the project. Existing immutable STUDIO imports make retries safe.
	collect := func(row map[string]any, composition bool) error {
		id, _ := row["artifactId"].(string)
		if id == "" {
			return nil
		}
		if _, e := uuid.Parse(id); e != nil {
			return &gateway.Fault{Code: "PROTOCOL_MISMATCH"}
		}
		if asset, ok := row["assetId"].(string); ok && asset != "" {
			return nil
		}
		art, body, e := s.gateway.LongformArtifact(ctx, gateway.Actor{SubjectRef: b.ActorID}, remote, id)
		if e != nil {
			return e
		}
		asset, e := s.assets.ImportLongform(principal.WithActor(ctx, b.ActorID), b.StorageOwnerID, b.CanvasID, "longform/"+b.ID+"/"+id, art, body)
		if e != nil {
			return e
		}
		row["assetId"], row["url"] = asset.ID, "rhtv-asset:"+asset.ID
		row["downloadUrl"] = "/api/v2/longform/projects/" + b.ID + "/artifacts/" + id + "/content"
		archived = append(archived, Archived{id, asset, composition})
		return nil
	}
	// Reuse only locally trusted archive annotations, not Router asset fields.
	old := map[string]map[string]any{}
	var previous map[string]any
	_ = decode(b.Snapshot, &previous)
	walkRows(previous, func(row map[string]any, _ bool) error {
		if id, _ := row["artifactId"].(string); id != "" {
			old[id] = row
		}
		return nil
	})
	e := walkRows(project, func(row map[string]any, comp bool) error {
		delete(row, "assetId")
		delete(row, "url")
		delete(row, "downloadUrl")
		id, _ := row["artifactId"].(string)
		if prev := old[id]; prev != nil {
			for _, k := range []string{"assetId", "url", "downloadUrl"} {
				if v := prev[k]; v != nil {
					row[k] = v
				}
			}
			if row["assetId"] != nil {
				return nil
			}
		}
		return collect(row, comp)
	})
	if e != nil {
		return b, e
	}
	enriched, _ := json.Marshal(project)
	return s.repo.Save(ctx, b, enriched, archived, req)
}
func walkRows(p map[string]any, f func(map[string]any, bool) error) error {
	for _, v := range array(p["segments"]) {
		seg, _ := v.(map[string]any)
		for _, c := range array(seg["candidates"]) {
			row, ok := c.(map[string]any)
			if ok {
				if e := f(row, false); e != nil {
					return e
				}
			}
		}
	}
	for _, c := range array(p["compositions"]) {
		row, ok := c.(map[string]any)
		if ok {
			if e := f(row, true); e != nil {
				return e
			}
		}
	}
	return nil
}
func array(v any) []any { a, _ := v.([]any); return a }
func (s *Service) present(b Binding, raw json.RawMessage) (json.RawMessage, error) {
	var p map[string]any
	if decode(raw, &p) != nil || p == nil {
		return nil, httpapi.Fail(503, "LONGFORM_PENDING", "长片状态正在恢复。")
	}
	p["id"], p["canvasId"], p["nodeId"] = b.ID, b.CanvasID, b.NodeID
	var input struct {
		References []struct {
			Kind       string             `json:"kind"`
			Attachment gateway.Attachment `json:"attachment"`
			Role       string             `json:"role"`
			VideoIndex *int               `json:"videoIndex"`
		}
	}
	if json.Unmarshal(b.CreateBody, &input) == nil {
		refs := []Reference{}
		for _, r := range input.References {
			refs = append(refs, Reference{Kind: r.Kind, AssetID: r.Attachment.SourceRef, Role: r.Role, VideoIndex: r.VideoIndex})
		}
		p["references"] = refs
	}

	delete(p, "owner")
	delete(p, "ownerId")
	return json.Marshal(p)
}
func (s *Service) Artifact(ctx context.Context, actor, id, artifact string) (gateway.Artifact, []byte, error) {
	b, e := s.repo.Get(ctx, actor, id, false)
	if e != nil {
		return gateway.Artifact{}, nil, e
	}
	if s.gateway == nil {
		return gateway.Artifact{}, nil, httpapi.Fail(501, "LONGFORM_NOT_CONFIGURED", "分段长片服务尚未启用。")
	}
	found := false
	var p map[string]any
	_ = decode(b.Snapshot, &p)
	walkRows(p, func(r map[string]any, _ bool) error { found = found || r["artifactId"] == artifact; return nil })
	if !found {
		return gateway.Artifact{}, nil, httpapi.Fail(404, "LONGFORM_NOT_FOUND", "长片产物不存在。")
	}
	return s.gateway.LongformArtifact(ctx, gateway.Actor{SubjectRef: b.ActorID}, b.RemoteID, artifact)
}
func (s *Service) Run(ctx context.Context) {
	if s.ready() != nil {
		return
	}
	for ctx.Err() == nil {
		bs, e := s.repo.Pending(ctx)
		if e == nil {
			for _, b := range bs {
				if ctx.Err() != nil {
					return
				}
				_, _ = s.refresh(ctx, b)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(4 * time.Second):
		}
	}
}

func decode(raw json.RawMessage, out any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	return d.Decode(out)
}

func ValidateReferences(refs []Reference) error {
	if len(refs) > 18 {
		return httpapi.Fail(400, "LONGFORM_INVALID", "参考素材最多18份（9图、3视频、3独立音频、3视频音轨）。")
	}
	counts := map[string]int{}
	paired := map[int]bool{}
	videoCount := 0
	for _, r := range refs {
		if r.Kind == "VIDEO" {
			videoCount++
		}
	}
	for _, r := range refs {
		if r.AssetID == "" || len(r.Role) > 80 {
			return httpapi.Fail(400, "LONGFORM_INVALID", "参考素材无效。")
		}
		key := r.Kind
		if r.Role == "VIDEO_AUDIO" || r.Role == "videoAudio" {
			if r.Kind != "AUDIO" || r.VideoIndex == nil || *r.VideoIndex < 0 || *r.VideoIndex >= videoCount || paired[*r.VideoIndex] {
				return httpapi.Fail(400, "LONGFORM_INVALID", "视频音轨需要对应唯一的视频序号。")
			}
			paired[*r.VideoIndex] = true
			key = "VIDEO_AUDIO"
		} else if r.VideoIndex != nil {
			return httpapi.Fail(400, "LONGFORM_INVALID", "仅视频配对音轨使用视频序号。")
		}
		counts[key]++
		max := 3
		if key == "IMAGE" {
			max = 9
		} else if key != "VIDEO" && key != "AUDIO" && key != "VIDEO_AUDIO" {
			return httpapi.Fail(400, "LONGFORM_INVALID", "参考素材类型无效。")
		}
		if counts[key] > max {
			return httpapi.Fail(400, "LONGFORM_INVALID", "此类型参考素材超过数量限制。")
		}
	}
	return nil
}
func (s *Service) rejected(ctx context.Context, b Binding, r Request, e error) {
	var fault *gateway.Fault
	if errors.As(e, &fault) && fault.HTTPStatus >= 400 && fault.HTTPStatus < 500 {
		_ = s.repo.Reject(ctx, b, r, fault.Code, fault.HTTPStatus)
	}
}

// ArchivedURL delegates media authorization and session-bound signing to the
// existing STUDIO asset store. Download remains usable if the GPU is offline.
func (s *Service) ArchivedURL(ctx context.Context, actor, session, id, artifact string) (string, error) {
	reader, ok := s.assets.(interface {
		URL(context.Context, string, string, string) (string, error)
	})
	if !ok {
		return "", nil
	}
	b, e := s.repo.Get(ctx, actor, id, false)
	if e != nil {
		return "", e
	}
	var p map[string]any
	_ = decode(b.Snapshot, &p)
	asset := ""
	_ = walkRows(p, func(row map[string]any, _ bool) error {
		if row["artifactId"] == artifact {
			asset, _ = row["assetId"].(string)
		}
		return nil
	})
	if asset == "" {
		return "", nil
	}
	return reader.URL(ctx, actor, session, asset)
}
