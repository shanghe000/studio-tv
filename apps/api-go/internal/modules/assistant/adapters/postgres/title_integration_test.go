package postgres_test

import (
	"encoding/json"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/modules/assistant/adapters/postgres"
	"studiotv.local/service/api/internal/modules/assistant/application"
	"studiotv.local/service/api/internal/modules/assistant/domain"
)

func TestPostgresAutomaticTitlePersistenceReplaySearchAndRollback(t *testing.T) {
	db, ctx := isolatedDatabase(t)
	if _, err := db.Exec(ctx, `INSERT INTO public.users(id,email,display_name) VALUES('owner-a','titles@example.test','Titles')`); err != nil {
		t.Fatal("title fixture insertion failed")
	}
	router := integrationRouter(t, db)
	for _, fixture := range []struct{ original, text, expected string }{
		{"", "　图形广告\n竖屏故事 ", "图形广告 竖屏故事"},
		{"新对话", "　图形广告\n竖屏故事 ", "图形广告 竖屏故事"},
		{"手动主题", "　图形广告\n竖屏故事 ", "手动主题"},
		{"新对话", "新对话", "新对话"},
	} {
		original := fixture.original
		body, _ := json.Marshal(map[string]string{"kind": "GLOBAL", "title": original})
		creationKey := uuid.NewString()
		created := call(router, "POST", "/api/v2/conversations", "owner-a", string(body), map[string]string{"Idempotency-Key": creationKey})
		assertStatus(t, created, 201)
		id := object(created)["id"].(string)
		path := "/api/v2/conversations/" + id
		key := uuid.NewString()
		messageBody, _ := json.Marshal(map[string]any{"content": []map[string]string{{"type": "TEXT", "text": fixture.text}}})
		appended := call(router, "POST", path+"/messages", "owner-a", string(messageBody), appendHeaders(key, 1))
		assertStatus(t, appended, 201)
		expected := fixture.expected
		assertTitle := func(revision int64) {
			t.Helper()
			detail := call(router, "GET", path, "owner-a", "", nil)
			assertStatus(t, detail, 200)
			if object(detail)["title"] != expected || object(detail)["revision"] != float64(revision) {
				t.Fatal("saved conversation title/revision differs from the append")
			}
		}
		assertTitle(2)
		assertStatus(t, call(router, "POST", path+"/messages", "owner-a", string(messageBody), appendHeaders(key, 1)), 201)
		assertTitle(2)
		assertStatus(t, call(router, "POST", path+"/messages", "owner-a", `{"content":[{"type":"TEXT","text":"后续消息"}]}`, appendHeaders(uuid.NewString(), 2)), 201)
		assertTitle(3)
		listed := call(router, "GET", "/api/v2/conversations?keyword="+url.QueryEscape(expected), "owner-a", "", nil)
		assertStatus(t, listed, 200)
		found := false
		for _, record := range object(listed)["records"].([]any) {
			item := record.(map[string]any)
			found = found || item["id"] == id && item["title"] == expected
		}
		if !found {
			t.Fatal("list/search did not expose the saved title")
		}
		// Creation receipts retain their original projection despite a title
		// change; the saved root remains authoritative for detail and history.
		assertStatus(t, call(router, "POST", "/api/v2/conversations", "owner-a", string(body), map[string]string{"Idempotency-Key": creationKey}), 201)
		assertTitle(3)
	}
	uow, _ := postgres.New(db)
	for _, stage := range []string{"append", "receipt"} {
		created := call(router, "POST", "/api/v2/conversations", "owner-a", `{"kind":"GLOBAL","title":"新对话"}`, map[string]string{"Idempotency-Key": uuid.NewString()})
		assertStatus(t, created, 201)
		id := object(created)["id"].(string)
		service, _ := application.New(failingMessageUOW{uow, stage})
		_, err := service.AppendMessage(ctx, domain.VerifiedActor{OwnerID: "owner-a"}, id, application.AppendMessageCommand{Content: json.RawMessage(`[{"type":"TEXT","text":"未提交标题"}]`), ExpectedRevision: 1, IdempotencyKey: uuid.NewString()})
		if err == nil {
			t.Fatal("forced rollback succeeded")
		}
		detail := call(router, "GET", "/api/v2/conversations/"+id, "owner-a", "", nil)
		assertStatus(t, detail, 200)
		if object(detail)["title"] != "新对话" || object(detail)["revision"] != float64(1) {
			t.Fatal("failed append committed its title")
		}
	}
}

func TestPostgresLegacyTitleMigrationUsesFirstVisibleUserText(t *testing.T) {
	db, ctx := isolatedDatabase(t)
	// Restore only this isolated database's pre-013 schema, then exercise the
	// real migration runner against old history rather than a copied SQL query.
	if _, err := db.Exec(ctx, `ALTER TABLE assistant.conversations DROP COLUMN title_generated;
	 DELETE FROM schema_migrations WHERE name='013_assistant_titles.sql';
	 INSERT INTO public.users(id,email,display_name) VALUES('owner-a','legacy-titles@example.test','Legacy Titles')`); err != nil {
		t.Fatal("legacy schema fixture failed")
	}
	at := time.Now().UTC().Truncate(time.Millisecond)
	long := strings.Repeat("🦊", 40)
	fixtures := []struct{ id, original, expected, text string }{
		{"legacy-title", "新对话", "图形 广告 竖屏", "　图形\u2003广告\n竖屏\u0001"},
		{"blank-title", "　\t", strings.Repeat("🦊", 31) + "…", long},
		{"custom-title", "用户的标题", "用户的标题", "不应覆盖标题"},
		{"empty-title", "新对话", "新对话", ""},
		{"placeholder-first-text", "新对话", "新对话", "新对话"},
		{"deleted-title", "新对话", "新对话", "已删除会话"},
	}
	for _, fixture := range fixtures {
		var deletedAt *time.Time
		if fixture.id == "deleted-title" {
			deletedAt = &at
		}
		if _, err := db.Exec(ctx, `INSERT INTO assistant.conversations(id,owner_id,business,title,revision,next_message_sequence,updated_at,deleted_at) VALUES($1,'owner-a','GLOBAL',$2,5,5,$3,$4)`, fixture.id, fixture.original, at, deletedAt); err != nil {
			t.Fatal("legacy conversation insertion failed")
		}
		if fixture.text == "" {
			continue
		}
		// Skip assistant output, deleted user text and an attachment-only turn
		// before the first effective text, preserving exact part order.
		if _, err := db.Exec(ctx, `INSERT INTO assistant.messages(id,conversation_id,owner_id,sequence,role,content,deleted_at) VALUES
		 ($1||'-assistant',$1,'owner-a',1,'ASSISTANT','[{"type":"TEXT","text":"不使用助手文字"}]',NULL),
		 ($1||'-deleted',$1,'owner-a',2,'USER','[{"type":"TEXT","text":"不使用已删文字"}]',$2),
		 ($1||'-asset',$1,'owner-a',3,'USER','[{"type":"ASSET","assetId":"private-asset-id"}]',NULL)`, fixture.id, at); err != nil {
			t.Fatal("legacy history insertion failed")
		}
		var parts json.RawMessage
		if fixture.id == "legacy-title" {
			parts = json.RawMessage(`[{"type":"TEXT","text":"　图形\u2003广告\n"},{"type":"TEXT","text":"竖屏\u0001"}]`)
		} else {
			parts, _ = json.Marshal([]map[string]string{{"type": "TEXT", "text": fixture.text}})
		}
		if _, err := db.Exec(ctx, `INSERT INTO assistant.messages(id,conversation_id,owner_id,sequence,role,content) VALUES($1||'-text',$1,'owner-a',4,'USER',$2)`, fixture.id, parts); err != nil {
			t.Fatal("legacy text insertion failed")
		}
	}
	if err := database.Migrate(ctx, db); err != nil {
		t.Fatal("legacy title migration failed")
	}
	for _, fixture := range fixtures {
		var title string
		var generated bool
		var revision int64
		var updatedAt time.Time
		if err := db.QueryRow(ctx, `SELECT title,title_generated,revision,updated_at FROM assistant.conversations WHERE id=$1`, fixture.id).Scan(&title, &generated, &revision, &updatedAt); err != nil {
			t.Fatal("migrated title read failed")
		}
		changed := domain.IsPlaceholderTitle(fixture.original) && fixture.text != "" && fixture.id != "deleted-title"
		expectedRevision := int64(5)
		if changed {
			expectedRevision++
		}
		if title != fixture.expected || generated != changed || revision != expectedRevision || !updatedAt.Equal(at) {
			t.Fatalf("migration produced incorrect title/state for %s", fixture.id)
		}
	}
	if err := database.Migrate(ctx, db); err != nil {
		t.Fatal("second migration run failed")
	}
}
