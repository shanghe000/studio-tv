package postgres_test

import (
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/execution/domain"
	mediaPG "studiotv.local/service/api/internal/modules/modelmedia/adapters/postgres"
	media "studiotv.local/service/api/internal/modules/modelmedia/application"
	"strings"
	"testing"
	"time"
)

func TestPostgresModelReadGrantRequiresFreshSourceTeamGrant(t *testing.T) {
	f := newHistoryInputFixture(t)
	if _, e := f.pool.Exec(f.ctx, `UPDATE public.assets SET storage_key=id WHERE id='input-old-image';
 INSERT INTO collaboration.teams(id,owner_id,name) VALUES('media-team','input-owner','Media');
 INSERT INTO collaboration.team_members(team_id,user_id,role,created_by) VALUES('media-team','input-other','VIEWER','input-owner');
 INSERT INTO collaboration.team_entries(id,team_id,name,kind,source_kind,source_id,source_version,source_owner_id,content,created_by,updated_by) VALUES('media-entry','media-team','Image','ASSET','ASSET','input-old-image','v1','input-owner','{}','input-owner','input-owner');
 INSERT INTO collaboration.team_asset_refs(entry_id,team_id,asset_id,asset_owner_id,sort_order) VALUES('media-entry','media-team','input-old-image','input-owner',0);
 INSERT INTO assistant.conversations(id,owner_id,business,title) VALUES('media-conversation','input-other','GLOBAL','QA only');
 INSERT INTO assistant.messages(id,conversation_id,owner_id,sequence,role,content) VALUES('media-message','media-conversation','input-other',1,'USER','[{"type":"TEXT","text":"QA"}]');
 UPDATE assistant.conversations SET next_message_sequence=2,revision=revision+1 WHERE id='media-conversation'`); e != nil {
		t.Fatal(e)
	}
	cid, mid := "media-conversation", "media-message"
	now := time.Now().UTC()
	task := domain.Task{ID: "task-" + uuid.NewString(), OwnerID: "input-other", InitiatedBy: "input-other", Kind: "ASSISTANT", ConversationID: &cid, ConversationRevision: 2, MessageID: &mid, TargetType: "CONVERSATION", TargetID: cid, State: "QUEUED", Revision: 1, CreatedAt: now, UpdatedAt: now, Plans: []domain.Plan{{NodeID: cid, ExecutionID: "exe-" + uuid.NewString(), State: "QUEUED", Request: json.RawMessage(`{}`)}}}
	checksum := strings.Repeat("a", 64)
	grant := execution.Grant{ID: "grant-" + uuid.NewString(), AssetID: "input-old-image", Version: "sha256:" + checksum, SHA256: checksum}
	if _, e := f.store.Create(f.ctx, task, uuid.NewString(), strings.Repeat("b", 64), []execution.Grant{grant}); e != nil {
		t.Fatal(e)
	}
	resolver := mediaPG.New(f.pool, f.store)
	req := media.Request{SubjectRef: "input-other", SourceRef: grant.AssetID, SourceVersion: grant.Version, SHA256: checksum, ReadGrantRef: grant.ID}
	if _, e := resolver.Resolve(f.ctx, req); e != nil {
		t.Fatal("active TEAM grant unavailable", e)
	}
	if _, e := f.pool.Exec(f.ctx, `UPDATE public.projects SET deleted_at=now() WHERE id='input-media-project'`); e != nil {
		t.Fatal(e)
	}
	if _, e := resolver.Resolve(f.ctx, req); e != nil {
		t.Fatal("active TEAM publication not retained", e)
	}
	if _, e := f.pool.Exec(f.ctx, `DELETE FROM collaboration.team_members WHERE team_id='media-team' AND user_id='input-other'`); e != nil {
		t.Fatal(e)
	}
	if _, e := resolver.Resolve(f.ctx, req); !errors.Is(e, media.ErrNotFound) {
		t.Fatal("read grant survived source membership revoke", e)
	}
	if _, e := f.pool.Exec(f.ctx, `INSERT INTO collaboration.team_members(team_id,user_id,role,created_by) VALUES('media-team','input-other','VIEWER','input-owner');UPDATE collaboration.team_entries SET deleted_at=now(),revision=revision+1 WHERE id='media-entry'`); e != nil {
		t.Fatal(e)
	}
	if _, e := resolver.Resolve(f.ctx, req); !errors.Is(e, media.ErrNotFound) {
		t.Fatal("read grant survived unpublish", e)
	}
}
