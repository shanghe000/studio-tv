package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"sort"

	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/execution/domain"
)

func (s *Store) ResolveHistoryInput(ctx context.Context, owner string, q application.HistoryInputQuery) (application.HistoryInput, error) {
	var result application.HistoryInput
	if owner == "" || q.ProjectID == "" || q.NodeID == "" || q.OutputID == "" && (q.ExecutionID == "" || q.OutputIndex == nil) {
		return result, domain.ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT t.id,p->>'executionId',o FROM execution.tasks t
	 CROSS JOIN LATERAL jsonb_array_elements(t.payload->'task'->'plans') p
	 CROSS JOIN LATERAL (SELECT value AS o,row_number() OVER(ORDER BY original_position) AS position FROM jsonb_array_elements(p->'outputs') WITH ORDINALITY AS original(value,original_position) WHERE value->>'deletedAt' IS NULL) output
	 WHERE `+visible+` AND t.project_id=$2 AND t.kind<>'ASSISTANT' AND t.history_deleted_at IS NULL
	 AND p->>'nodeId'=$3 AND p->>'state'='SUCCEEDED' AND p->>'historyDeletedAt' IS NULL AND o->>'deletedAt' IS NULL
	 AND (($4<>'' AND o->>'id'=$4 AND ($5='' OR p->>'executionId'=$5)) OR ($4='' AND p->>'executionId'=$5 AND position=$6+1))
	 AND (o->>'type'<>'ASSET' OR EXISTS(SELECT 1 FROM public.assets a JOIN public.projects ap ON ap.id=a.project_id AND ap.owner_id=a.owner_id WHERE a.id=o->>'assetId' AND a.owner_id=t.owner_id AND a.state='READY' AND a.deleted_at IS NULL AND ap.deleted_at IS NULL))
	 LIMIT 2`, owner, q.ProjectID, q.NodeID, q.OutputID, q.ExecutionID, q.OutputIndex)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var raw []byte
		if err = rows.Scan(&result.TaskID, &result.ExecutionID, &raw); err != nil {
			return result, err
		}
		if json.Unmarshal(raw, &result.Output) != nil {
			return result, domain.ErrInvalid
		}
		count++
	}
	if err = rows.Err(); err != nil {
		return result, err
	}
	// Vendor output refs are not necessarily globally unique. An ambiguous
	// selector cannot silently choose a newer task; use the execution selector.
	if count != 1 {
		return application.HistoryInput{}, domain.ErrNotFound
	}
	return result, nil
}

func validateHistoryInputs(ctx context.Context, tx pgx.Tx, target domain.Task) error {
	byTask := map[string][]domain.InputReference{}
	for _, plan := range target.Plans {
		for _, ref := range plan.InputReferences {
			if ref.HistoryTaskID != "" {
				byTask[ref.HistoryTaskID] = append(byTask[ref.HistoryTaskID], ref)
			}
		}
	}
	ids := make([]string, 0, len(byTask))
	for id := range byTask {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if target.ProjectID == nil {
			return domain.ErrNotFound
		}
		// A share lock serializes output/history deletion with acceptance. It
		// also rejects a parent deleted between preflight and this transaction.
		source, err := scan(tx.QueryRow(ctx, `SELECT `+columns+` FROM execution.tasks t WHERE `+visible+` AND t.id=$2 AND t.project_id=$3 AND t.kind<>'ASSISTANT' AND t.history_deleted_at IS NULL FOR SHARE`, taskActor(target), id, *target.ProjectID))
		if err != nil {
			return err
		}
		for _, ref := range byTask[id] {
			found := false
			for _, plan := range source.Plans {
				if plan.NodeID != ref.SourceNodeID || plan.ExecutionID != ref.HistoryExecutionID || plan.State != "SUCCEEDED" || plan.HistoryDeletedAt != nil {
					continue
				}
				for _, output := range plan.Outputs {
					if output.ID == ref.HistoryOutputID && output.DeletedAt == nil && ref.HistoryOutputSHA256 != "" && application.HistoryOutputSHA256(output) == ref.HistoryOutputSHA256 {
						found = true
					}
				}
			}
			if !found {
				return domain.ErrNotFound
			}
		}
	}
	return nil
}

func validateInputAsset(ctx context.Context, tx pgx.Tx, owner, id, version string) error {
	var actual string
	err := tx.QueryRow(ctx, `SELECT 'sha256:'||a.checksum_sha256 FROM public.assets a JOIN public.projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE a.id=$1 AND a.state='READY' AND a.deleted_at IS NULL AND p.deleted_at IS NULL FOR SHARE OF a,p`, id).Scan(&actual)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrNotFound
	}
	if err != nil {
		return err
	}
	if actual != version {
		return domain.ErrConflict
	}
	return nil
}
