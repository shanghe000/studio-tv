package postgres_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"path/filepath"
	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/core"
	"studiotv.local/service/api/internal/database"
	assistantPG "studiotv.local/service/api/internal/modules/assistant/adapters/postgres"
	assistant "studiotv.local/service/api/internal/modules/assistant/application"
	assistantDomain "studiotv.local/service/api/internal/modules/assistant/domain"
	executionPG "studiotv.local/service/api/internal/modules/execution/adapters/postgres"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/modules/modelgateway/adapters/router"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"studiotv.local/service/api/internal/testdb"
	"strings"
	"sync"
	"testing"
	"time"
)

// The hook runs after the real SQL context read and before real Create. It
// deterministically exercises an interleaving without a provider fixture.
type afterConversationStore struct {
	execution.Store
	after func(context.Context, execution.ConversationInput) error
}

// Only the acceptance-side catalog gains synthetic model metadata so the real
// PostgreSQL worker and Router HTTP contract exercise a new private epoch. The
// upstream capability and every returned output remain explicitly MOCK.
type epochMockCatalog struct{ gateway.ExecutionGateway }

func (g epochMockCatalog) Capabilities(ctx context.Context, actor gateway.Actor, q gateway.CapabilityQuery) (gateway.CapabilityPage, error) {
	page, err := g.ExecutionGateway.Capabilities(ctx, actor, q)
	for i := range page.Items {
		if page.Items[i].Ref == "mock-llm" {
			page.Items[i].Model = &gateway.ModelDescriptor{ProviderRef: "fixture-supplier", ModelRef: "fixture-model", Title: "MOCK epoch contract fixture", Version: "1"}
		}
	}
	return page, err
}

func (s *afterConversationStore) Conversation(ctx context.Context, owner, cid, mid string) (execution.ConversationInput, error) {
	in, err := s.Store.Conversation(ctx, owner, cid, mid)
	if err == nil && s.after != nil {
		fn := s.after
		s.after = nil
		err = fn(ctx, in)
	}
	return in, err
}

func TestPostgresAssistantContextRevisionAndHFParentCreationBoundary(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" || os.Getenv("TEST_MODELS_ROUTER_MOCK_BASE_URL") == "" {
		t.Skip("explicit isolated PostgreSQL and actual mock Router catalog required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testdb.New(t).Open(t)
	if err := database.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	read := func(key string) string {
		if path := os.Getenv(key + "_FILE"); path != "" {
			value, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			return strings.TrimSpace(string(value))
		}
		return os.Getenv(key)
	}
	signing, err := base64.StdEncoding.DecodeString(read("TEST_MODELS_ROUTER_SIGNING_KEY_B64"))
	if err != nil {
		t.Fatal(err)
	}
	client, err := router.New(router.Config{BaseURL: os.Getenv("TEST_MODELS_ROUTER_MOCK_BASE_URL"), ClientApp: os.Getenv("TEST_MODELS_ROUTER_CLIENT_APP"), ServiceToken: read("TEST_MODELS_ROUTER_TOKEN"), SigningKey: signing})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO public.users(id,email,display_name) VALUES('race-owner','context-race@example.test','Context race');
	 INSERT INTO public.projects(id,owner_id,name) VALUES('hf-race-parent','race-owner','HF parent');
	 INSERT INTO resources.studio_projects(id,owner_id,project_id,title) VALUES('hf-race','race-owner','hf-race-parent','HF race')`); err != nil {
		t.Fatal(err)
	}
	uow, _ := assistantPG.New(pool)
	history, _ := assistant.New(uow)
	actor := assistantDomain.VerifiedActor{OwnerID: "race-owner"}
	create := func(kind assistantDomain.Kind, hf *string) assistantDomain.Conversation {
		t.Helper()
		body := map[string]any{"kind": string(kind), "title": "Context revision"}
		if hf != nil {
			body["hfProjectId"] = *hf
		}
		hash, _ := assistant.CreationHash(body)
		c, e := history.Create(ctx, actor, assistant.CreateCommand{Input: assistantDomain.Create{Kind: kind, HFProjectID: hf, Title: "Context revision"}, IdempotencyKey: uuid.NewString(), RequestHash: hash})
		if e != nil {
			t.Fatal(e)
		}
		return c
	}
	appendUser := func(cid, text string, revision int64) assistant.AppendMessageResult {
		t.Helper()
		parts, _ := json.Marshal([]any{map[string]string{"type": "TEXT", "text": text}})
		m, e := history.AppendMessage(ctx, actor, cid, assistant.AppendMessageCommand{Content: parts, ExpectedRevision: revision, IdempotencyKey: uuid.NewString()})
		if e != nil {
			t.Fatal(e)
		}
		return m
	}
	store, _ := executionPG.New(pool)
	importer, err := core.NewProductAssetStore(config.Config{StorageRoot: t.TempDir(), MaxUploadBytes: 512 << 20, FFprobePath: "ffprobe", SigningSecret: strings.Repeat("s", 32), PublicBaseURL: "http://localhost", Issuer: "qa", Audience: "qa"}, pool)
	if err != nil {
		t.Fatal(err)
	}
	conversation := create(assistantDomain.Global, nil)
	old := appendUser(conversation.ID, "deleted-context-secret", 1)
	current := appendUser(conversation.ID, "current question", 2)
	hook := &afterConversationStore{Store: store, after: func(ctx context.Context, in execution.ConversationInput) error {
		if in.Revision != 3 || !strings.Contains(string(in.Context), "deleted-context-secret") {
			return errors.New("real preflight did not capture old revision/context")
		}
		_, e := history.DeleteMessage(ctx, actor, conversation.ID, old.Message.ID, true, assistant.MessageDeletionCommand{ExpectedRevision: in.Revision, IdempotencyKey: uuid.NewString()})
		return e
	}}
	service, _ := execution.New(hook, client, importer)
	key := uuid.NewString()
	command := execution.AssistantCommand{CapabilityRef: "mock-llm", CapabilityVersion: "1", MessageID: current.Message.ID, Parameters: json.RawMessage(`{}`)}
	if _, err = service.Assistant(ctx, actor.OwnerID, conversation.ID, key, command); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("context deleted after preflight did not reject new task409: %v", err)
	}
	var tasks int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM execution.tasks WHERE conversation_id=$1`, conversation.ID).Scan(&tasks); err != nil || tasks != 0 {
		t.Fatal("stale context rejection committed a task/receipt")
	}
	// The failed UUID remains reusable, and a new preflight excludes deletion.
	fresh, _ := execution.New(store, client, importer)
	accepted, err := fresh.Assistant(ctx, actor.OwnerID, conversation.ID, key, command)
	if err != nil {
		t.Fatal(err)
	}
	var request gateway.InvocationRequest
	if json.Unmarshal(accepted.Plans[0].Request, &request) != nil || strings.Contains(string(request.ContextSnapshot), "deleted-context-secret") || !strings.Contains(string(request.ContextSnapshot), "current question") {
		t.Fatal("retried real task context retained a deleted message")
	}
	if _, err = pool.Exec(ctx, `UPDATE assistant.conversations SET revision=revision+1 WHERE id=$1`, conversation.ID); err != nil {
		t.Fatal(err)
	}
	replayed, err := fresh.Assistant(ctx, actor.OwnerID, conversation.ID, key, command)
	if err != nil || replayed.ID != accepted.ID {
		t.Fatal("later root revision broke an existing valid receipt replay", err)
	}
	// No worker/Submit is started. The actual Router is only queried for its
	// declared mock capability; all concurrency evidence above is real SQL.
	hfID := "hf-race"
	hf := create(assistantDomain.HF, &hfID)
	hfMessage := appendUser(hf.ID, "HF question", 1)
	hfHook := &afterConversationStore{Store: store, after: func(ctx context.Context, in execution.ConversationInput) error {
		_, e := pool.Exec(ctx, `UPDATE public.projects SET deleted_at=now() WHERE id='hf-race-parent'`)
		return e
	}}
	hfService, _ := execution.New(hfHook, client, importer)
	command.MessageID = hfMessage.Message.ID
	if _, err = hfService.Assistant(ctx, actor.OwnerID, hf.ID, uuid.NewString(), command); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("HF underlying parent deleted after preflight did not reject creation404: %v", err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM execution.tasks WHERE conversation_id=$1`, hf.ID).Scan(&tasks); err != nil || tasks != 0 {
		t.Fatal("deleted HF underlying parent still committed a task")
	}
}

func TestPostgresProductExecutionRouterMockAndPrivateHistory(t *testing.T) {
	dsn, origin := os.Getenv("TEST_DATABASE_URL"), os.Getenv("TEST_MODELS_ROUTER_MOCK_BASE_URL")
	if dsn == "" || origin == "" {
		t.Skip("explicit isolated PostgreSQL and mock Router required")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err = database.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	lock, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err = lock.Exec(ctx, "SELECT pg_advisory_lock(2106768132243)"); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, "SELECT pg_advisory_unlock(2106768132243)")
	read := func(key string) string {
		if p := os.Getenv(key + "_FILE"); p != "" {
			b, e := os.ReadFile(p)
			if e != nil {
				t.Fatal(e)
			}
			return strings.TrimSpace(string(b))
		}
		return os.Getenv(key)
	}
	signing, err := base64.StdEncoding.DecodeString(read("TEST_MODELS_ROUTER_SIGNING_KEY_B64"))
	if err != nil {
		t.Fatal(err)
	}
	client, err := router.New(router.Config{BaseURL: origin, ClientApp: os.Getenv("TEST_MODELS_ROUTER_CLIENT_APP"), ServiceToken: read("TEST_MODELS_ROUTER_TOKEN"), SigningKey: signing})
	if err != nil {
		t.Fatal(err)
	}
	owner := "usr_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	other := "usr_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	project := "prj_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	for _, id := range []string{owner, other} {
		if _, err = pool.Exec(ctx, "INSERT INTO public.users(id,email,password_hash,display_name)VALUES($1,$2,'','QA')", id, id+"@invalid.test"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = pool.Exec(ctx, "INSERT INTO public.projects(id,owner_id,name)VALUES($1,$2,'explicit MOCK integration QA')", project, owner); err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{StorageRoot: t.TempDir(), MaxUploadBytes: 512 << 20, FFprobePath: "ffprobe", SigningSecret: strings.Repeat("s", 32), PublicBaseURL: "http://localhost", Issuer: "qa", Audience: "qa"}
	importer, err := core.NewProductAssetStore(cfg, pool)
	if err != nil {
		t.Fatal(err)
	}
	store, err := executionPG.New(pool)
	if err != nil {
		t.Fatal(err)
	}
	service, err := execution.New(store, client, importer)
	if err != nil {
		t.Fatal(err)
	}
	work, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); service.Run(work) }()
	defer func() { stop(); <-done }()
	wait := func(t *testing.T, id string) domain.Task {
		t.Helper()
		deadline := time.Now().Add(25 * time.Second)
		var last domain.Task
		for time.Now().Before(deadline) {
			job, e := service.Get(ctx, owner, id)
			if e != nil {
				t.Fatal(e)
			}
			if domain.Terminal(job.State) {
				return job
			}
			last = job
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("task %s did not finish: state=%s revision=%d updated=%s code=%s", id, last.State, last.Revision, last.UpdatedAt.Format(time.RFC3339Nano), codeValue(last.ErrorCode))
		return domain.Task{}
	}
	graph := func(ref string, params map[string]any) domain.CanvasCommand {
		body, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"id": "model", "type": "rh-image", "data": map[string]any{"capabilityRef": ref, "prompt": "explicit MOCK integration test", "routerParameters": params}}}, "edges": []any{}})
		return domain.CanvasCommand{ProjectID: project, TargetType: "NODE", TargetID: "model", Graph: body}
	}
	catalog, err := client.Capabilities(ctx, gateway.Actor{SubjectRef: owner}, gateway.CapabilityQuery{Limit: 100})
	if err != nil || len(catalog.Items) != 20 {
		t.Fatalf("catalog %d %v", len(catalog.Items), err)
	}
	var first domain.Task
	for _, cap := range catalog.Items {
		t.Run(cap.Kind, func(t *testing.T) {
			if !cap.TestMode {
				t.Fatal("catalog not marked test")
			}
			key := uuid.NewString()
			cmd := graph(cap.Ref, map[string]any{"delayMilliseconds": 0})
			job, e := service.Canvas(ctx, owner, key, cmd)
			if e != nil {
				t.Fatal(e)
			}
			again, e := service.Canvas(ctx, owner, key, cmd)
			if e != nil || again.ID != job.ID {
				t.Fatalf("receipt lost %v", e)
			}
			var request gateway.InvocationRequest
			if e = json.Unmarshal(job.Plans[0].Request, &request); e != nil {
				t.Fatal(e)
			}
			receipt, e := client.Submit(ctx, gateway.Actor{SubjectRef: owner}, gateway.Submission{IdempotencyKey: uuid.NewSHA1(uuid.NameSpaceOID, []byte(job.Plans[0].ExecutionID)).String(), Request: request})
			if e != nil {
				t.Fatalf("actual Router submit rejected STUDIO request: %v", e)
			}
			if receipt.Ref == "" {
				t.Fatal("empty Router receipt")
			}
			job = wait(t, job.ID)
			if job.State != "SUCCEEDED" || !job.TestMode || len(job.Plans) != 1 || len(job.Plans[0].Outputs) == 0 {
				t.Fatalf("job state=%s code=%v plans=%d", job.State, codeValue(job.ErrorCode), len(job.Plans))
			}
			if first.ID == "" {
				first = job
			}
			for _, out := range job.Plans[0].Outputs {
				if !out.TestMode {
					t.Fatal("result not test marked")
				}
				if out.AssetID != nil {
					assets, e := importer.Read(ctx, owner, []string{*out.AssetID})
					if e != nil || len(assets) != 1 {
						t.Fatalf("output not durable %v", e)
					}
					info, e := os.Stat(filepath.Join(cfg.StorageRoot, *out.AssetID))
					if e != nil || info.Size() != assets[0].ByteSize {
						t.Fatal("output bytes missing")
					}
				}
			}
			var metadata map[string]any
			if json.Unmarshal(job.Metadata, &metadata) != nil || metadata["usage"] != nil || metadata["context"] != nil {
				t.Fatal("mock manufactured usage/context")
			}
		})
	}
	t.Run("group_dag_binds_fresh_upstream_assets", func(t *testing.T) {
		graphBytes, _ := json.Marshal(map[string]any{"nodes": []any{
			map[string]any{"id": "group", "type": "group", "data": map[string]any{}},
			map[string]any{"id": "image", "type": "rh-image", "parentId": "group", "data": map[string]any{"capabilityRef": "mock-text-to-image", "prompt": "fresh MOCK input"}},
			map[string]any{"id": "video", "type": "rh-video", "parentId": "group", "data": map[string]any{"capabilityRef": "mock-image-to-video", "prompt": "animate fresh upstream"}},
			map[string]any{"id": "outside", "type": "rh-text", "data": map[string]any{"capabilityRef": "mock-llm", "prompt": "must not execute outside selected group"}},
		}, "edges": []any{map[string]string{"source": "image", "target": "video"}}})
		job, e := service.Canvas(ctx, owner, uuid.NewString(), domain.CanvasCommand{ProjectID: project, TargetType: "GROUP", TargetID: "group", Graph: graphBytes})
		if e != nil {
			t.Fatal(e)
		}
		job = wait(t, job.ID)
		if job.State != "SUCCEEDED" || len(job.Plans) != 2 || job.Plans[0].NodeID != "image" || job.Plans[1].NodeID != "video" {
			t.Fatalf("DAG state=%s plans=%d", job.State, len(job.Plans))
		}
		var downstream gateway.InvocationRequest
		if json.Unmarshal(job.Plans[1].Request, &downstream) != nil || len(downstream.Attachments) != 1 || len(job.Plans[0].Outputs) < 1 || job.Plans[0].Outputs[0].AssetID == nil || downstream.Attachments[0].SourceRef != *job.Plans[0].Outputs[0].AssetID {
			t.Fatal("downstream did not consume fresh persisted upstream image")
		}
		media := false
		for _, part := range downstream.Input {
			if part.Type == "MEDIA" && part.AttachmentRef != nil && *part.AttachmentRef == downstream.Attachments[0].Ref {
				media = true
			}
		}
		if !media {
			t.Fatal("upstream grant not referenced by canonical input")
		}
	})
	t.Run("cross_owner_and_history_restore", func(t *testing.T) {
		if _, err = service.Get(ctx, other, first.ID); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("foreign get %v", err)
		}
		if _, err = service.Cancel(ctx, other, first.ID); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("foreign cancel %v", err)
		}
		if _, err = service.Events(ctx, other, first.ID, 0); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("foreign events %v", err)
		}
		history, e := service.History(ctx, owner, execution.HistoryQuery{ProjectID: project, Page: 1, Size: 100})
		if e != nil || history.Total != 22 || len(history.Records) != 22 {
			t.Fatalf("history total %d/%d %v", history.Total, len(history.Records), e)
		}
		fresh, _ := executionPG.New(pool)
		restored, e := fresh.Get(ctx, owner, first.ID)
		if e != nil || restored.Plans[0].Outputs[0].ID != first.Plans[0].Outputs[0].ID {
			t.Fatalf("restore %v", e)
		}
	})
	t.Run("concurrent_receipt_and_conflict", func(t *testing.T) {
		key := uuid.NewString()
		cmd := graph("mock-llm", map[string]any{})
		ids := make(chan string, 12)
		errs := make(chan error, 12)
		var group sync.WaitGroup
		for i := 0; i < 12; i++ {
			group.Add(1)
			go func() { defer group.Done(); j, e := service.Canvas(ctx, owner, key, cmd); ids <- j.ID; errs <- e }()
		}
		group.Wait()
		close(ids)
		close(errs)
		one := ""
		for e := range errs {
			if e != nil {
				t.Fatal(e)
			}
		}
		for id := range ids {
			if one == "" {
				one = id
			}
			if id != one {
				t.Fatal("concurrent duplicate tasks")
			}
		}
		_ = wait(t, one)
		changed := graph("mock-llm", map[string]any{"count": 2})
		if _, e := service.Canvas(ctx, owner, key, changed); !errors.Is(e, domain.ErrConflict) {
			t.Fatalf("key payload mismatch %v", e)
		}
	})
	t.Run("private_multiturn_assistant", func(t *testing.T) {
		uow, _ := assistantPG.New(pool)
		history, _ := assistant.New(uow)
		actor := assistantDomain.VerifiedActor{OwnerID: owner}
		body := map[string]any{"kind": "GLOBAL", "title": "QA conversation"}
		hash, _ := assistant.CreationHash(body)
		conversation, e := history.Create(ctx, actor, assistant.CreateCommand{Input: assistantDomain.Create{Kind: assistantDomain.Global, Title: "QA conversation"}, IdempotencyKey: uuid.NewString(), RequestHash: hash})
		if e != nil {
			t.Fatal(e)
		}
		for turn := 0; turn < 2; turn++ {
			current, e := history.Detail(ctx, actor, conversation.ID)
			if e != nil {
				t.Fatal(e)
			}
			content := json.RawMessage(`[{"type":"TEXT","text":"explicit MOCK multi-turn"}]`)
			if turn == 0 {
				var assetID string
				if e = pool.QueryRow(ctx, "SELECT a.id FROM public.assets a WHERE a.owner_id=$1 AND a.kind='IMAGE' AND a.state='READY' AND a.deleted_at IS NULL ORDER BY created_at LIMIT 1", owner).Scan(&assetID); e != nil {
					t.Fatal(e)
				}
				content, _ = json.Marshal([]any{map[string]string{"type": "TEXT", "text": "explicit MOCK multi-turn with historical image"}, map[string]string{"type": "ASSET", "assetId": assetID}})
			}
			msg, e := history.AppendMessage(ctx, actor, conversation.ID, assistant.AppendMessageCommand{Content: content, ExpectedRevision: current.Revision, IdempotencyKey: uuid.NewString()})
			if e != nil {
				t.Fatal(e)
			}
			run, e := service.Assistant(ctx, owner, conversation.ID, uuid.NewString(), execution.AssistantCommand{CapabilityRef: "mock-llm", CapabilityVersion: "1", MessageID: msg.Message.ID, Parameters: json.RawMessage(`{}`)})
			if e != nil {
				t.Fatal(e)
			}
			result := wait(t, run.ID)
			if result.State != "SUCCEEDED" {
				t.Fatalf("assistant %#v", result)
			}
			events, e := service.Events(ctx, owner, run.ID, 0)
			if e != nil || !events.Terminal || len(events.Items) < 3 {
				t.Fatalf("events %#v %v", events, e)
			}
		}
		rows, e := history.Messages(ctx, actor, conversation.ID, assistantDomain.PageQuery{Page: 1, Size: 100})
		if e != nil || len(rows.Records) != 4 || rows.Records[1].Role != "ASSISTANT" || rows.Records[3].Role != "ASSISTANT" {
			t.Fatalf("history %#v %v", rows, e)
		}
		if _, e = history.Detail(ctx, assistantDomain.VerifiedActor{OwnerID: other}, conversation.ID); !errors.Is(e, assistantDomain.ErrConversationNotFound) {
			t.Fatalf("foreign assistant %v", e)
		}
	})
	t.Run("model_epoch_matches_actual_router_session_correlation", func(t *testing.T) {
		uow, _ := assistantPG.New(pool)
		history, _ := assistant.New(uow)
		actor := assistantDomain.VerifiedActor{OwnerID: owner}
		hash, _ := assistant.CreationHash(map[string]any{"kind": "GLOBAL", "title": "MOCK model epoch HTTP contract"})
		conversation, e := history.Create(ctx, actor, assistant.CreateCommand{Input: assistantDomain.Create{Kind: assistantDomain.Global, Title: "MOCK model epoch HTTP contract"}, IdempotencyKey: uuid.NewString(), RequestHash: hash})
		if e != nil {
			t.Fatal(e)
		}
		acceptance, e := execution.New(store, epochMockCatalog{client}, importer)
		if e != nil {
			t.Fatal(e)
		}
		var epoch, sessionRef string
		for turn := 0; turn < 2; turn++ {
			current, e := history.Detail(ctx, actor, conversation.ID)
			if e != nil {
				t.Fatal(e)
			}
			message, e := history.AppendMessage(ctx, actor, conversation.ID, assistant.AppendMessageCommand{Content: json.RawMessage(`[{"type":"TEXT","text":"explicit MOCK session epoch fixture"}]`), ExpectedRevision: current.Revision, IdempotencyKey: uuid.NewString()})
			if e != nil {
				t.Fatal(e)
			}
			key := uuid.NewString()
			cmd := execution.AssistantCommand{CapabilityRef: "mock-llm", CapabilityVersion: "1", MessageID: message.Message.ID, Parameters: json.RawMessage(`{}`)}
			accepted, e := acceptance.Assistant(ctx, owner, conversation.ID, key, cmd)
			if e != nil {
				t.Fatal(e)
			}
			var frozen gateway.InvocationRequest
			if json.Unmarshal(accepted.Plans[0].Request, &frozen) != nil || frozen.Correlation == nil || frozen.Correlation.ConversationRef != accepted.Plans[0].RouterConversationRef || frozen.Correlation.ConversationRef == conversation.ID || accepted.ConversationID == nil || *accepted.ConversationID != conversation.ID {
				t.Fatal("acceptance did not freeze the session epoch while retaining the product conversation")
			}
			if turn == 0 {
				epoch = accepted.Plans[0].RouterConversationRef
			} else if accepted.Plans[0].RouterConversationRef != epoch {
				t.Fatal("continuous model choice failed to reuse the successful epoch")
			}
			result := wait(t, accepted.ID)
			if result.State != "SUCCEEDED" || !result.TestMode || result.Plans[0].InvocationRef == nil {
				t.Fatalf("actual Router HTTP rejected the model epoch: state=%s error=%v", result.State, result.ErrorCode)
			}
			var bound gateway.InvocationRequest
			if json.Unmarshal(result.Plans[0].Request, &bound) != nil || bound.SessionRef == nil {
				t.Fatal("completed PostgreSQL plan lost its bound Router session")
			}
			if turn == 0 {
				sessionRef = *bound.SessionRef
			} else if *bound.SessionRef != sessionRef {
				t.Fatal("same model continuation created a second Router session")
			}
			session, e := client.Session(ctx, gateway.Actor{SubjectRef: owner}, sessionRef)
			if e != nil || session.ConversationRef != epoch {
				t.Fatal("actual actor-owned Router session does not match the private correlation", e)
			}
			inv, e := client.Invocation(ctx, gateway.Actor{SubjectRef: owner}, *result.Plans[0].InvocationRef)
			if e != nil || inv.SessionRef == nil || *inv.SessionRef != sessionRef || inv.State != "SUCCEEDED" {
				t.Fatal("actual HTTP invocation did not persist the correct Router session", e)
			}
			replay, e := acceptance.Assistant(ctx, owner, conversation.ID, key, cmd)
			if e != nil || replay.ID != result.ID || string(replay.Plans[0].Request) != string(result.Plans[0].Request) || replay.Plans[0].RouterConversationRef != epoch {
				t.Fatal("receipt replay changed the frozen request or session epoch", e)
			}
			if turn == 0 {
				// This reproduces the deployed failure against the actual Router
				// guard; fixing STUDIO must not relax that guard or send another turn.
				bound.Correlation.ConversationRef = conversation.ID
				bound.OperationRef = "exe_" + strings.ReplaceAll(uuid.NewString(), "-", "")
				_, e = client.Submit(ctx, gateway.Actor{SubjectRef: owner}, gateway.Submission{IdempotencyKey: uuid.NewString(), Request: bound})
				var fault *gateway.Fault
				if !errors.As(e, &fault) || fault.Code != "IDEMPOTENCY_CONFLICT" {
					t.Fatal("mismatched correlation bypassed the actual Router guard", e)
				}
			}
		}
		messages, e := history.Messages(ctx, actor, conversation.ID, assistantDomain.PageQuery{Page: 1, Size: 100})
		if e != nil || len(messages.Records) != 4 {
			t.Fatal("session epoch or replay changed product history", e)
		}
	})
	t.Run("cancel_does_not_publish_success", func(t *testing.T) {
		job, e := service.Canvas(ctx, owner, uuid.NewString(), graph("mock-text-to-video", map[string]any{"delayMilliseconds": 10000}))
		if e != nil {
			t.Fatal(e)
		}
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			job, e = service.Get(ctx, owner, job.ID)
			if e != nil {
				t.Fatal(e)
			}
			if job.Plans[0].InvocationRef != nil {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		job, e = service.Cancel(ctx, owner, job.ID)
		if e != nil || job.State != "CANCELED" {
			t.Fatalf("cancel %#v %v", job, e)
		}
		time.Sleep(400 * time.Millisecond)
		job, e = service.Get(ctx, owner, job.ID)
		if e != nil || job.State != "CANCELED" || len(job.Plans[0].Outputs) != 0 {
			t.Fatal("canceled output published")
		}
	})
	t.Run("failure_is_real_terminal_error", func(t *testing.T) {
		job, e := service.Canvas(ctx, owner, uuid.NewString(), graph("mock-llm", map[string]any{"scenario": "fail", "delayMilliseconds": 0}))
		if e != nil {
			t.Fatal(e)
		}
		job = wait(t, job.ID)
		if job.State != "FAILED" || job.ErrorCode == nil || *job.ErrorCode != "MOCK_SCENARIO_FAILED" || len(job.Plans[0].Outputs) != 0 {
			t.Fatalf("failure %#v", job)
		}
	})
}

func codeValue(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
