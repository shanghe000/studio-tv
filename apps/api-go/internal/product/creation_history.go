package product

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	resources "studiotv.local/service/api/internal/modules/resources/application"
	domain "studiotv.local/service/api/internal/modules/resources/domain"
)

// The product read model joins actual completed outputs to the frozen app node.
// Usage records are not generated creations and never enter this query.
type creationHistory struct{ pool *pgxpool.Pool }

func (s creationHistory) Creations(ctx context.Context, a domain.Actor, id string, q domain.Query) (resources.CreationPage, error) {
	result := resources.CreationPage{Records: []resources.Creation{}}
	const query = ` FROM execution.tasks t CROSS JOIN LATERAL jsonb_array_elements(t.payload->'task'->'plans') p CROSS JOIN LATERAL jsonb_array_elements(p->'outputs') o JOIN public.assets asset ON asset.id=o->>'assetId' AND asset.owner_id=t.owner_id JOIN public.projects project ON project.id=t.project_id AND project.owner_id=t.owner_id WHERE t.owner_id=$1 AND t.history_deleted_at IS NULL AND project.deleted_at IS NULL AND asset.deleted_at IS NULL AND asset.state='READY' AND p->>'state'='SUCCEEDED' AND p->>'historyDeletedAt' IS NULL AND o->>'deletedAt' IS NULL AND (p->'nodeSnapshot'->'data'->>'webappId'=$2 OR p->'nodeSnapshot'->'data'->>'appId'=$2 OR p->'nodeSnapshot'->'data'->>'webAppId'=$2)`
	if err := s.pool.QueryRow(ctx, "SELECT count(*)"+query, a.OwnerID, id).Scan(&result.Total); err != nil {
		return result, domain.ErrUnavailable
	}
	rows, err := s.pool.Query(ctx, "SELECT o->>'id',t.id,asset.id"+query+" ORDER BY t.created_at DESC,t.id,o->>'id' LIMIT $3 OFFSET $4", a.OwnerID, id, q.Size, int64(q.Page-1)*int64(q.Size))
	if err != nil {
		return result, domain.ErrUnavailable
	}
	defer rows.Close()
	for rows.Next() {
		var c resources.Creation
		if rows.Scan(&c.ID, &c.TaskID, &c.AssetID) != nil {
			return result, domain.ErrUnavailable
		}
		c.CreationShowreelInfo.FileURL = "rhtv-asset:" + c.AssetID
		result.Records = append(result.Records, c)
	}
	if err = rows.Err(); err != nil {
		return result, domain.ErrUnavailable
	}
	return result, nil
}

var _ resources.CreationHistory = creationHistory{}
