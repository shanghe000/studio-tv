package product

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/execution/domain"
)

type appCatalog struct{ pool *pgxpool.Pool }

func (a appCatalog) Definition(ctx context.Context, owner, id string) (execution.AppDefinition, error) {
	var result execution.AppDefinition
	var content []byte
	err := a.pool.QueryRow(ctx, "SELECT id,name,revision,content FROM resources.items WHERE id=$1 AND family='APP' AND deleted_at IS NULL AND (owner_id=$2 OR scope='SYSTEM')", id, owner).Scan(&result.ID, &result.Name, &result.Revision, &content)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, domain.ErrNotFound
	}
	if err != nil {
		return result, err
	}
	var form struct {
		Fields []execution.AppField `json:"inputNodes"`
	}
	if json.Unmarshal(content, &form) != nil || form.Fields == nil {
		return result, domain.ErrInvalid
	}
	result.Fields = form.Fields
	return result, nil
}
