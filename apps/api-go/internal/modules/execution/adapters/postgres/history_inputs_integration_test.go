package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/database"
	executionPG "studiotv.local/service/api/internal/modules/execution/adapters/postgres"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"studiotv.local/service/api/internal/testdb"
)

type historyInputCatalog struct{ gateway.Unconfigured }

func (historyInputCatalog) Capabilities(context.Context, gateway.Actor, gateway.CapabilityQuery) (gateway.CapabilityPage, error) {
	return gateway.CapabilityPage{Items: []gateway.Capability{{Ref: "history-input-fixture", Version: "1", Kind: "LLM", TestMode: true, Available: true, ParameterSchemaVersion: "1", ParameterSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`), InputKinds: []string{"TEXT", "STRUCTURED", "IMAGE", "VIDEO", "AUDIO"}, OutputKinds: []string{"TEXT"}}}}, nil
}

type historyInputFixture struct {
	ctx     context.Context
	pool    *pgxpool.Pool
	store   *executionPG.Store
	service *execution.Service
}

func newHistoryInputFixture(t *testing.T) historyInputFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	pool := testdb.New(t).Open(t)
	if err := database.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO public.users(id,email,display_name) VALUES('input-owner','inputs@example.test','Inputs'),('input-other','other-inputs@example.test','Other');
	 INSERT INTO public.projects(id,owner_id,name) VALUES('input-project','input-owner','Inputs'),('input-other-project','input-owner','Other project'),('input-media-project','input-owner','Media'),('foreign-project','input-other','Foreign');
	 INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state) VALUES('input-old-image','input-owner','input-media-project','old.png','IMAGE','image/png',4,repeat('a',64),'READY'),('input-new-image','input-owner','input-media-project','new.png','IMAGE','image/png',4,repeat('b',64),'READY')`); err != nil {
		t.Fatal(err)
	}
	store, _ := executionPG.New(pool)
	service, _ := execution.New(store, historyInputCatalog{}, selectionImporter{})
	return historyInputFixture{ctx, pool, store, service}
}

// These completed results are persistence fixtures, clearly marked TEST MODE.
// No model gateway submission or synthetic provider success is used here.
func (f historyInputFixture) history(t *testing.T, owner, project, node, state string, outputs []domain.Output) domain.Task {
	t.Helper()
	for i := range outputs {
		outputs[i].TestMode = true
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	task := domain.Task{ID: "fixture-" + uuid.NewString(), OwnerID: owner, ProjectID: &project, Kind: "CANVAS", TargetType: "NODE", TargetID: node, State: state, Revision: 1, TestMode: true, CreatedAt: now, UpdatedAt: now, Plans: []domain.Plan{{NodeID: node, ExecutionID: "fixture-execution-" + uuid.NewString(), State: state, TestMode: true, Outputs: outputs}}}
	got, err := f.store.Create(f.ctx, task, uuid.NewString(), strings.Repeat("f", 64), nil)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func historyGraph(selector string) json.RawMessage {
	return json.RawMessage(`{"nodes":[{"id":"source","type":"rh-image","data":{` + selector + `,"taskId":"untrusted","status":"finished","output":[{"assetId":"input-new-image"}],"sourceObjects":["rhtv-asset:input-new-image"],"imageUrl":"rhtv-asset:input-new-image"}},{"id":"target","type":"rh-text","data":{"capabilityRef":"history-input-fixture","prompt":"Describe chosen result"}}],"edges":[{"source":"source","target":"target"}]}`)
}

func TestPostgresSelectedHistoryInputOwnershipAvailabilityAndFreeze(t *testing.T) {
	f := newHistoryInputFixture(t)
	oldImage, newImage := "input-old-image", "input-new-image"
	old := f.history(t, "input-owner", "input-project", "source", "SUCCEEDED", []domain.Output{{ID: "selected-owned-output", Type: "ASSET", AssetID: &oldImage}})
	f.history(t, "input-owner", "input-project", "source", "SUCCEEDED", []domain.Output{{ID: "current-owned-output", Type: "ASSET", AssetID: &newImage}})
	query := execution.HistoryInputQuery{ProjectID: "input-project", NodeID: "source", OutputID: "selected-owned-output"}
	resolved, err := f.store.ResolveHistoryInput(f.ctx, "input-owner", query)
	if err != nil || resolved.TaskID != old.ID || resolved.Output.AssetID == nil || *resolved.Output.AssetID != oldImage {
		t.Fatal("selected old result was replaced by latest", err)
	}
	for _, test := range []struct {
		name, owner string
		query       execution.HistoryInputQuery
	}{
		{"foreign owner", "input-other", query},
		{"different project", "input-owner", execution.HistoryInputQuery{ProjectID: "input-other-project", NodeID: "source", OutputID: "selected-owned-output"}},
		{"different source node", "input-owner", execution.HistoryInputQuery{ProjectID: "input-project", NodeID: "different", OutputID: "selected-owned-output"}},
		{"missing output", "input-owner", execution.HistoryInputQuery{ProjectID: "input-project", NodeID: "source", OutputID: "missing"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := f.store.ResolveHistoryInput(f.ctx, test.owner, test.query); !errors.Is(err, domain.ErrNotFound) {
				t.Fatal("history authority leaked or fell back", err)
			}
		})
	}
	index := 0
	indexed, err := f.store.ResolveHistoryInput(f.ctx, "input-owner", execution.HistoryInputQuery{ProjectID: "input-project", NodeID: "source", ExecutionID: old.Plans[0].ExecutionID, OutputIndex: &index})
	if err != nil || indexed.Output.ID != "selected-owned-output" {
		t.Fatal("execution/index selector failed", err)
	}
	task, err := f.service.Canvas(f.ctx, "input-owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "input-project", TargetType: "NODE", TargetID: "target", Graph: historyGraph(`"selectedHistoryOutputId":"selected-owned-output"`)})
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := f.store.Get(f.ctx, "input-owner", task.ID)
	if err != nil || len(reloaded.Plans[0].InputReferences) != 1 {
		t.Fatal("private reference manifest did not survive persistence", err)
	}
	ref := reloaded.Plans[0].InputReferences[0]
	if ref.HistoryTaskID != old.ID || ref.HistoryExecutionID != old.Plans[0].ExecutionID || ref.HistoryOutputID != "selected-owned-output" || ref.AssetID != oldImage || ref.AssetVersion != "sha256:"+strings.Repeat("a", 64) || ref.Modality != "IMAGE" || ref.Role != "REFERENCE_IMAGE" {
		t.Fatal("frozen history content/version/role did not match source")
	}
	var request gateway.InvocationRequest
	if json.Unmarshal(reloaded.Plans[0].Request, &request) != nil || len(request.Attachments) != 1 || request.Attachments[0].SourceRef != oldImage {
		t.Fatal("graph display/current media entered chosen history input")
	}
	public, _ := json.Marshal(reloaded)
	if strings.Contains(string(public), "HistoryOutputSHA256") || strings.Contains(string(public), "InputReferences") {
		t.Fatal("private input authority leaked through task JSON")
	}
	// Normal Web apply() supplies the whole current batch and a historyId,
	// without an explicit output selection. Re-read every real visible result.
	currentText := "authoritative current text"
	current := f.history(t, "input-owner", "input-project", "source", "SUCCEEDED", []domain.Output{{ID: "current-text", Type: "TEXT", Text: &currentText}, {ID: "current-json", Type: "STRUCTURED", SchemaVersion: "1", Data: json.RawMessage(`{"scene":"authoritative current structure"}`)}, {ID: "current-first-image", Type: "ASSET", AssetID: &oldImage}, {ID: "current-second-image", Type: "ASSET", AssetID: &newImage}})
	currentGraph := json.RawMessage(`{"nodes":[{"id":"source","type":"rh-script","data":{"historyStorage":{"source":"remote","historyId":"` + current.Plans[0].ExecutionID + `","resultCount":99},"output":[{"text":"forged graph text"},{"assetId":"input-new-image"}],"structuredOutput":{"scene":"forged structure"}}},{"id":"target","type":"rh-text","data":{"capabilityRef":"history-input-fixture","prompt":"Read current batch"}}],"edges":[{"source":"source","target":"target"}]}`)
	currentTask, err := f.service.Canvas(f.ctx, "input-owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "input-project", TargetType: "NODE", TargetID: "target", Graph: currentGraph})
	if err != nil || len(currentTask.Plans[0].InputReferences) != 4 {
		t.Fatal("current historyStorage batch lost text, structure, or extra images", err)
	}
	if json.Unmarshal(currentTask.Plans[0].Request, &request) != nil || len(request.Attachments) != 2 || !strings.Contains(string(currentTask.Plans[0].Input), currentText) || !strings.Contains(string(currentTask.Plans[0].Input), "authoritative current structure") || strings.Contains(string(currentTask.Plans[0].Input), "forged") {
		t.Fatal("default provenance trusted graph output or guessed a single result")
	}
	for _, state := range []string{"QUEUED", "FAILED", "CANCELED"} {
		output := "unavailable-" + state
		f.history(t, "input-owner", "input-project", "source", state, []domain.Output{{ID: output, Type: "ASSET", AssetID: &oldImage}})
		if _, err = f.store.ResolveHistoryInput(f.ctx, "input-owner", execution.HistoryInputQuery{ProjectID: "input-project", NodeID: "source", OutputID: output}); !errors.Is(err, domain.ErrNotFound) {
			t.Fatal("non-successful plan supplied history", state, err)
		}
	}
	// Duplicate vendor refs are ambiguous; an execution selector remains exact.
	f.history(t, "input-owner", "input-project", "source", "SUCCEEDED", []domain.Output{{ID: "selected-owned-output", Type: "ASSET", AssetID: &newImage}})
	if _, err = f.store.ResolveHistoryInput(f.ctx, "input-owner", query); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("ambiguous output ID silently selected a newer record", err)
	}
	query.ExecutionID = old.Plans[0].ExecutionID
	if resolved, err = f.store.ResolveHistoryInput(f.ctx, "input-owner", query); err != nil || resolved.TaskID != old.ID {
		t.Fatal("execution ID did not disambiguate the exact selected output", err)
	}
	query.ExecutionID = "unrelated-execution"
	if _, err = f.store.ResolveHistoryInput(f.ctx, "input-owner", query); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("mismatched execution ID fell back to an output from another execution", err)
	}
	// UI history returns only non-deleted outputs. Its visible index must use
	// that same list even after earlier/intermediate output tombstones.
	text := "visible output fixture"
	multi := f.history(t, "input-owner", "input-project", "source", "SUCCEEDED", []domain.Output{{ID: "index-first", Type: "TEXT", Text: &text}, {ID: "index-middle", Type: "TEXT", Text: &text}, {ID: "index-last", Type: "TEXT", Text: &text}})
	deleted, err := f.store.DeleteOutput(f.ctx, "input-owner", multi.Plans[0].ExecutionID, "index-first", multi.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.DeleteOutput(f.ctx, "input-owner", multi.Plans[0].ExecutionID, "index-middle", deleted.Revision); err != nil {
		t.Fatal(err)
	}
	detail, err := f.store.HistoryDetail(f.ctx, "input-owner", multi.Plans[0].ExecutionID)
	if err != nil || len(detail.Outputs) != 1 || detail.Outputs[0].ID != "index-last" {
		t.Fatal("visible history fixture did not exclude earlier tombstones", err)
	}
	indexed, err = f.store.ResolveHistoryInput(f.ctx, "input-owner", execution.HistoryInputQuery{ProjectID: "input-project", NodeID: "source", ExecutionID: multi.Plans[0].ExecutionID, OutputIndex: &index})
	if err != nil || indexed.Output.ID != detail.Outputs[index].ID {
		t.Fatal("visible history index changed meaning after output deletion", err)
	}
	if _, err = f.pool.Exec(f.ctx, `UPDATE public.projects SET deleted_at=now() WHERE id='input-project'`); err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.ResolveHistoryInput(f.ctx, "input-owner", execution.HistoryInputQuery{ProjectID: "input-project", NodeID: "source", OutputID: "selected-owned-output", ExecutionID: old.Plans[0].ExecutionID}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("deleted history source project remained visible", err)
	}
}

type afterHistoryInputStore struct {
	*executionPG.Store
	after func() error
}

func (s *afterHistoryInputStore) ResolveHistoryInput(ctx context.Context, owner string, q execution.HistoryInputQuery) (execution.HistoryInput, error) {
	result, err := s.Store.ResolveHistoryInput(ctx, owner, q)
	if err == nil && s.after != nil {
		err = s.after()
		s.after = nil
	}
	return result, err
}

func TestPostgresSelectedHistoryDeletionRaceAndSourceProjectBinding(t *testing.T) {
	for _, race := range []string{"output", "history", "source project"} {
		t.Run(race, func(t *testing.T) {
			f := newHistoryInputFixture(t)
			asset := "input-old-image"
			source := f.history(t, "input-owner", "input-project", "source", "SUCCEEDED", []domain.Output{{ID: "race-output", Type: "ASSET", AssetID: &asset}})
			hook := &afterHistoryInputStore{Store: f.store, after: func() error {
				switch race {
				case "output":
					_, err := f.store.DeleteOutput(f.ctx, "input-owner", source.Plans[0].ExecutionID, "race-output", source.Revision)
					return err
				case "history":
					_, err := f.store.DeleteHistory(f.ctx, "input-owner", []string{source.Plans[0].ExecutionID})
					return err
				default:
					_, err := f.pool.Exec(f.ctx, `UPDATE public.projects SET deleted_at=now() WHERE id='input-media-project'`)
					return err
				}
			}}
			service, _ := execution.New(hook, historyInputCatalog{}, selectionImporter{})
			if _, err := service.Canvas(f.ctx, "input-owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "input-project", TargetType: "NODE", TargetID: "target", Graph: historyGraph(`"selectedHistoryOutputId":"race-output"`)}); !errors.Is(err, domain.ErrNotFound) {
				t.Fatal("deletion after authority read accepted a stale new run", err)
			}
			var count int
			if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM execution.tasks WHERE payload->'task'->>'targetId'='target'`).Scan(&count); err != nil || count != 0 {
				t.Fatal("rejected preflight committed a task or grants", err)
			}
		})
	}
	t.Run("historical deletion before worker binding", func(t *testing.T) {
		f := newHistoryInputFixture(t)
		asset := "input-old-image"
		source := f.history(t, "input-owner", "input-project", "source", "SUCCEEDED", []domain.Output{{ID: "binding-output", Type: "ASSET", AssetID: &asset}})
		accepted, err := f.service.Canvas(f.ctx, "input-owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "input-project", TargetType: "NODE", TargetID: "target", Graph: historyGraph(`"selectedHistoryOutputId":"binding-output"`)})
		if err != nil {
			t.Fatal(err)
		}
		lease := uuid.NewString()
		claimed, ok, err := f.store.Claim(f.ctx, lease)
		if err != nil || !ok || claimed.ID != accepted.ID {
			t.Fatal("binding fixture could not claim accepted task", err)
		}
		if _, err = f.store.DeleteHistory(f.ctx, "input-owner", []string{source.Plans[0].ExecutionID}); err != nil {
			t.Fatal(err)
		}
		if _, err = f.store.BindInputs(f.ctx, claimed, lease, nil); !errors.Is(err, domain.ErrNotFound) {
			t.Fatal("worker binding reused a deleted historical output", err)
		}
	})
	t.Run("uploaded asset source project deleted before binding", func(t *testing.T) {
		f := newHistoryInputFixture(t)
		graph := json.RawMessage(`{"nodes":[{"id":"target","type":"rh-text","data":{"capabilityRef":"history-input-fixture","prompt":"Read owned image","imageUrl":"rhtv-asset:input-old-image"}}],"edges":[]}`)
		accepted, err := f.service.Canvas(f.ctx, "input-owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "input-project", TargetType: "NODE", TargetID: "target", Graph: graph})
		if err != nil {
			t.Fatal(err)
		}
		lease := uuid.NewString()
		claimed, ok, err := f.store.Claim(f.ctx, lease)
		if err != nil || !ok || claimed.ID != accepted.ID {
			t.Fatal("asset fixture could not claim task", err)
		}
		if _, err = f.pool.Exec(f.ctx, `UPDATE public.projects SET deleted_at=now() WHERE id='input-media-project'`); err != nil {
			t.Fatal(err)
		}
		if _, err = f.store.Assets(f.ctx, "input-owner", []string{"input-old-image"}); !errors.Is(err, domain.ErrNotFound) {
			t.Fatal("asset lookup retained a deleted source project", err)
		}
		if _, err = f.store.BindInputs(f.ctx, claimed, lease, nil); !errors.Is(err, domain.ErrNotFound) {
			t.Fatal("binding checked asset state but ignored deleted source project", err)
		}
	})
}
