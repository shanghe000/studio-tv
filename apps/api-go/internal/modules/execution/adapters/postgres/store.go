package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/observability"
	"studiotv.local/service/api/internal/principal"
	"strconv"
	"strings"
	"time"
)

type Store struct {
	pool     *pgxpool.Pool
	observer *observability.Observer
}

func New(pool *pgxpool.Pool) (*Store, error) {
	if pool == nil {
		return nil, errors.New("execution pool is required")
	}
	return &Store{pool: pool}, nil
}

type privatePlan struct {
	RouterConversationRef  string
	Request, Input         json.RawMessage
	InvocationRef          *string
	InputBound             bool
	MediaInputFrontier     bool
	CatalogVideoRoles      bool
	VideoCancelUnsupported bool
	InputReferences        []domain.InputReference
	PromptRequirements     *domain.PromptRequirements
}
type payload struct {
	Task        domain.Task   `json:"task"`
	Private     []privatePlan `json:"private"`
	InitiatedBy string        `json:"initiatedBy,omitempty"`
}

func encode(t domain.Task) ([]byte, error) {
	p := payload{Task: t, InitiatedBy: t.InitiatedBy, Private: make([]privatePlan, len(t.Plans))}
	for i, v := range t.Plans {
		p.Private[i] = privatePlan{Request: v.Request, Input: v.Input, InvocationRef: v.InvocationRef, InputBound: v.InputBound, MediaInputFrontier: v.MediaInputFrontier, CatalogVideoRoles: v.CatalogVideoRoles, VideoCancelUnsupported: v.VideoCancelUnsupported, InputReferences: v.InputReferences, PromptRequirements: v.PromptRequirements, RouterConversationRef: v.RouterConversationRef}
	}
	return json.Marshal(p)
}
func scan(row pgx.Row) (domain.Task, error) {
	var t domain.Task
	var raw []byte
	err := row.Scan(&t.ID, &t.OwnerID, &t.State, &t.Revision, &raw, &t.CreatedAt, &t.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return t, domain.ErrNotFound
	}
	if err != nil {
		return t, err
	}
	var p payload
	if json.Unmarshal(raw, &p) != nil || len(p.Private) != len(p.Task.Plans) || p.Task.ID != t.ID {
		return t, errors.New("execution row invalid")
	}
	p.Task.OwnerID = t.OwnerID
	p.Task.InitiatedBy = p.InitiatedBy
	if p.Task.InitiatedBy == "" {
		p.Task.InitiatedBy = t.OwnerID
	}
	p.Task.State = t.State
	p.Task.Revision = t.Revision
	p.Task.CreatedAt = t.CreatedAt
	p.Task.UpdatedAt = t.UpdatedAt
	for i, v := range p.Private {
		p.Task.Plans[i].RouterConversationRef = v.RouterConversationRef
		p.Task.Plans[i].Request = v.Request
		p.Task.Plans[i].Input = v.Input
		p.Task.Plans[i].InvocationRef = v.InvocationRef
		p.Task.Plans[i].InputBound = v.InputBound
		p.Task.Plans[i].MediaInputFrontier = v.MediaInputFrontier
		p.Task.Plans[i].CatalogVideoRoles = v.CatalogVideoRoles
		p.Task.Plans[i].VideoCancelUnsupported = v.VideoCancelUnsupported
		p.Task.Plans[i].InputReferences = v.InputReferences
		p.Task.Plans[i].PromptRequirements = v.PromptRequirements
	}
	return p.Task, nil
}

const columns = "t.id,t.owner_id,t.state,t.revision,t.payload,t.created_at,t.updated_at"
const visible = `(t.owner_id=$1 OR (t.kind IN ('CANVAS','MEDIA') AND t.project_id IS NOT NULL AND collaboration.project_role(t.project_id,$1) IS NOT NULL))
 AND (t.project_id IS NULL OR collaboration.project_role(t.project_id,$1) IS NOT NULL OR (t.kind='STUDIO' AND t.owner_id=$1 AND EXISTS(SELECT 1 FROM public.projects sp WHERE sp.id=t.project_id AND sp.owner_id=$1 AND sp.deleted_at IS NULL)))
 AND (t.conversation_id IS NULL OR EXISTS(SELECT 1 FROM assistant.conversations c WHERE c.id=t.conversation_id AND c.owner_id=$1 AND c.owner_id=t.owner_id AND c.deleted_at IS NULL
 AND (c.hf_project_id IS NULL OR EXISTS(SELECT 1 FROM resources.studio_projects hc WHERE hc.id=c.hf_project_id AND hc.owner_id=c.owner_id AND hc.deleted_at IS NULL AND (hc.project_id IS NULL OR EXISTS(SELECT 1 FROM public.projects hp WHERE hp.id=hc.project_id AND hp.owner_id=hc.owner_id AND hp.deleted_at IS NULL AND hp.internal_kind IS NULL))))
 AND (c.canvas_project_id IS NULL OR collaboration.project_role(c.canvas_project_id,$1) IS NOT NULL)))
 AND (t.kind<>'ASSISTANT' OR EXISTS(SELECT 1 FROM assistant.messages tm WHERE tm.id=t.payload->'task'->>'messageId' AND tm.conversation_id=t.conversation_id AND tm.owner_id=$1 AND tm.deleted_at IS NULL))
 AND (t.kind<>'STUDIO' OR EXISTS(SELECT 1 FROM resources.studio_projects h WHERE h.id=t.payload->'task'->>'targetId' AND h.owner_id=$1 AND h.deleted_at IS NULL))`

func accessError(err error) error {
	var api *httpapi.Error
	if errors.As(err, &api) && (api.Status == 404 || api.Code == "ASSET_UNAVAILABLE") {
		return domain.ErrNotFound
	}
	return err
}
func taskActor(t domain.Task) string {
	if t.InitiatedBy != "" {
		return t.InitiatedBy
	}
	return t.OwnerID
}
func authorizeTaskWrite(ctx context.Context, db collaboration.DB, actor string, t domain.Task) error {
	if t.ProjectID == nil {
		if actor != t.OwnerID {
			return domain.ErrNotFound
		}
		return nil
	}
	if t.Kind == "STUDIO" {
		if actor != t.OwnerID {
			return domain.ErrNotFound
		}
		var pid string
		e := db.QueryRow(ctx, `SELECT id FROM public.projects WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE`, *t.ProjectID, actor).Scan(&pid)
		if errors.Is(e, pgx.ErrNoRows) {
			return domain.ErrNotFound
		}
		return e
	}
	scope, e := collaboration.RequireProject(ctx, db, actor, *t.ProjectID, "EDITOR", true)
	if e != nil {
		return accessError(e)
	}
	if (t.Kind == "CANVAS" || t.Kind == "MEDIA") && !domain.Terminal(t.State) {
		ids := []string{}
		for _, p := range t.Plans {
			ids = append(ids, p.NodeID)
		}
		if t.TargetType == "NODE" {
			ids = append(ids, t.TargetID)
		}
		var busy bool
		e = db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM longform.projects p WHERE p.canvas_id=$1 AND p.node_id=ANY($2::text[]) AND ((p.snapshot->>'activeJobId' IS NOT NULL AND p.snapshot->>'activeJobId'<>'') OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p.snapshot->'jobs','[]'::jsonb)) j WHERE j->>'status' IN ('QUEUED','RUNNING','SUBMITTING','COMPOSING','UNKNOWN')) OR EXISTS(SELECT 1 FROM longform.requests r WHERE r.project_id=p.id AND r.response IS NULL AND r.rejected_code IS NULL)))`, *t.ProjectID, ids).Scan(&busy)
		if e != nil {
			return e
		}
		if busy {
			return httpapi.Fail(409, "LONGFORM_NODE_BUSY", "此视频节点正在生成分段长片，请待本段完成并停止后继续。")
		}
	}
	if (t.Kind == "CANVAS" || t.Kind == "MEDIA") && scope.StorageOwnerID != t.OwnerID {
		return domain.ErrNotFound
	}
	return nil
}

// Only user-initiated mutations need the current canvas page. The role check
// locks the project until commit, serializing a cancellation or deletion with
// a writer handoff. Accepted worker completions use their existing task lease.
func authorizeUserTaskChange(ctx context.Context, db collaboration.DB, actor string, task domain.Task) error {
	if err := authorizeTaskWrite(ctx, db, actor, task); err != nil {
		return err
	}
	if task.ProjectID == nil || (task.Kind != "CANVAS" && task.Kind != "MEDIA") {
		return nil
	}
	caller := collaboration.CanvasLeaseRequestFrom(ctx)
	if caller.Identity.UserID != "" && caller.Identity.UserID != actor {
		return httpapi.Fail(403, "AUTHORIZATION_DENIED", "当前身份不能修改此画布任务。")
	}
	_, err := collaboration.CheckProjectEditSession(ctx, db, *task.ProjectID, caller.Identity, caller.ClientID, caller.ClientID != "")
	return err
}

func authorizeAssetRead(ctx context.Context, db collaboration.DB, actor, id string) error {
	e := collaboration.RequireAssetProjectRead(ctx, db, actor, id)
	if e == nil {
		return nil
	}
	var api *httpapi.Error
	if !errors.As(e, &api) || api.Status != 404 {
		return e
	}
	return accessError(collaboration.RequireAssetGrant(ctx, db, actor, id))
}
func authorizeTaskAssets(ctx context.Context, db collaboration.DB, t domain.Task, ids []string) error {
	if t.Kind == "CANVAS" && t.ProjectID != nil {
		return accessError(collaboration.AuthorizeProjectAssets(ctx, db, taskActor(t), *t.ProjectID, ids))
	}
	for _, id := range ids {
		e := collaboration.RequireAssetProjectRead(ctx, db, taskActor(t), id)
		if e != nil {
			var api *httpapi.Error
			if errors.As(e, &api) && api.Status == 404 {
				if tx, ok := db.(pgx.Tx); ok {
					e = collaboration.RequireAssetGrantForUse(ctx, tx, taskActor(t), id)
				} else {
					e = collaboration.RequireAssetGrant(ctx, db, taskActor(t), id)
				}
			}
		}
		if e != nil {
			return accessError(e)
		}
	}
	return nil
}

func (s *Store) Get(ctx context.Context, owner, id string) (domain.Task, error) {
	return scan(s.pool.QueryRow(ctx, "SELECT "+columns+" FROM execution.tasks t WHERE "+visible+" AND t.id=$2", owner, id))
}
func (s *Store) Create(ctx context.Context, t domain.Task, key, hash string, grants []application.Grant) (domain.Task, error) {
	return retryTransaction(ctx, func() (domain.Task, error) {
		return s.createOnce(ctx, transactionTask(t), key, hash, grants)
	})
}

func (s *Store) createOnce(ctx context.Context, t domain.Task, key, hash string, grants []application.Grant) (domain.Task, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return t, err
	}
	defer tx.Rollback(ctx)
	if t.InitiatedBy == "" {
		t.InitiatedBy = principal.Actor(ctx, t.OwnerID)
	}
	// Preflight reads do not invert task-before-project transaction locking.
	if t.ProjectID != nil && t.Kind != "STUDIO" {
		scope, e := collaboration.RequireProject(ctx, tx, taskActor(t), *t.ProjectID, "EDITOR", false)
		if e != nil {
			return t, e
		}
		if (t.Kind == "CANVAS" || t.Kind == "MEDIA") && scope.StorageOwnerID != t.OwnerID {
			return t, domain.ErrNotFound
		}
	}
	// Serialize same-owner same-key receipts, including an absent row.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", t.OwnerID+"/"+t.Kind+"/"+key); err != nil {
		return t, err
	}
	// Existing receipts must lock their task before authorization locks its
	// project, matching Save, BindInputs, cancellation and history mutations.
	old, findErr := scan(tx.QueryRow(ctx, "SELECT "+columns+" FROM execution.tasks t WHERE owner_id=$1 AND kind=$2 AND idempotency_key=$3 FOR UPDATE", t.OwnerID, t.Kind, key))
	if findErr == nil {
		if err = authorizeTaskWrite(ctx, tx, taskActor(t), t); err != nil {
			return t, err
		}
		var oldHash string
		if err = tx.QueryRow(ctx, "SELECT request_hash FROM execution.tasks WHERE id=$1", old.ID).Scan(&oldHash); err != nil {
			return t, err
		}
		if oldHash != hash || taskActor(old) != taskActor(t) {
			return t, domain.ErrConflict
		}
		if _, err = s.visibleTx(ctx, tx, taskActor(t), old.ID); err != nil {
			return t, err
		}
		return old, tx.Commit(ctx)
	}
	if !errors.Is(findErr, domain.ErrNotFound) {
		return t, findErr
	}
	// Historical task locks precede the destination project lock, matching the
	// task-before-project order used by workers and cancellation.
	if err = validateHistoryInputs(ctx, tx, t); err != nil {
		return t, err
	}
	if err = authorizeTaskWrite(ctx, tx, taskActor(t), t); err != nil {
		return t, err
	}
	// Authorization holds the project row lock. Lease acquisition takes that
	// same lock, so no other editor can claim a target between this check and
	// committing the new task. Existing idempotent receipts return above.
	if t.ProjectID != nil && (t.Kind == "CANVAS" || t.Kind == "MEDIA") {
		caller := collaboration.CanvasLeaseRequestFrom(ctx)
		if caller.Identity.UserID == "" {
			caller.Identity.UserID = taskActor(t)
		} else if caller.Identity.UserID != taskActor(t) {
			return t, &httpapi.Error{Status: 403, Code: "AUTHORIZATION_DENIED", Message: "任务操作人与当前登录账号不一致。"}
		}
		nodes := make([]string, 0, len(t.Plans))
		if t.TargetType == "NODE" && t.TargetID != "" {
			nodes = append(nodes, t.TargetID)
		}
		for _, plan := range t.Plans {
			nodes = append(nodes, plan.NodeID)
		}
		if err = collaboration.CheckNodeLeases(ctx, tx, *t.ProjectID, caller.Identity, caller.ClientID, nodes); err != nil {
			return t, err
		}
	}
	acceptance, err := prepareCanvasBinding(ctx, tx, &t)
	if err != nil {
		return t, err
	}
	if t.ProjectID != nil && acceptance == nil {
		if err = authorizeTaskWrite(ctx, tx, taskActor(t), t); err != nil {
			return t, err
		}
	}
	if t.ConversationID != nil {
		seq, revision, lockErr := lockConversationForRun(ctx, tx, t.OwnerID, *t.ConversationID)
		err = lockErr
		if err != nil {
			return t, err
		}
		if t.ConversationRevision < 1 || t.ConversationRevision != revision {
			return t, domain.ErrConflict
		}
		var mseq int64
		err = tx.QueryRow(ctx, "SELECT sequence FROM assistant.messages WHERE id=$1 AND conversation_id=$2 AND owner_id=$3 AND role='USER' AND deleted_at IS NULL", t.MessageID, *t.ConversationID, t.OwnerID).Scan(&mseq)
		if errors.Is(err, pgx.ErrNoRows) {
			return t, domain.ErrNotFound
		}
		if err != nil {
			return t, err
		}
		if mseq != seq-1 {
			return t, domain.ErrConflict
		}
		var busy bool
		if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM execution.tasks WHERE conversation_id=$1 AND state IN ('QUEUED','RUNNING')) OR EXISTS(SELECT 1 FROM assistant.agent_runs WHERE conversation_id=$1 AND state IN ('QUEUED','RUNNING','WAITING_FOR_AUTH'))", *t.ConversationID).Scan(&busy); err != nil {
			return t, err
		}
		if busy {
			return t, domain.ErrBusy
		}
	}
	ids := []string{}
	for _, g := range grants {
		ids = append(ids, g.AssetID)
	}
	if err = authorizeTaskAssets(ctx, tx, t, ids); err != nil {
		return t, err
	}
	for _, g := range grants {
		var checksum, version string
		err = tx.QueryRow(ctx, "SELECT a.checksum_sha256,'sha256:'||a.checksum_sha256 FROM public.assets a JOIN public.projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE a.id=$1 AND a.state='READY' AND a.deleted_at IS NULL AND p.deleted_at IS NULL FOR SHARE OF a,p", g.AssetID).Scan(&checksum, &version)
		if errors.Is(err, pgx.ErrNoRows) {
			return t, domain.ErrNotFound
		}
		if err != nil {
			return t, err
		}
		if checksum != g.SHA256 || version != g.Version {
			return t, domain.ErrConflict
		}
	}
	body, err := encode(t)
	if err != nil {
		return t, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO execution.tasks(id,owner_id,project_id,conversation_id,kind,state,request_hash,idempotency_key,payload,created_at,updated_at,initiated_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)`, t.ID, t.OwnerID, t.ProjectID, t.ConversationID, t.Kind, t.State, hash, key, body, t.CreatedAt, taskActor(t))
	if err != nil {
		return t, err
	}
	if err = attachCanvasBinding(ctx, tx, t, acceptance); err != nil {
		return t, err
	}
	for _, g := range grants {
		if _, err = tx.Exec(ctx, "INSERT INTO execution.task_assets(task_id,owner_id,asset_id,direction)VALUES($1,$2,$3,'INPUT') ON CONFLICT DO NOTHING", t.ID, t.OwnerID, g.AssetID); err != nil {
			return t, err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO execution.read_grants(id,task_id,owner_id,asset_id,source_version,checksum_sha256,expires_at)VALUES($1,$2,$3,$4,$5,$6,now()+interval '24 hours')", g.ID, t.ID, t.OwnerID, g.AssetID, g.Version, g.SHA256); err != nil {
			return t, err
		}
	}
	if err = event(ctx, tx, t, "state.changed", map[string]any{"state": t.State}); err != nil {
		return t, err
	}
	err = tx.Commit(ctx)
	if err == nil {
		s.record(ctx, t, "ACCEPTED", false)
	}
	return t, err
}
func (s *Store) visibleTx(ctx context.Context, tx pgx.Tx, owner, id string) (domain.Task, error) {
	return scan(tx.QueryRow(ctx, "SELECT "+columns+" FROM execution.tasks t WHERE "+visible+" AND t.id=$2 FOR UPDATE", owner, id))
}

// The new task's context and current USER must still belong to this revision.
// Parent locks also keep a bound HF/Canvas from disappearing before commit.
func lockConversationForRun(ctx context.Context, tx pgx.Tx, owner, cid string) (sequence, revision int64, err error) {
	var canvas, hf *string
	err = tx.QueryRow(ctx, `SELECT next_message_sequence,revision,canvas_project_id,hf_project_id FROM assistant.conversations WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE`, cid, owner).Scan(&sequence, &revision, &canvas, &hf)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, domain.ErrNotFound
	}
	if err != nil {
		return 0, 0, err
	}
	lockProject := func(id string) error {
		var actual string
		e := tx.QueryRow(ctx, `SELECT id FROM public.projects WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND internal_kind IS NULL FOR SHARE`, id, owner).Scan(&actual)
		if errors.Is(e, pgx.ErrNoRows) {
			return domain.ErrNotFound
		}
		return e
	}
	if canvas != nil {
		if _, err = collaboration.RequireProject(ctx, tx, owner, *canvas, "EDITOR", true); err != nil {
			return 0, 0, err
		}
	}
	if hf != nil {
		var underlying *string
		err = tx.QueryRow(ctx, `SELECT project_id FROM resources.studio_projects WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR SHARE`, *hf, owner).Scan(&underlying)
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, 0, domain.ErrNotFound
		}
		if err != nil {
			return 0, 0, err
		}
		if underlying != nil {
			if err = lockProject(*underlying); err != nil {
				return 0, 0, err
			}
		}
	}
	return sequence, revision, nil
}
func (s *Store) Assets(ctx context.Context, owner string, ids []string) ([]application.Asset, error) {
	result := []application.Asset{}
	actor := principal.Actor(ctx, owner)
	if project := principal.Project(ctx); project != "" {
		if err := collaboration.AuthorizeProjectAssets(ctx, s.pool, actor, project, ids); err != nil {
			return nil, accessError(err)
		}
	} else {
		for _, id := range ids {
			if err := authorizeAssetRead(ctx, s.pool, actor, id); err != nil {
				return nil, err
			}
		}
	}
	for _, id := range ids {
		var a application.Asset
		var duration *int64
		err := s.pool.QueryRow(ctx, `SELECT a.id,a.kind,a.mime_type,'sha256:'||a.checksum_sha256,a.checksum_sha256,a.byte_size,a.width,a.height,round(a.duration_seconds*1000)::bigint FROM public.assets a JOIN public.projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE a.id=$1 AND a.state='READY' AND a.deleted_at IS NULL AND p.deleted_at IS NULL`, id).Scan(&a.ID, &a.Kind, &a.MimeType, &a.Version, &a.SHA256, &a.ByteSize, &a.Width, &a.Height, &duration)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if duration != nil {
			a.DurationMs = duration
		}
		result = append(result, a)
	}
	return result, nil
}
func (s *Store) Conversation(ctx context.Context, owner, cid, mid string) (application.ConversationInput, error) {
	var in application.ConversationInput
	err := s.pool.QueryRow(ctx, `SELECT c.business,c.canvas_project_id,m.content,m.sequence,c.revision FROM assistant.conversations c JOIN assistant.messages m ON m.conversation_id=c.id AND m.owner_id=c.owner_id WHERE c.id=$1 AND c.owner_id=$2 AND c.deleted_at IS NULL AND m.id=$3 AND m.role='USER' AND m.deleted_at IS NULL AND (c.hf_project_id IS NULL OR EXISTS(SELECT 1 FROM resources.studio_projects h WHERE h.id=c.hf_project_id AND h.owner_id=c.owner_id AND h.deleted_at IS NULL AND (h.project_id IS NULL OR EXISTS(SELECT 1 FROM public.projects hp WHERE hp.id=h.project_id AND hp.owner_id=h.owner_id AND hp.deleted_at IS NULL AND hp.internal_kind IS NULL)))) AND (c.canvas_project_id IS NULL OR EXISTS(SELECT 1 FROM public.projects p WHERE p.id=c.canvas_project_id AND collaboration.project_role(p.id,c.owner_id) IS NOT NULL))`, cid, owner, mid).Scan(&in.Kind, &in.ProjectID, &in.Content, &in.Sequence, &in.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return in, domain.ErrNotFound
	}
	if err != nil {
		return in, err
	}
	err = s.pool.QueryRow(ctx, `SELECT jsonb_build_object('schemaVersion','1','messages',COALESCE(jsonb_agg(jsonb_build_object('role',role,'content',content) ORDER BY sequence),'[]'::jsonb)) FROM assistant.messages WHERE conversation_id=$1 AND owner_id=$2 AND deleted_at IS NULL AND sequence<=$3`, cid, owner, in.Sequence).Scan(&in.Context)
	if err != nil {
		return in, err
	}
	// The most recent accepted turn freezes the selection epoch. The Create
	// conversation lock/revision check rejects a concurrently changed context.
	err = s.pool.QueryRow(ctx, `SELECT COALESCE(t.payload->'task'->'plans'->0->>'capabilityRef',''),COALESCE(t.payload->'task'->'plans'->0->>'capabilityVersion',''),COALESCE(t.payload->'private'->0->>'RouterConversationRef',''),t.state FROM execution.tasks t JOIN assistant.messages m ON m.id=t.payload->'task'->>'messageId' AND m.owner_id=t.owner_id WHERE t.owner_id=$1 AND t.conversation_id=$2 AND t.kind='ASSISTANT' AND m.conversation_id=$2 AND m.sequence<$3 ORDER BY m.sequence DESC,t.created_at DESC,t.id DESC LIMIT 1`, owner, cid, in.Sequence).Scan(&in.PreviousCapabilityRef, &in.PreviousCapabilityVersion, &in.RouterConversationRef, &in.PreviousState)
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	return in, err
}
func (s *Store) Claim(ctx context.Context, lease string) (domain.Task, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Task{}, false, err
	}
	defer tx.Rollback(ctx)
	t, err := scan(tx.QueryRow(ctx, "SELECT "+columns+" FROM execution.tasks t WHERE state IN ('QUEUED','RUNNING') AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1"))
	if errors.Is(err, domain.ErrNotFound) {
		return t, false, nil
	}
	if err != nil {
		return t, false, err
	}
	if _, err = tx.Exec(ctx, "UPDATE execution.tasks SET lease_token=$2,lease_until=now()+interval '60 seconds' WHERE id=$1", t.ID, lease); err != nil {
		return t, false, err
	}
	return t, true, tx.Commit(ctx)
}
func event(ctx context.Context, tx pgx.Tx, t domain.Task, kind string, value any) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO execution.events(task_id,owner_id,sequence,type,data,test_mode) SELECT $1,$2,COALESCE(max(sequence),0)+1,$3,$4,$5 FROM execution.events WHERE task_id=$1`, t.ID, t.OwnerID, kind, body, t.TestMode)
	return err
}
func (s *Store) Save(ctx context.Context, t domain.Task, lease string) (bool, error) {
	ok, err := retryTransaction(ctx, func() (bool, error) {
		return s.saveOnce(ctx, transactionTask(t), lease)
	})
	if err != nil && ctx.Err() == nil {
		code := "TASK_PERSISTENCE_FAILED"
		t.ErrorCode = &code
		s.record(ctx, t, "PERSISTENCE_FAILED", true)
	}
	return ok, err
}

func (s *Store) saveOnce(ctx context.Context, t domain.Task, lease string) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	old, err := scan(tx.QueryRow(ctx, "SELECT "+columns+" FROM execution.tasks t WHERE id=$1 AND owner_id=$2 AND lease_token=$3 AND state IN ('QUEUED','RUNNING') FOR UPDATE", t.ID, t.OwnerID, lease))
	if errors.Is(err, domain.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	// Lock selected source histories before the destination project. A source
	// worker may still be committing its final task state after a plan succeeds.
	if old.CanvasManaged {
		if e := validateHistoryInputs(ctx, tx, t); e != nil && !errors.Is(e, domain.ErrNotFound) && !errors.Is(e, domain.ErrConflict) {
			return false, e
		}
	}
	if old.CanvasManaged && old.ProjectID != nil {
		var project string
		if err = tx.QueryRow(ctx, `SELECT id FROM public.projects WHERE id=$1 AND owner_id=$2 FOR UPDATE`, *old.ProjectID, old.OwnerID).Scan(&project); err != nil {
			return false, err
		}
	}
	// Parent visibility is rechecked before any result becomes user-visible.
	if _, err = s.visibleTx(ctx, tx, taskActor(t), t.ID); errors.Is(err, domain.ErrNotFound) {
		t.State = "CANCELED"
		code := "PARENT_DELETED"
		t.ErrorCode = &code
	} else if err != nil {
		return false, err
	}
	if t.ProjectID != nil && t.State != "CANCELED" {
		if e := authorizeTaskWrite(ctx, tx, taskActor(t), t); e != nil {
			// Only a typed authority loss cancels execution. Database/context
			// failures must abort here, preserving SQLSTATE for transaction retry.
			var denied *httpapi.Error
			if !errors.Is(e, domain.ErrNotFound) && !(errors.As(e, &denied) && (denied.Status == 401 || denied.Status == 403)) {
				return false, e
			}
			t.State = "CANCELED"
			code := "PROJECT_ACCESS_REVOKED"
			t.ErrorCode = &code
			for i := range t.Plans {
				// Discard results accepted only by this stale worker after revocation.
				if i >= len(old.Plans) || !domain.Terminal(old.Plans[i].State) {
					t.Plans[i].State = "CANCELED"
					t.Plans[i].Outputs = []domain.Output{}
				}
			}
		}
	}
	if t.ErrorCode != nil && (*t.ErrorCode == "PARENT_DELETED" || *t.ErrorCode == "PROJECT_ACCESS_REVOKED") {
		for i := range t.Plans {
			if i >= len(old.Plans) || !domain.Terminal(old.Plans[i].State) {
				t.Plans[i].State = "CANCELED"
				t.Plans[i].Outputs = []domain.Output{}
			}
		}
	}
	t.Revision = old.Revision + 1
	t.CanvasManaged = old.CanvasManaged
	// User history tombstones survive a worker saving an older aggregate copy.
	for i, p := range t.Plans {
		for _, prior := range old.Plans {
			if p.ExecutionID != prior.ExecutionID {
				continue
			}
			t.Plans[i].CanvasBinding = prior.CanvasBinding
			if prior.HistoryDeletedAt != nil {
				t.Plans[i].HistoryDeletedAt = prior.HistoryDeletedAt
			}
			for j, o := range p.Outputs {
				for _, po := range prior.Outputs {
					if o.ID == po.ID && po.DeletedAt != nil {
						t.Plans[i].Outputs[j].DeletedAt = po.DeletedAt
					}
				}
			}
		}
	}
	t.UpdatedAt = time.Now().UTC().Truncate(time.Millisecond)
	for i, p := range t.Plans {
		if p.State == "SUCCEEDED" && i < len(old.Plans) && old.Plans[i].State != "SUCCEEDED" {
			if err = bumpHistory(ctx, tx, t, p.NodeID); err != nil {
				return false, err
			}
		}
		if i < len(old.Plans) && old.Plans[i].State != p.State {
			if err = event(ctx, tx, t, "plan.state.changed", map[string]any{"nodeId": p.NodeID, "executionId": p.ExecutionID, "state": p.State}); err != nil {
				return false, err
			}
		}
		if i < len(old.Plans) && planProgressChanged(old.Plans[i], p) {
			if err = event(ctx, tx, t, "plan.progress.changed", map[string]any{"nodeId": p.NodeID, "executionId": p.ExecutionID, "progress": p.Progress, "progressDetail": p.ProgressDetail}); err != nil {
				return false, err
			}
		}
		for j, o := range p.Outputs {
			if o.AssetID != nil && o.DeletedAt == nil && (t.ErrorCode == nil || (*t.ErrorCode != "PARENT_DELETED" && *t.ErrorCode != "PROJECT_ACCESS_REVOKED")) {
				var owner string
				err = tx.QueryRow(ctx, "SELECT a.owner_id FROM public.assets a JOIN public.projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE a.id=$1 AND a.state='READY' AND a.deleted_at IS NULL AND p.deleted_at IS NULL FOR SHARE OF a,p", *o.AssetID).Scan(&owner)
				if errors.Is(err, pgx.ErrNoRows) && t.CanvasManaged {
					// Import may have completed just before the asset was deleted.
					// Preserve the final task and history tombstone instead of
					// leaving a completed model invocation indefinitely RUNNING.
					now := t.UpdatedAt
					t.Plans[i].Outputs[j].DeletedAt = &now
					continue
				}
				if err != nil {
					return false, err
				}
				if err = authorizeTaskAssets(ctx, tx, t, []string{*o.AssetID}); err != nil {
					return false, err
				}
				if _, err = tx.Exec(ctx, "INSERT INTO execution.task_assets(task_id,owner_id,asset_id,direction)VALUES($1,$2,$3,'OUTPUT') ON CONFLICT DO NOTHING", t.ID, t.OwnerID, *o.AssetID); err != nil {
					return false, err
				}
			}
		}
	}
	if err = applyCanvasBinding(ctx, tx, &t); err != nil {
		return false, err
	}
	if t.State == "SUCCEEDED" && t.ConversationID != nil {
		var exists bool
		if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM execution.assistant_results WHERE task_id=$1)", t.ID).Scan(&exists); err != nil {
			return false, err
		}
		if !exists {
			parts := []map[string]any{}
			for _, p := range t.Plans {
				for _, o := range p.Outputs {
					if o.Type == "TEXT" && o.Text != nil {
						parts = append(parts, map[string]any{"type": "TEXT", "text": *o.Text})
					}
				}
			}
			if len(parts) == 0 {
				return false, domain.ErrInvalid
			}
			body, _ := json.Marshal(parts)
			var seq int64
			err = tx.QueryRow(ctx, "SELECT next_message_sequence FROM assistant.conversations WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE", *t.ConversationID, t.OwnerID).Scan(&seq)
			if err != nil {
				return false, err
			}
			mid := "msg_" + strings.TrimPrefix(t.ID, "tsk_") + "_response"
			_, err = tx.Exec(ctx, "INSERT INTO assistant.messages(id,conversation_id,owner_id,sequence,role,content)VALUES($1,$2,$3,$4,'ASSISTANT',$5)", mid, *t.ConversationID, t.OwnerID, seq, body)
			if err != nil {
				return false, err
			}
			_, err = tx.Exec(ctx, "UPDATE assistant.conversations SET next_message_sequence=next_message_sequence+1,revision=revision+1,updated_at=now() WHERE id=$1", *t.ConversationID)
			if err != nil {
				return false, err
			}
			_, err = tx.Exec(ctx, "INSERT INTO execution.assistant_results(task_id,message_id)VALUES($1,$2)", t.ID, mid)
			if err != nil {
				return false, err
			}
			if err = event(ctx, tx, t, "chat.delta", map[string]any{"text": parts[0]["text"], "messageId": mid}); err != nil {
				return false, err
			}
		}
	}
	if old.State != t.State {
		if err = event(ctx, tx, t, "state.changed", map[string]any{"state": t.State}); err != nil {
			return false, err
		}
	}
	body, err := encode(t)
	if err != nil {
		return false, err
	}
	_, err = tx.Exec(ctx, "UPDATE execution.tasks SET payload=$2,state=$3,revision=$4,updated_at=$5,lease_until=CASE WHEN $6 THEN NULL ELSE now()+interval '60 seconds' END,lease_token=CASE WHEN $6 THEN NULL ELSE lease_token END WHERE id=$1", t.ID, body, t.State, t.Revision, t.UpdatedAt, domain.Terminal(t.State))
	if err != nil {
		return false, err
	}
	err = tx.Commit(ctx)
	if err == nil {
		s.recordSave(ctx, old, t)
	}
	return err == nil, err
}
func (s *Store) Cancel(ctx context.Context, owner, id string) (domain.Task, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Task{}, err
	}
	defer tx.Rollback(ctx)
	t, err := s.visibleTx(ctx, tx, owner, id)
	if err != nil {
		return t, err
	}
	if err = authorizeUserTaskChange(ctx, tx, owner, t); err != nil {
		return t, err
	}
	if !domain.Terminal(t.State) {
		if t.Kind == "CANVAS" || t.Kind == "ASSISTANT" {
			var claimed bool
			if err = tx.QueryRow(ctx, "SELECT lease_token IS NOT NULL FROM execution.tasks WHERE id=$1", id).Scan(&claimed); err != nil {
				return t, err
			}
			if t.RequiresNativeCancellation(claimed) {
				return t, domain.ErrCancellationUnsupported
			}
		}
		t.State = "CANCELED"
		t.Revision++
		t.UpdatedAt = time.Now().UTC()
		for i := range t.Plans {
			if !domain.Terminal(t.Plans[i].State) {
				t.Plans[i].State = "CANCELED"
			}
		}
		if err = applyCanvasBinding(ctx, tx, &t); err != nil {
			return t, err
		}
		body, _ := encode(t)
		_, err = tx.Exec(ctx, "UPDATE execution.tasks SET payload=$2,state='CANCELED',revision=$3,updated_at=$4,lease_token=NULL,lease_until=NULL WHERE id=$1", id, body, t.Revision, t.UpdatedAt)
		if err != nil {
			return t, err
		}
		if err = event(ctx, tx, t, "state.changed", map[string]any{"state": "CANCELED"}); err != nil {
			return t, err
		}
	}
	err = tx.Commit(ctx)
	if err == nil {
		s.record(ctx, t, "CANCEL_RECEIPT", false)
	}
	return t, err
}
func (s *Store) Events(ctx context.Context, owner, id string, after int64) (application.EventPage, error) {
	t, err := s.Get(ctx, owner, id)
	if err != nil {
		return application.EventPage{}, err
	}
	page := application.EventPage{Items: []application.Event{}, Terminal: domain.Terminal(t.State), SchemaVersion: "1"}
	rows, err := s.pool.Query(ctx, "SELECT sequence,type,data,observed_at,test_mode FROM execution.events WHERE task_id=$1 AND owner_id=$2 AND sequence>$3 ORDER BY sequence LIMIT 100", id, t.OwnerID, after)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var e application.Event
		if err = rows.Scan(&e.Sequence, &e.Type, &e.Data, &e.ObservedAt, &e.TestMode); err != nil {
			return page, err
		}
		page.Items = append(page.Items, e)
		cursor := strconv.FormatInt(e.Sequence, 10)
		page.NextCursor = &cursor
	}
	return page, rows.Err()
}

var _ application.Store = (*Store)(nil)

func bumpHistory(ctx context.Context, tx pgx.Tx, t domain.Task, nodeID string) error {
	if t.ProjectID == nil || t.Kind == "ASSISTANT" {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO execution.history_revisions(owner_id,project_id,node_id)VALUES($1,$2,$3) ON CONFLICT(owner_id,project_id,node_id) DO UPDATE SET revision=nextval('execution.history_sequence')`, t.OwnerID, *t.ProjectID, nodeID)
	return err
}

// ActiveAssistant authorizes the actual conversation before returning SQL absence.
func (s *Store) ActiveAssistant(ctx context.Context, owner, cid string) ([]domain.Task, error) {
	var id string
	err := s.pool.QueryRow(ctx, `SELECT c.id FROM assistant.conversations c WHERE c.id=$1 AND c.owner_id=$2 AND c.deleted_at IS NULL AND (c.hf_project_id IS NULL OR EXISTS(SELECT 1 FROM resources.studio_projects h WHERE h.id=c.hf_project_id AND h.owner_id=c.owner_id AND h.deleted_at IS NULL AND (h.project_id IS NULL OR EXISTS(SELECT 1 FROM public.projects hp WHERE hp.id=h.project_id AND hp.owner_id=h.owner_id AND hp.deleted_at IS NULL AND hp.internal_kind IS NULL)))) AND (c.canvas_project_id IS NULL OR EXISTS(SELECT 1 FROM public.projects p WHERE p.id=c.canvas_project_id AND collaboration.project_role(p.id,c.owner_id) IS NOT NULL))`, cid, owner).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, domain.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, "SELECT "+columns+" FROM execution.tasks t WHERE "+visible+" AND t.conversation_id=$2 AND t.kind='ASSISTANT' AND t.state IN ('QUEUED','RUNNING','WAITING_TOOL') ORDER BY created_at,id LIMIT 2", owner, cid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tasks := []domain.Task{}
	for rows.Next() {
		task, e := scan(rows)
		if e != nil {
			return nil, e
		}
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}
