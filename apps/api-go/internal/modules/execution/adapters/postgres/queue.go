package postgres

import (
	"context"

	"studiotv.local/service/api/internal/modules/execution/application"
)

// GenerationQueue takes one database snapshot of every active STUDIO task. A task
// with several H3 plans contributes once. Delayed retries and leased tasks still
// count: neither available_at nor the worker lease means the task completed.
func (s *Store) GenerationQueue(ctx context.Context) ([]application.QueueGroup, error) {
	rows, err := s.pool.Query(ctx, `
WITH active AS (
 SELECT t.kind, t.state, t.created_at,
 CASE WHEN EXISTS (
  SELECT 1 FROM jsonb_array_elements(CASE
   WHEN jsonb_typeof(t.payload->'task'->'plans')='array' THEN t.payload->'task'->'plans'
   ELSE '[]'::jsonb END) p
  WHERE p->>'capabilityRef' LIKE 'h3-%'
 ) THEN 'h3' ELSE 'other' END AS capability_family
 FROM execution.tasks t WHERE t.state IN ('QUEUED','RUNNING')
)
SELECT kind, capability_family,
 count(*) FILTER (WHERE state='QUEUED'),
 count(*) FILTER (WHERE state='RUNNING'),
 COALESCE(GREATEST(0, EXTRACT(EPOCH FROM (statement_timestamp()-min(created_at) FILTER (WHERE state='QUEUED')))),0)::double precision
FROM active GROUP BY kind, capability_family`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	groups := []application.QueueGroup{}
	for rows.Next() {
		var group application.QueueGroup
		if err = rows.Scan(&group.Kind, &group.CapabilityFamily, &group.Queued, &group.Running, &group.OldestQueuedAgeSeconds); err != nil {
			return nil, err
		}
		groups = append(groups, group)
	}
	return groups, rows.Err()
}

var _ application.QueueReader = (*Store)(nil)
