package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/testdb"
	"studiotv.local/service/api/migrations"
)

const acceptanceGraph = `{"nodes":[{"id":"source","type":"rh-text","data":{"text":"reference"}},{"id":"target","type":"rh-text","data":{"prompt":"original"}},{"id":"other-source","type":"rh-text","data":{"text":"other reference"}},{"id":"other","type":"rh-text","data":{"prompt":"other prompt"}}],"edges":[{"id":"edge","source":"source","target":"target"}]}`

func TestPostgresCanvasAcceptanceMigrationBackfillsConservatively(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testdb.New(t).Open(t)
	if _, err := pool.Exec(ctx, `CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		t.Fatal(err)
	}
	entries, err := migrations.Files.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".sql") || entry.Name() >= "026_" {
			continue
		}
		source, err := migrations.Files.ReadFile(entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, string(source)); err != nil {
			t.Fatal(entry.Name(), err)
		}
		if _, err = pool.Exec(ctx, `INSERT INTO schema_migrations(name) VALUES($1)`, entry.Name()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,email,display_name) VALUES('upgrade-owner','upgrade@example.test','Upgrade');
 INSERT INTO projects(id,owner_id,name,revision,graph) VALUES('upgrade-project','upgrade-owner','Upgrade',7,'{"nodes":[{"id":"target","type":"rh-text","data":{"text":"old input"}}],"edges":[]}');`); err != nil {
		t.Fatal(err)
	}
	for repeat := 0; repeat < 2; repeat++ {
		if err = database.Migrate(ctx, pool); err != nil {
			t.Fatal("upgrade or idempotent reapplication failed", err)
		}
		var changed, orderChanged, revision int64
		if err = pool.QueryRow(ctx, `SELECT v.last_changed_project_revision,p.last_node_order_changed_revision,p.revision FROM canvas.node_versions v JOIN public.projects p ON p.id=v.project_id WHERE p.id='upgrade-project' AND v.node_id='target'`).Scan(&changed, &orderChanged, &revision); err != nil || changed != 7 || orderChanged != 7 || revision != 7 {
			t.Fatal("migration inferred pre-upgrade input history or changed project revision", changed, orderChanged, revision, err)
		}
	}
}

func acceptanceTask(graph, target string, revision int64) domain.Task {
	now := time.Now().UTC()
	project := "input-project"
	var snapshot domain.Graph
	_ = json.Unmarshal([]byte(graph), &snapshot)
	var node json.RawMessage
	for _, raw := range snapshot.Nodes {
		var value domain.Node
		_ = json.Unmarshal(raw, &value)
		if value.ID == target {
			node = raw
		}
	}
	return domain.Task{ID: "acceptance-" + uuid.NewString(), OwnerID: "input-owner", ProjectID: &project, Kind: "CANVAS", TargetType: "NODE", TargetID: target, State: "QUEUED", Revision: 1, TestMode: true, CreatedAt: now, UpdatedAt: now, Snapshot: json.RawMessage(graph), ExpectedRevision: &revision, Plans: []domain.Plan{{NodeID: target, ExecutionID: "acceptance-execution-" + uuid.NewString(), State: "QUEUED", TestMode: true, NodeSnapshot: node, Request: json.RawMessage(`{}`)}}}
}

func createAcceptanceTask(t *testing.T, f historyInputFixture, graph, target string, revision int64) domain.Task {
	t.Helper()
	task, err := f.store.Create(f.ctx, acceptanceTask(graph, target, revision), uuid.NewString(), strings.Repeat("a", 64), nil)
	if err != nil {
		t.Fatal("unchanged saved input was rejected after an unrelated revision", err)
	}
	if !task.CanvasManaged || task.Plans[0].CanvasBinding == nil {
		t.Fatal("accepted task lost its server-managed binding")
	}
	return task
}

func TestPostgresCanvasAcceptanceSurvivesUnrelatedRevisions(t *testing.T) {
	for _, scenario := range []string{"other-node", "other-edge", "other-added", "other-deleted", "other-add-delete", "layout", "revision-only", "legacy-writer", "other-task-progress", "other-task-completion", "input-progress", "metadata-only"} {
		t.Run(scenario, func(t *testing.T) {
			f := newHistoryInputFixture(t)
			revision := setManagedGraph(t, f, acceptanceGraph)
			graph := acceptanceGraph
			switch scenario {
			case "other-node", "legacy-writer":
				graph = strings.ReplaceAll(graph, "other prompt", "another editor's new prompt")
			case "other-edge":
				graph = strings.Replace(graph, `"edges":[`, `"edges":[{"id":"other-edge","source":"other-source","target":"other"},`, 1)
			case "other-added", "other-add-delete":
				graph = strings.Replace(graph, `"nodes":[`, `"nodes":[{"id":"new-other","type":"rh-text","data":{"text":"new unrelated node"}},`, 1)
			case "other-deleted":
				graph = strings.Replace(graph, `,{"id":"other-source","type":"rh-text","data":{"text":"other reference"}}`, "", 1)
			case "layout":
				graph = strings.Replace(graph, `"id":"target"`, `"id":"target","position":{"x":300,"y":400}`, 1)
			case "input-progress":
				graph = strings.Replace(graph, `"text":"reference"`, `"text":"reference","status":"processing","taskId":"observation","progress":50,"progressDetail":{"phase":"sampling","scope":"TASK"}`, 1)
			case "other-task-progress", "other-task-completion":
				other := createAcceptanceTask(t, f, graph, "other", revision)
				if _, err := f.pool.Exec(f.ctx, `UPDATE execution.tasks SET lease_token=$2,lease_until=now()+interval '60 seconds' WHERE id=$1`, other.ID, "05764324-02f4-4125-9501-4b441fce3f18"); err != nil {
					t.Fatal(err)
				}
				if scenario == "other-task-completion" {
					finishManaged(t, f, other)
				} else {
					progress := 0.5
					other.State, other.Plans[0].State = "RUNNING", "RUNNING"
					other.Plans[0].Progress = &progress
					other.Plans[0].ProgressDetail = &domain.ProgressDetail{Phase: "sampling", Scope: "TASK"}
					if ok, err := f.store.Save(f.ctx, other, "05764324-02f4-4125-9501-4b441fce3f18"); err != nil || !ok {
						t.Fatal("isolated worker progress fixture", ok, err)
					}
				}
			}
			if !strings.HasPrefix(scenario, "other-task-") {
				if scenario == "metadata-only" {
					if _, err := f.pool.Exec(f.ctx, `UPDATE public.projects SET name='Another editor renamed the project' WHERE id='input-project'`); err != nil {
						t.Fatal(err)
					}
				} else if scenario == "legacy-writer" {
					if _, err := f.pool.Exec(f.ctx, `UPDATE public.projects SET graph=$1 WHERE id='input-project'`, json.RawMessage(graph)); err != nil {
						t.Fatal(err)
					}
				} else {
					setManagedGraph(t, f, graph)
					if scenario == "other-add-delete" {
						setManagedGraph(t, f, acceptanceGraph)
					}
				}
			}
			before, current := currentManagedGraph(t, f)
			if scenario != "metadata-only" && current <= revision {
				t.Fatal("fixture did not advance the global revision")
			}
			var inputChanged int64
			if err := f.pool.QueryRow(f.ctx, `SELECT max(last_changed_project_revision) FROM canvas.node_versions WHERE project_id='input-project' AND node_id=ANY(ARRAY['source','target'])`).Scan(&inputChanged); err != nil || inputChanged > revision {
				t.Fatal("unrelated write invalidated the input boundary", inputChanged, err)
			}
			var orderChanged int64
			if err := f.pool.QueryRow(f.ctx, `SELECT last_node_order_changed_revision FROM public.projects WHERE id='input-project'`).Scan(&orderChanged); err != nil || orderChanged > revision {
				t.Fatal("an unrelated addition, deletion or edit stamped node order", orderChanged, err)
			}
			createAcceptanceTask(t, f, acceptanceGraph, "target", revision)
			// Acceptance patches the latest project, preserving the other editor
			// or worker's graph rather than replacing it with the old request.
			after, _ := currentManagedGraph(t, f)
			var a, b domain.Graph
			_ = json.Unmarshal([]byte(before), &a)
			_ = json.Unmarshal([]byte(after), &b)
			if len(a.Nodes) != len(b.Nodes) || !reflect.DeepEqual(a.Edges, b.Edges) {
				t.Fatal("acceptance replaced concurrent topology")
			}
			for index, raw := range a.Nodes {
				var node domain.Node
				_ = json.Unmarshal(raw, &node)
				if node.ID != "target" && string(raw) != string(b.Nodes[index]) {
					t.Fatal("acceptance overwrote an unrelated node", node.ID)
				}
			}
		})
	}
}

func TestPostgresCanvasAcceptanceRejectsChangedClosureAndConsumedReceipts(t *testing.T) {
	for _, scenario := range []string{"zero-revision", "future-revision", "prompt", "source", "input-undo", "edge-undo", "order-undo", "source-recreate", "target-recreate", "history-output", "history-output-undo", "unknown-input-undo", "related-accepted-task", "consumed-receipt"} {
		t.Run(scenario, func(t *testing.T) {
			f := newHistoryInputFixture(t)
			revision := setManagedGraph(t, f, acceptanceGraph)
			graph := acceptanceGraph
			switch scenario {
			case "zero-revision":
				revision = 0
			case "future-revision":
				revision++
			case "prompt", "input-undo":
				graph = strings.Replace(graph, "original", "changed", 1)
			case "source":
				graph = strings.Replace(graph, "reference", "changed reference", 1)
			case "edge-undo":
				graph = strings.Replace(graph, `"id":"edge"`, `"id":"edge","conditioningRole":"FIRST_FRAME"`, 1)
			case "order-undo":
				var reordered domain.Graph
				_ = json.Unmarshal([]byte(graph), &reordered)
				reordered.Nodes[0], reordered.Nodes[1] = reordered.Nodes[1], reordered.Nodes[0]
				value, err := json.Marshal(reordered)
				if err != nil {
					t.Fatal(err)
				}
				graph = string(value)
			case "source-recreate":
				graph = `{"nodes":[{"id":"target","type":"rh-text","data":{"prompt":"original"}}],"edges":[]}`
			case "target-recreate":
				graph = `{"nodes":[],"edges":[]}`
			case "history-output", "history-output-undo":
				graph = strings.Replace(graph, `"prompt":"original"`, `"prompt":"original","output":[{"text":"new output"}],"historyStorage":{"source":"remote","schemaVersion":1,"historyId":"new-result","revision":"2","resultCount":1},"selectedHistoryOutputId":"new-output"`, 1)
			case "unknown-input-undo":
				graph = strings.Replace(graph, `"prompt":"original"`, `"prompt":"original","unknownInput":{"value":true}`, 1)
			case "related-accepted-task":
				createAcceptanceTask(t, f, graph, "source", revision)
			case "consumed-receipt":
				createAcceptanceTask(t, f, graph, "target", revision)
			}
			if graph != acceptanceGraph {
				setManagedGraph(t, f, graph)
				if strings.HasSuffix(scenario, "-undo") || strings.HasSuffix(scenario, "-recreate") {
					setManagedGraph(t, f, acceptanceGraph)
				}
			}
			var beforeTasks, beforePlans, afterTasks, afterPlans int
			if err := f.pool.QueryRow(f.ctx, `SELECT count(*),coalesce(sum(jsonb_array_length(payload->'task'->'plans')),0) FROM execution.tasks`).Scan(&beforeTasks, &beforePlans); err != nil {
				t.Fatal(err)
			}
			_, err := f.store.Create(f.ctx, acceptanceTask(acceptanceGraph, "target", revision), uuid.NewString(), strings.Repeat("a", 64), nil)
			if !errors.Is(err, domain.ErrConflict) {
				t.Fatal("stale input or receipt was accepted", scenario, err)
			}
			if err := f.pool.QueryRow(f.ctx, `SELECT count(*),coalesce(sum(jsonb_array_length(payload->'task'->'plans')),0) FROM execution.tasks`).Scan(&afterTasks, &afterPlans); err != nil || beforeTasks != afterTasks || beforePlans != afterPlans {
				t.Fatal("refused acceptance persisted a task or plan", beforeTasks, beforePlans, afterTasks, afterPlans, err)
			}
		})
	}
}
