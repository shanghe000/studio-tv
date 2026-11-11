package postgres

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	assistant "studiotv.local/service/api/internal/modules/assistant/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"studiotv.local/service/api/internal/modules/studioassistant/application"
	"strings"
)

type Store struct{ pool *pgxpool.Pool }

func New(p *pgxpool.Pool) (*Store, error) {
	if p == nil {
		return nil, errors.New("HF store pool required")
	}
	return &Store{p}, nil
}
func active(ctx context.Context, tx pgx.Tx, owner, cid string) (int64, error) {
	var revision int64
	e := tx.QueryRow(ctx, `SELECT c.revision FROM assistant.conversations c WHERE c.id=$1 AND c.owner_id=$2 AND c.business='HF' AND c.deleted_at IS NULL AND(c.hf_project_id IS NULL OR EXISTS(SELECT 1 FROM resources.studio_projects h WHERE h.id=c.hf_project_id AND h.owner_id=c.owner_id AND h.deleted_at IS NULL)) FOR UPDATE`, cid, owner).Scan(&revision)
	if errors.Is(e, pgx.ErrNoRows) {
		return 0, assistant.ErrConversationNotFound
	}
	if e != nil {
		return 0, assistant.ErrUnavailable
	}
	return revision, nil
}
func (s *Store) Agent(ctx context.Context, owner, cid, key string) (string, error) {
	tx, e := s.pool.Begin(ctx)
	if e != nil {
		return "", assistant.ErrUnavailable
	}
	defer tx.Rollback(ctx)
	if _, e = active(ctx, tx, owner, cid); e != nil {
		return "", e
	}
	id := "hfa_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	e = tx.QueryRow(ctx, `INSERT INTO assistant.hf_agents(id,conversation_id,owner_id)VALUES($1,$2,$3) ON CONFLICT(conversation_id,owner_id) DO UPDATE SET conversation_id=EXCLUDED.conversation_id RETURNING id`, id, cid, owner).Scan(&id)
	if e != nil {
		return "", assistant.ErrUnavailable
	}
	return id, tx.Commit(ctx)
}
func (s *Store) Reserve(ctx context.Context, owner, cid, key, hash string, cmd application.Command, cap gateway.Capability) (application.Reservation, error) {
	var out application.Reservation
	tx, e := s.pool.Begin(ctx)
	if e != nil {
		return out, assistant.ErrUnavailable
	}
	defer tx.Rollback(ctx)
	revision, e := active(ctx, tx, owner, cid)
	if e != nil {
		return out, e
	}
	var agent string
	e = tx.QueryRow(ctx, "SELECT id FROM assistant.hf_agents WHERE id=$1 AND conversation_id=$2 AND owner_id=$3", cmd.AgentID, cid, owner).Scan(&agent)
	if errors.Is(e, pgx.ErrNoRows) {
		return out, assistant.ErrConversationNotFound
	}
	if e != nil {
		return out, assistant.ErrUnavailable
	}
	var oldHash string
	e = tx.QueryRow(ctx, `SELECT request_hash,expected_revision,capability_ref,capability_version FROM assistant.hf_commands WHERE owner_id=$1 AND conversation_id=$2 AND idempotency_key=$3`, owner, cid, key).Scan(&oldHash, &out.Revision, &out.CapabilityRef, &out.CapabilityVersion)
	if e == nil {
		if oldHash != hash {
			return out, assistant.ErrIdempotencyConflict
		}
		return out, tx.Commit(ctx)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return out, assistant.ErrUnavailable
	}
	out = application.Reservation{Revision: revision, CapabilityRef: cap.Ref, CapabilityVersion: cap.Version}
	_, e = tx.Exec(ctx, `INSERT INTO assistant.hf_commands(owner_id,conversation_id,idempotency_key,request_hash,expected_revision,capability_ref,capability_version)VALUES($1,$2,$3,$4,$5,$6,$7)`, owner, cid, key, hash, out.Revision, out.CapabilityRef, out.CapabilityVersion)
	if e != nil {
		return out, assistant.ErrUnavailable
	}
	return out, tx.Commit(ctx)
}
