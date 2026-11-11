package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/assistant/application"
	"studiotv.local/service/api/internal/modules/assistant/domain"
)

// Independent operation in the existing table; conversation-create receipts
// and their original public projection are left unchanged.
type messageReceiptResponse struct {
	ID                   string          `json:"id"`
	ConversationID       string          `json:"conversationId"`
	Sequence             int64           `json:"seq"`
	Role                 string          `json:"role"`
	Content              json.RawMessage `json:"content"`
	CreatedAt            time.Time       `json:"createdAt"`
	ConversationRevision int64           `json:"conversationRevision"`
	ExpectedRevision     int64           `json:"expectedRevision"`
}

func (r *repository) FindMessageReceipt(ctx context.Context, owner, operation, key string) (*application.MessageReceipt, error) {
	var hash string
	var status int
	var body []byte
	err := r.tx.QueryRow(ctx, `SELECT request_hash,response_status,response_body FROM public.idempotency_keys
	 WHERE owner_id=$1 AND operation=$2 AND key=$3`, owner, operation, key).Scan(&hash, &status, &body)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, domain.ErrUnavailable
	}
	var stored messageReceiptResponse
	decodedHash, hashErr := hex.DecodeString(hash)
	if status != 201 || hashErr != nil || len(decodedHash) != sha256.Size || json.Unmarshal(body, &stored) != nil || !domain.ValidID(stored.ID) || !domain.ValidID(stored.ConversationID) || stored.Sequence < 1 || stored.Role != "USER" || stored.CreatedAt.IsZero() || stored.ExpectedRevision < 1 || stored.ExpectedRevision == math.MaxInt64 || stored.ConversationRevision != stored.ExpectedRevision+1 || domain.ValidateUserParts(stored.Content) != nil {
		return nil, domain.ErrUnavailable
	}
	message := domain.Message{ID: stored.ID, ConversationID: stored.ConversationID, Sequence: stored.Sequence, Role: stored.Role, Content: stored.Content, CreatedAt: stored.CreatedAt}
	return &application.MessageReceipt{RequestHash: hash, ExpectedRevision: stored.ExpectedRevision, ConversationRevision: stored.ConversationRevision, Message: message}, nil
}

func (r *repository) SaveMessageReceipt(ctx context.Context, owner, operation, key string, receipt application.MessageReceipt) error {
	m := receipt.Message
	body, err := json.Marshal(messageReceiptResponse{ID: m.ID, ConversationID: m.ConversationID, Sequence: m.Sequence, Role: m.Role, Content: m.Content, CreatedAt: m.CreatedAt, ConversationRevision: receipt.ConversationRevision, ExpectedRevision: receipt.ExpectedRevision})
	if err != nil {
		return domain.ErrUnavailable
	}
	_, err = r.tx.Exec(ctx, `INSERT INTO public.idempotency_keys(owner_id,operation,key,request_hash,response_status,response_body)
	 VALUES($1,$2,$3,$4,201,$5)`, owner, operation, key, receipt.RequestHash, body)
	return storageError(err)
}

func (r *repository) Message(ctx context.Context, owner, conversationID, id string) (domain.Message, error) {
	var m domain.Message
	err := r.tx.QueryRow(ctx, `SELECT m.id,m.conversation_id,m.sequence,m.role,m.content,m.created_at
	 FROM assistant.messages m JOIN assistant.conversations c ON c.id=m.conversation_id AND c.owner_id=m.owner_id
	 WHERE m.id=$1 AND m.conversation_id=$2 AND m.owner_id=$3 AND m.deleted_at IS NULL AND c.deleted_at IS NULL
	 AND (c.business='GLOBAL' OR (c.business='HF' AND (c.hf_project_id IS NULL OR EXISTS(SELECT 1 FROM resources.studio_projects h WHERE h.id=c.hf_project_id AND h.owner_id=c.owner_id AND h.deleted_at IS NULL AND (h.project_id IS NULL OR EXISTS(SELECT 1 FROM public.projects hp WHERE hp.id=h.project_id AND hp.owner_id=h.owner_id AND hp.deleted_at IS NULL AND hp.internal_kind IS NULL))))) OR (c.business='CANVAS' AND EXISTS (SELECT 1 FROM public.projects p
	 WHERE p.id=c.canvas_project_id AND collaboration.project_role(p.id,c.owner_id) IS NOT NULL AND p.deleted_at IS NULL AND p.internal_kind IS NULL))) FOR SHARE OF m`, id, conversationID, owner).
		Scan(&m.ID, &m.ConversationID, &m.Sequence, &m.Role, &m.Content, &m.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return m, domain.ErrConversationNotFound
	}
	if err != nil || m.Sequence < 1 || m.Role != "USER" || domain.ValidateUserParts(m.Content) != nil {
		return m, domain.ErrUnavailable
	}
	return m, nil
}

func (r *repository) AppendMessage(ctx context.Context, c domain.Conversation, m domain.Message, expected int64) error {
	if c.ID != m.ConversationID || m.Role != "USER" || c.Revision != expected+1 || c.NextMessageSequence != m.Sequence+1 {
		return domain.ErrUnavailable
	}
	_, err := r.tx.Exec(ctx, `INSERT INTO assistant.messages(id,conversation_id,owner_id,sequence,role,content,created_at)
	 VALUES($1,$2,$3,$4,'USER',$5,$6)`, m.ID, m.ConversationID, c.OwnerID, m.Sequence, m.Content, m.CreatedAt)
	if err != nil {
		return domain.ErrUnavailable
	}
	for _, id := range domain.MessageAssetIDs(m.Content) {
		if _, err = r.tx.Exec(ctx, "INSERT INTO assistant.message_assets(message_id,conversation_id,owner_id,asset_id)VALUES($1,$2,$3,$4)", m.ID, m.ConversationID, c.OwnerID, id); err != nil {
			return domain.ErrUnavailable
		}
	}
	updated, err := r.tx.Exec(ctx, `UPDATE assistant.conversations SET next_message_sequence=$5,revision=$6,updated_at=$7,title=$8,title_generated=$9
	 WHERE id=$1 AND owner_id=$2 AND revision=$3 AND next_message_sequence=$4 AND deleted_at IS NULL`, c.ID, c.OwnerID, expected, m.Sequence, c.NextMessageSequence, c.Revision, c.UpdatedAt, c.Title, c.TitleGenerated)
	if err != nil || updated.RowsAffected() != 1 {
		return domain.ErrUnavailable
	}
	return nil
}

func (r *repository) AuthorizeMessageAssets(ctx context.Context, owner string, ids []string) error {
	for _, id := range ids {
		err := collaboration.RequireAssetProjectRead(ctx, r.tx, owner, id)
		if err != nil {
			var api *httpapi.Error
			if errors.As(err, &api) && api.Status == 404 {
				err = collaboration.RequireAssetGrant(ctx, r.tx, owner, id)
			}
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ErrConversationNotFound
		}
		if err != nil {
			var api *httpapi.Error
			if errors.As(err, &api) && api.Status >= 400 && api.Status < 500 {
				return err
			}
			return domain.ErrUnavailable
		}
	}
	return nil
}

// A browser skill snapshot is never authority. Re-read the owned or imported
// immutable resource under a lock and compare the exact selected revision.
func (r *repository) AuthorizeMessageSkills(ctx context.Context, owner string, content json.RawMessage) error {
	var parts []struct {
		Type       string          `json:"type"`
		SchemaCode string          `json:"schemaCode"`
		Value      json.RawMessage `json:"value"`
	}
	if json.Unmarshal(content, &parts) != nil {
		return domain.ErrInvalid
	}
	for _, p := range parts {
		if p.Type != "STRUCTURED" {
			continue
		}
		if p.SchemaCode != "ASSISTANT_SKILL_V1" {
			return domain.ErrMessagePartsUnavailable
		}
		var selected struct {
			SkillID  string `json:"skillId"`
			Revision int64  `json:"revision"`
			Version  string `json:"version"`
			Markdown string `json:"markdown"`
			Files    []struct {
				Path    string `json:"path"`
				Content string `json:"content"`
			} `json:"files"`
		}
		if json.Unmarshal(p.Value, &selected) != nil {
			return domain.ErrInvalid
		}
		var rev int64
		var version string
		var raw []byte
		err := r.tx.QueryRow(ctx, `SELECT revision,version,content FROM resources.items WHERE id=$1 AND family='SKILL' AND deleted_at IS NULL AND (owner_id=$2 OR scope='SYSTEM') FOR SHARE`, selected.SkillID, owner).Scan(&rev, &version, &raw)
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ErrConversationNotFound
		}
		if err != nil {
			return domain.ErrUnavailable
		}
		if selected.Revision != rev || selected.Version != version {
			return domain.ErrIdempotencyConflict
		}
		var actual struct {
			Markdown string `json:"markdown"`
			Files    []struct {
				Path    string `json:"path"`
				Content string `json:"content"`
			} `json:"files"`
		}
		if json.Unmarshal(raw, &actual) != nil {
			return domain.ErrUnavailable
		}
		// nil and empty files are equivalent; all other content comes from storage.
		if selected.Markdown != actual.Markdown || len(selected.Files) != len(actual.Files) {
			return domain.ErrInvalid
		}
		for i := range actual.Files {
			if selected.Files[i] != actual.Files[i] {
				return domain.ErrInvalid
			}
		}
	}
	return nil
}
