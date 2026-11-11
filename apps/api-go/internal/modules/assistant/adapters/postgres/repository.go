// Package postgres implements transaction-bound assistant persistence.
package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/assistant/application"
	"studiotv.local/service/api/internal/modules/assistant/domain"
)

type UnitOfWork struct{ pool *pgxpool.Pool }

var _ application.UnitOfWork = (*UnitOfWork)(nil)

func New(pool *pgxpool.Pool) (*UnitOfWork, error) {
	if pool == nil {
		return nil, errors.New("assistant postgres pool is required")
	}
	return &UnitOfWork{pool: pool}, nil
}

// pgx errors can contain SQL values/connection details. Never forward them to
// the shared HTTP logger or envelope; callers get a sanitized dependency error.
func (u *UnitOfWork) Within(ctx context.Context, fn func(application.Repositories) error) error {
	tx, err := u.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return domain.ErrUnavailable
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	if err = fn(&repository{tx: tx}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.ErrUnavailable
	}
	return nil
}

type repository struct{ tx pgx.Tx }

var _ application.Repositories = (*repository)(nil)

func (r *repository) OwnedProject(ctx context.Context, owner, id string) error {
	_, err := collaboration.RequireProject(ctx, r.tx, owner, id, "EDITOR", true)
	var api *httpapi.Error
	if errors.As(err, &api) && api.Status == 404 {
		return domain.ErrProjectNotFound
	}
	return err
}
func (r *repository) LockIdempotency(ctx context.Context, owner, operation, key string) error {
	_, err := r.tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", owner+":"+operation+":"+key)
	return storageError(err)
}

// Stored response_body is the same public data object returned by POST, as in
// core's existing idempotency convention; it contains no owner/session secrets.
type creationResponse struct {
	ID          string    `json:"id"`
	Revision    int64     `json:"revision"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
	ProjectID   *string   `json:"projectId"`
	HFProjectID *string   `json:"hfProjectId"`
	Kind        string    `json:"kind"`
	Title       string    `json:"title"`
}

func (r *repository) FindReceipt(ctx context.Context, owner, operation, key string) (*application.Receipt, error) {
	var hash string
	var status int
	var body []byte
	err := r.tx.QueryRow(ctx, "SELECT request_hash,response_status,response_body FROM public.idempotency_keys WHERE owner_id=$1 AND operation=$2 AND key=$3", owner, operation, key).Scan(&hash, &status, &body)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, domain.ErrUnavailable
	}
	var response creationResponse
	if status != 201 || json.Unmarshal(body, &response) != nil || (domain.Create{Kind: domain.Kind(response.Kind), ProjectID: response.ProjectID, HFProjectID: response.HFProjectID, Title: response.Title}).Validate() != nil || !domain.ValidID(response.ID) || response.Revision < 1 || response.CreatedAt.IsZero() || response.UpdatedAt.IsZero() {
		return nil, domain.ErrUnavailable
	}
	root := domain.Conversation{ID: response.ID, OwnerID: owner, Kind: domain.Kind(response.Kind), ProjectID: response.ProjectID, HFProjectID: response.HFProjectID, Title: response.Title, Revision: response.Revision, NextMessageSequence: 1, CreatedAt: response.CreatedAt, UpdatedAt: response.UpdatedAt}
	return &application.Receipt{RequestHash: hash, Conversation: root}, nil
}
func (r *repository) SaveReceipt(ctx context.Context, owner, operation, key string, receipt application.Receipt) error {
	c := receipt.Conversation
	// HTTP uses millisecond UTC timestamps; store that exact initial projection.
	response := creationResponse{ID: c.ID, Revision: c.Revision, CreatedAt: c.CreatedAt.UTC().Truncate(time.Millisecond), UpdatedAt: c.UpdatedAt.UTC().Truncate(time.Millisecond), ProjectID: c.ProjectID, HFProjectID: c.HFProjectID, Kind: string(c.Kind), Title: c.Title}
	body, err := json.Marshal(response)
	if err != nil {
		return domain.ErrUnavailable
	}
	_, err = r.tx.Exec(ctx, "INSERT INTO public.idempotency_keys(owner_id,operation,key,request_hash,response_status,response_body) VALUES($1,$2,$3,$4,201,$5)", owner, operation, key, receipt.RequestHash, body)
	return storageError(err)
}
func (r *repository) CreateConversation(ctx context.Context, c domain.Conversation) error {
	_, err := r.tx.Exec(ctx, `INSERT INTO assistant.conversations(id,owner_id,business,canvas_project_id,hf_project_id,title,revision,next_message_sequence,created_at,updated_at)
	 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, c.ID, c.OwnerID, string(c.Kind), c.ProjectID, c.HFProjectID, c.Title, c.Revision, c.NextMessageSequence, c.CreatedAt, c.UpdatedAt)
	return storageError(err)
}

const conversationColumns = "c.id,c.owner_id,c.business,c.canvas_project_id,c.hf_project_id,c.title,c.title_generated,c.revision,c.next_message_sequence,c.router_key,c.router_session_ref,c.created_at,c.updated_at,c.deleted_at"

func scanConversation(row pgx.Row) (domain.Conversation, error) {
	var c domain.Conversation
	err := row.Scan(&c.ID, &c.OwnerID, &c.Kind, &c.ProjectID, &c.HFProjectID, &c.Title, &c.TitleGenerated, &c.Revision, &c.NextMessageSequence, &c.RouterKey, &c.RouterSessionRef, &c.CreatedAt, &c.UpdatedAt, &c.DeletedAt)
	return c, err
}
func (r *repository) Conversation(ctx context.Context, owner, id string, write bool) (domain.Conversation, error) {
	query := "SELECT " + conversationColumns + ` FROM assistant.conversations c
	 WHERE c.id=$1 AND c.owner_id=$2 AND c.deleted_at IS NULL AND
	 (c.business='GLOBAL' OR (c.business='HF' AND (c.hf_project_id IS NULL OR EXISTS(SELECT 1 FROM resources.studio_projects h WHERE h.id=c.hf_project_id AND h.owner_id=c.owner_id AND h.deleted_at IS NULL AND (h.project_id IS NULL OR EXISTS(SELECT 1 FROM public.projects hp WHERE hp.id=h.project_id AND hp.owner_id=h.owner_id AND hp.deleted_at IS NULL AND hp.internal_kind IS NULL))))) OR (c.business='CANVAS' AND EXISTS (SELECT 1 FROM public.projects p
	 WHERE p.id=c.canvas_project_id AND collaboration.project_role(p.id,c.owner_id) IS NOT NULL AND p.deleted_at IS NULL AND p.internal_kind IS NULL)))`
	if write {
		query += " FOR UPDATE OF c"
	} else {
		query += " FOR SHARE OF c"
	}
	c, err := scanConversation(r.tx.QueryRow(ctx, query, id, owner))
	if errors.Is(err, pgx.ErrNoRows) {
		return c, domain.ErrConversationNotFound
	}
	if err != nil {
		return c, storageError(err)
	}
	// Only Canvas roots lock/check a project; Global roots have no dependency.
	if c.Kind == domain.Canvas {
		if c.ProjectID == nil {
			return c, domain.ErrUnavailable
		}
		role := "VIEWER"
		if write {
			role = "EDITOR"
		}
		_, err = collaboration.RequireProject(ctx, r.tx, owner, *c.ProjectID, role, write)
		if err != nil {
			if errors.Is(err, domain.ErrProjectNotFound) {
				return c, domain.ErrConversationNotFound
			}
			return c, err
		}
	}
	if c.Kind == domain.HF && c.HFProjectID != nil {
		if err = r.OwnedHFProject(ctx, owner, *c.HFProjectID); err != nil {
			if errors.Is(err, domain.ErrProjectNotFound) {
				return c, domain.ErrConversationNotFound
			}
			return c, err
		}
	}
	return c, nil
}
func (r *repository) DeleteConversation(ctx context.Context, c domain.Conversation, expected int64) error {
	result, err := r.tx.Exec(ctx, `UPDATE assistant.conversations SET deleted_at=$4,updated_at=$4,revision=$5
	 WHERE id=$1 AND owner_id=$2 AND revision=$3 AND deleted_at IS NULL`, c.ID, c.OwnerID, expected, c.DeletedAt, c.Revision)
	if err != nil {
		return domain.ErrUnavailable
	}
	if result.RowsAffected() != 1 {
		return domain.ErrConversationNotFound
	}
	return nil
}

type conversationRecord struct {
	ID                  string      `json:"id"`
	OwnerID             string      `json:"owner_id"`
	Kind                domain.Kind `json:"business"`
	ProjectID           *string     `json:"canvas_project_id"`
	HFProjectID         *string     `json:"hf_project_id"`
	Title               string      `json:"title"`
	TitleGenerated      bool        `json:"title_generated"`
	Revision            int64       `json:"revision"`
	NextMessageSequence int64       `json:"next_message_sequence"`
	RouterKey           *string     `json:"router_key"`
	RouterSessionRef    *string     `json:"router_session_ref"`
	CreatedAt           time.Time   `json:"created_at"`
	UpdatedAt           time.Time   `json:"updated_at"`
}

func (r *repository) Conversations(ctx context.Context, owner string, q domain.ConversationQuery) (domain.Page[domain.Conversation], error) {
	var total int64
	var raw []byte
	// One statement gives records and total the same READ COMMITTED snapshot,
	// including an out-of-range empty page. Stable ordering always includes id.
	err := r.tx.QueryRow(ctx, `WITH filtered AS MATERIALIZED (
	 SELECT `+conversationColumns+` FROM assistant.conversations c
	 WHERE c.owner_id=$1 AND c.deleted_at IS NULL AND (c.business='GLOBAL' OR (c.business='HF' AND (c.hf_project_id IS NULL OR EXISTS(SELECT 1 FROM resources.studio_projects h WHERE h.id=c.hf_project_id AND h.owner_id=c.owner_id AND h.deleted_at IS NULL AND (h.project_id IS NULL OR EXISTS(SELECT 1 FROM public.projects hp WHERE hp.id=h.project_id AND hp.owner_id=h.owner_id AND hp.deleted_at IS NULL AND hp.internal_kind IS NULL))))) OR (c.business='CANVAS' AND EXISTS
	 (SELECT 1 FROM public.projects p WHERE p.id=c.canvas_project_id AND collaboration.project_role(p.id,c.owner_id) IS NOT NULL AND p.deleted_at IS NULL AND p.internal_kind IS NULL)))
	 AND ($2::text IS NULL OR c.canvas_project_id=$2) AND ($6::text IS NULL OR c.business=$6)
	 AND ($7::text IS NULL OR c.hf_project_id=$7) AND ($3::text IS NULL OR c.title ILIKE $3)),
	 page AS (SELECT * FROM filtered ORDER BY updated_at DESC,id LIMIT $4 OFFSET $5), total AS (SELECT count(*) AS n FROM filtered)
	 SELECT total.n,COALESCE(jsonb_agg(to_jsonb(page) ORDER BY page.updated_at DESC,page.id) FILTER(WHERE page.id IS NOT NULL),'[]'::jsonb)
	 FROM total LEFT JOIN page ON true GROUP BY total.n`, owner, q.ProjectID, search(q.Keyword), q.Size, q.Offset(), q.Kind, q.HFProjectID).Scan(&total, &raw)
	if err != nil {
		return domain.Page[domain.Conversation]{}, domain.ErrUnavailable
	}
	var records []conversationRecord
	if json.Unmarshal(raw, &records) != nil {
		return domain.Page[domain.Conversation]{}, domain.ErrUnavailable
	}
	roots := make([]domain.Conversation, 0, len(records))
	for _, c := range records {
		roots = append(roots, domain.Conversation{ID: c.ID, OwnerID: c.OwnerID, Kind: c.Kind, ProjectID: c.ProjectID, HFProjectID: c.HFProjectID, Title: c.Title, TitleGenerated: c.TitleGenerated, Revision: c.Revision, NextMessageSequence: c.NextMessageSequence, RouterKey: c.RouterKey, RouterSessionRef: c.RouterSessionRef, CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt})
	}
	return domain.NewPage(q.PageQuery, roots, total), nil
}

type messageRecord struct {
	ID             string          `json:"id"`
	ConversationID string          `json:"conversation_id"`
	Sequence       int64           `json:"sequence"`
	Role           string          `json:"role"`
	Content        json.RawMessage `json:"content"`
	CreatedAt      time.Time       `json:"created_at"`
}

func (r *repository) Messages(ctx context.Context, owner, id string, q domain.PageQuery) (domain.Page[domain.Message], error) {
	var total int64
	var raw []byte
	err := r.tx.QueryRow(ctx, `WITH filtered AS MATERIALIZED (
	 SELECT m.id,m.conversation_id,m.sequence,m.role,m.content,m.created_at
	 FROM assistant.messages m JOIN assistant.conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
	 WHERE m.owner_id=$1 AND m.conversation_id=$2 AND m.deleted_at IS NULL AND c.deleted_at IS NULL AND (c.business='GLOBAL' OR (c.business='HF' AND (c.hf_project_id IS NULL OR EXISTS(SELECT 1 FROM resources.studio_projects h WHERE h.id=c.hf_project_id AND h.owner_id=c.owner_id AND h.deleted_at IS NULL AND (h.project_id IS NULL OR EXISTS(SELECT 1 FROM public.projects hp WHERE hp.id=h.project_id AND hp.owner_id=h.owner_id AND hp.deleted_at IS NULL AND hp.internal_kind IS NULL))))) OR (c.business='CANVAS' AND EXISTS
	 (SELECT 1 FROM public.projects p WHERE p.id=c.canvas_project_id AND collaboration.project_role(p.id,c.owner_id) IS NOT NULL AND p.deleted_at IS NULL AND p.internal_kind IS NULL)))
	 AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(m.content) AS part
	 WHERE part->>'type'='TEXT' AND part->>'text' ILIKE $3))),
	 page AS (SELECT * FROM filtered ORDER BY sequence,id LIMIT $4 OFFSET $5), total AS (SELECT count(*) AS n FROM filtered)
	 SELECT total.n,COALESCE(jsonb_agg(to_jsonb(page) ORDER BY page.sequence,page.id) FILTER(WHERE page.id IS NOT NULL),'[]'::jsonb)
	 FROM total LEFT JOIN page ON true GROUP BY total.n`, owner, id, search(q.Keyword), q.Size, q.Offset()).Scan(&total, &raw)
	if err != nil {
		return domain.Page[domain.Message]{}, domain.ErrUnavailable
	}
	var records []messageRecord
	if json.Unmarshal(raw, &records) != nil {
		return domain.Page[domain.Message]{}, domain.ErrUnavailable
	}
	messages := make([]domain.Message, 0, len(records))
	for _, m := range records {
		if m.Sequence < 1 || m.Role != "USER" && m.Role != "ASSISTANT" && m.Role != "TOOL" || domain.ValidateParts(m.Content) != nil {
			return domain.Page[domain.Message]{}, domain.ErrUnavailable
		}
		messages = append(messages, domain.Message{ID: m.ID, ConversationID: m.ConversationID, Sequence: m.Sequence, Role: m.Role, Content: m.Content, CreatedAt: m.CreatedAt})
	}
	return domain.NewPage(q, messages, total), nil
}
func search(keyword string) any {
	if keyword == "" {
		return nil
	}
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(keyword) + "%"
}
func storageError(err error) error {
	if err != nil {
		return domain.ErrUnavailable
	}
	return nil
}

func (r *repository) OwnedHFProject(ctx context.Context, owner, id string) error {
	var found string
	var projectID *string
	err := r.tx.QueryRow(ctx, "SELECT id,project_id FROM resources.studio_projects WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR SHARE", id, owner).Scan(&found, &projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrProjectNotFound
	}
	if err != nil {
		return storageError(err)
	}
	if projectID != nil {
		return r.OwnedProject(ctx, owner, *projectID)
	}
	return nil
}

func (r *repository) ReadProject(ctx context.Context, actor, id string) error {
	_, e := collaboration.RequireProject(ctx, r.tx, actor, id, "VIEWER", false)
	var api *httpapi.Error
	if errors.As(e, &api) && api.Status == 404 {
		return domain.ErrProjectNotFound
	}
	return e
}
