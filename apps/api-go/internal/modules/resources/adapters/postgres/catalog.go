package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/modules/resources/application"
	"studiotv.local/service/api/internal/modules/resources/domain"
)

func (r *Repository) Categories(ctx context.Context, namespace string, filters map[string]string) ([]json.RawMessage, error) {
	result := []json.RawMessage{}
	if filters == nil {
		filters = map[string]string{}
	}
	contextJSON, _ := json.Marshal(filters)
	if contextJSON == nil {
		contextJSON = []byte("{}")
	}
	rows, e := r.pool.Query(ctx, `SELECT content FROM resources.categories WHERE namespace=$1 AND parent_id IS NULL AND context @> $2::jsonb AND ($1 <> 'PROMPT' OR $3 <> '' OR COALESCE(context->>'menuType','')='') ORDER BY sort_order,id`, namespace, contextJSON, filters["menuType"])
	if e != nil {
		return nil, domain.ErrUnavailable
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		if rows.Scan(&raw) != nil {
			return nil, domain.ErrUnavailable
		}
		result = append(result, json.RawMessage(raw))
	}
	return result, unavailable(rows.Err())
}
func (r *Repository) Values(ctx context.Context, namespace string, keys []string) ([]json.RawMessage, error) {
	result := []json.RawMessage{}
	if keys == nil {
		keys = []string{}
	}
	rows, e := r.pool.Query(ctx, `SELECT content FROM resources.catalog_values WHERE namespace=$1 AND (cardinality($2::text[])=0 OR key=ANY($2)) ORDER BY key`, namespace, keys)
	if e != nil {
		return nil, domain.ErrUnavailable
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		if rows.Scan(&raw) != nil {
			return nil, domain.ErrUnavailable
		}
		result = append(result, json.RawMessage(raw))
	}
	return result, unavailable(rows.Err())
}
func (r *Repository) Entries(ctx context.Context, a domain.Actor, namespace string, q domain.Query) (domain.Page, error) {
	var result domain.Page
	e := r.within(ctx, func(tx pgx.Tx) error { var e error; result, e = list(ctx, tx, a, namespace, q); return e })
	return result, e
}
func (r *Repository) Entry(ctx context.Context, a domain.Actor, namespace, id string) (domain.Resource, error) {
	var result domain.Resource
	e := r.within(ctx, func(tx pgx.Tx) error {
		var e error
		result, e = get(ctx, tx, a, domain.Family(namespace), id, false)
		return e
	})
	return result, e
}

func (r *Repository) CatalogMedia(ctx context.Context, a domain.Actor, source, project string) (application.CatalogMedia, error) {
	var v application.CatalogMedia
	e := r.within(ctx, func(tx pgx.Tx) error {
		if e := activeProject(ctx, tx, a.OwnerID, &project); e != nil {
			return e
		}
		e := tx.QueryRow(ctx, "SELECT id,path FROM resources.catalog_media WHERE id=$1 OR path=$1", source).Scan(&v.ID, &v.Path)
		if errors.Is(e, pgx.ErrNoRows) {
			return domain.ErrNotFound
		}
		return unavailable(e)
	})
	return v, e
}
