package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/execution/domain"
	"sort"
	"time"
)

func (s *Store) History(ctx context.Context, owner string, q application.HistoryQuery) (application.HistoryPage, error) {
	page := application.HistoryPage{Records: []application.History{}, Page: q.Page, Size: q.Size}
	if q.Page < 1 || q.Page > 100000 || q.Size < 1 || q.Size > 100 {
		return page, domain.ErrInvalid
	}
	if q.ProjectID != "" {
		if _, err := collaboration.RequireProject(ctx, s.pool, owner, q.ProjectID, "VIEWER", false); err != nil {
			return page, err
		}
	}
	filter := ` FROM execution.tasks t CROSS JOIN LATERAL jsonb_array_elements(t.payload->'task'->'plans') p WHERE ` + visible + ` AND t.history_deleted_at IS NULL AND t.kind<>'ASSISTANT' AND p->>'state'='SUCCEEDED' AND p->>'historyDeletedAt' IS NULL AND ($2='' OR t.project_id=$2) AND ($3='' OR p->>'nodeId'=$3) AND ($4='' OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'outputs') o WHERE (o->>'type'=$4 OR o->>'mimeType' LIKE $4||'/%') AND o->>'deletedAt' IS NULL))`
	if err := s.pool.QueryRow(ctx, "SELECT count(*)"+filter, owner, q.ProjectID, q.NodeID, q.Type).Scan(&page.Total); err != nil {
		return page, err
	}
	rows, err := s.pool.Query(ctx, "SELECT t.id,t.project_id,t.revision,t.created_at,p"+filter+" ORDER BY t.created_at DESC,t.id DESC,p->>'executionId' LIMIT $5 OFFSET $6", owner, q.ProjectID, q.NodeID, q.Type, q.Size, int64(q.Page-1)*int64(q.Size))
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var h application.History
		var raw []byte
		if err = rows.Scan(&h.TaskID, &h.ProjectID, &h.Revision, &h.CreatedAt, &raw); err != nil {
			return page, err
		}
		var p domain.Plan
		if json.Unmarshal(raw, &p) != nil {
			return page, domain.ErrInvalid
		}
		h.ID = p.ExecutionID
		h.ExecutionID = p.ExecutionID
		h.NodeID = p.NodeID
		h.Outputs = []domain.Output{}
		for _, o := range p.Outputs {
			if o.DeletedAt == nil {
				h.Outputs = append(h.Outputs, o)
			}
		}
		h.ParamsSnapshot = p.Parameters
		h.NodeConfigSnapshot = p.NodeSnapshot
		h.TestMode = p.TestMode
		page.Records = append(page.Records, h)
		if h.Revision > page.Revision {
			page.Revision = h.Revision
		}
	}
	if err = s.pool.QueryRow(ctx, "SELECT COALESCE(max(revision),0) FROM execution.history_revisions WHERE (owner_id=$1 OR collaboration.project_role(project_id,$1) IS NOT NULL) AND ($2='' OR project_id=$2) AND ($3='' OR node_id=$3)", owner, q.ProjectID, q.NodeID).Scan(&page.Revision); err != nil {
		return page, err
	}
	page.HasNext = int64(q.Page)*int64(q.Size) < page.Total
	return page, rows.Err()
}
func (s *Store) DeleteHistory(ctx context.Context, owner string, ids []string) ([]string, error) {
	return s.deleteHistory(ctx, owner, ids, "", "")
}
func (s *Store) DeleteHistoryIdempotent(ctx context.Context, owner string, ids []string, key, hash string) ([]string, error) {
	return s.deleteHistory(ctx, owner, ids, key, hash)
}
func (s *Store) deleteHistory(ctx context.Context, owner string, ids []string, key, hash string) ([]string, error) {
	if len(ids) < 1 || len(ids) > 100 {
		return nil, domain.ErrInvalid
	}
	unique := map[string]bool{}
	for _, id := range ids {
		if id == "" || unique[id] {
			return nil, domain.ErrInvalid
		}
		unique[id] = true
	}
	ids = append([]string(nil), ids...)
	sort.Strings(ids)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	replay := false
	if key != "" {
		if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", owner+"/history-delete/"+key); err != nil {
			return nil, err
		}
		var oldHash string
		err = tx.QueryRow(ctx, "SELECT request_hash FROM public.idempotency_keys WHERE owner_id=$1 AND operation='executionDeleteHistory' AND key=$2", owner, key).Scan(&oldHash)
		if err == nil {
			if oldHash != hash {
				return nil, domain.ErrConflict
			}
			replay = true
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}

	rows, err := tx.Query(ctx, `SELECT `+columns+` FROM execution.tasks t WHERE `+visible+` AND EXISTS(SELECT 1 FROM jsonb_array_elements(t.payload->'task'->'plans') p WHERE p->>'executionId'=ANY($2::text[])) ORDER BY id FOR UPDATE`, owner, ids)
	if err != nil {
		return nil, err
	}
	tasks := []domain.Task{}
	seen := map[string]bool{}
	for rows.Next() {
		t, e := scan(rows)
		if e != nil {
			rows.Close()
			return nil, e
		}
		for _, p := range t.Plans {
			if unique[p.ExecutionID] {
				seen[p.ExecutionID] = true
			}
		}
		tasks = append(tasks, t)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(seen) != len(unique) {
		return nil, domain.ErrNotFound
	}
	for _, t := range tasks {
		if err = authorizeUserTaskChange(ctx, tx, owner, t); err != nil {
			return nil, err
		}
	}
	if replay {
		return ids, tx.Commit(ctx)
	}
	now := time.Now().UTC()
	for _, t := range tasks {
		for i, p := range t.Plans {
			if unique[p.ExecutionID] && p.HistoryDeletedAt == nil {
				t.Plans[i].HistoryDeletedAt = &now
				if err = bumpHistory(ctx, tx, t, p.NodeID); err != nil {
					return nil, err
				}
			}
		}
		t.Revision++
		body, e := encode(t)
		if e != nil {
			return nil, e
		}
		if _, err = tx.Exec(ctx, "UPDATE execution.tasks SET payload=$2,revision=$3,updated_at=now() WHERE id=$1", t.ID, body, t.Revision); err != nil {
			return nil, err
		}
	}
	if key != "" {
		body, _ := json.Marshal(map[string]any{"deletedIds": ids})
		if _, err = tx.Exec(ctx, "INSERT INTO public.idempotency_keys(owner_id,operation,key,request_hash,response_status,response_body)VALUES($1,'executionDeleteHistory',$2,$3,200,$4)", owner, key, hash, body); err != nil {
			return nil, err
		}
	}
	return ids, tx.Commit(ctx)
}
func (s *Store) DeleteOutput(ctx context.Context, owner, executionID, outputID string, revision int64) (domain.Task, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Task{}, err
	}
	defer tx.Rollback(ctx)
	t, err := scan(tx.QueryRow(ctx, `SELECT `+columns+` FROM execution.tasks t WHERE `+visible+` AND EXISTS(SELECT 1 FROM jsonb_array_elements(t.payload->'task'->'plans') p WHERE p->>'executionId'=$2 AND p->>'historyDeletedAt' IS NULL) FOR UPDATE`, owner, executionID))
	if err != nil {
		return t, err
	}
	if err = authorizeUserTaskChange(ctx, tx, owner, t); err != nil {
		return t, err
	}
	if revision != t.Revision {
		return t, domain.ErrConflict
	}
	found := false
	now := time.Now().UTC()
	for i, p := range t.Plans {
		if p.ExecutionID == executionID {
			for j, o := range p.Outputs {
				if o.ID == outputID && o.DeletedAt == nil {
					t.Plans[i].Outputs[j].DeletedAt = &now
					if err = bumpHistory(ctx, tx, t, p.NodeID); err != nil {
						return t, err
					}
					found = true
				}
			}
		}
	}
	if !found {
		return t, domain.ErrNotFound
	}
	t.Revision++
	t.UpdatedAt = now
	body, err := encode(t)
	if err != nil {
		return t, err
	}
	_, err = tx.Exec(ctx, "UPDATE execution.tasks SET payload=$2,revision=$3,updated_at=$4 WHERE id=$1", t.ID, body, t.Revision, now)
	if err != nil {
		return t, err
	}
	return t, tx.Commit(ctx)
}

func (s *Store) HistoryDetail(ctx context.Context, owner, eid string) (application.History, error) {
	var h application.History
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT t.id,t.project_id,t.revision,t.created_at,p FROM execution.tasks t CROSS JOIN LATERAL jsonb_array_elements(t.payload->'task'->'plans') p WHERE `+visible+` AND t.history_deleted_at IS NULL AND t.kind<>'ASSISTANT' AND p->>'state'='SUCCEEDED' AND p->>'historyDeletedAt' IS NULL AND p->>'executionId'=$2`, owner, eid).Scan(&h.TaskID, &h.ProjectID, &h.Revision, &h.CreatedAt, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return h, domain.ErrNotFound
	}
	if err != nil {
		return h, err
	}
	var p domain.Plan
	if json.Unmarshal(raw, &p) != nil {
		return h, domain.ErrInvalid
	}
	h.ID = p.ExecutionID
	h.ExecutionID = p.ExecutionID
	h.NodeID = p.NodeID
	h.Outputs = []domain.Output{}
	for _, o := range p.Outputs {
		if o.DeletedAt == nil {
			h.Outputs = append(h.Outputs, o)
		}
	}
	h.ParamsSnapshot = p.Parameters
	h.NodeConfigSnapshot = p.NodeSnapshot
	h.TestMode = p.TestMode
	return h, nil
}
