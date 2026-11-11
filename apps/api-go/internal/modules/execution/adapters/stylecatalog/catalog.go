// Package stylecatalog resolves the four STUDIO-authored canvas styles from an
// immutable, audited SYSTEM catalog. It never trusts client prompt text.
package stylecatalog

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"reflect"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/execution/domain"
)

//go:embed seed/styles.json
var seedJSON []byte

type seed struct {
	Version      string                        `json:"version"`
	SourceName   string                        `json:"sourceName"`
	SourceSHA256 string                        `json:"sourceSHA256"`
	Styles       []application.StyleDefinition `json:"styles"`
}

type content struct {
	SchemaVersion string                      `json:"schemaVersion"`
	Preset        application.StyleDefinition `json:"preset"`
	PrefixPrompt  string                      `json:"prefixPrompt"`
	SuffixPrompt  string                      `json:"suffixPrompt"`
	PromptType    string                      `json:"promptType"`
	MediaScope    string                      `json:"mediaScope"`
}

type Catalog struct {
	pool *pgxpool.Pool
	seed seed
	hash string
}

func New(pool *pgxpool.Pool) (*Catalog, error) {
	if pool == nil {
		return nil, errors.New("style catalog pool is required")
	}
	var data seed
	if strict(seedJSON, &data) != nil || data.Version != "studio-style-library-1" || len(data.SourceSHA256) != 64 || len(data.Styles) != 4 {
		return nil, domain.ErrInvalid
	}
	sum := sha256.Sum256(seedJSON)
	return &Catalog{pool: pool, seed: data, hash: hex.EncodeToString(sum[:])}, nil
}

func strict(body []byte, dst any) error {
	d := json.NewDecoder(bytes.NewReader(body))
	d.DisallowUnknownFields()
	if err := d.Decode(dst); err != nil {
		return err
	}
	var extra any
	if !errors.Is(d.Decode(&extra), io.EOF) {
		return domain.ErrInvalid
	}
	return nil
}

func expectedContent(def application.StyleDefinition) content {
	return content{SchemaVersion: "1", Preset: def, PrefixPrompt: def.Prompt, PromptType: "STYLE", MediaScope: "IMAGE"}
}

// Import is an explicit startup operation. Existing identities are never
// overwritten; a collision, changed revision or changed content fails closed.
func (c *Catalog) Import(ctx context.Context) error {
	tx, err := c.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", c.seed.Version); err != nil {
		return err
	}
	source := c.seed.SourceName + " (sha256:" + c.seed.SourceSHA256 + ")"
	if _, err = tx.Exec(ctx, `INSERT INTO resources.catalog_imports(version,source_hash,source_name,row_count) VALUES($1,$2,$3,4) ON CONFLICT(version) DO NOTHING`, c.seed.Version, c.hash, source); err != nil {
		return err
	}
	var hash, name string
	var count int
	if err = tx.QueryRow(ctx, "SELECT source_hash,source_name,row_count FROM resources.catalog_imports WHERE version=$1", c.seed.Version).Scan(&hash, &name, &count); err != nil {
		return err
	}
	if hash != c.hash || name != source || count != 4 {
		return domain.ErrConflict
	}
	for _, def := range c.seed.Styles {
		body, err := json.Marshal(expectedContent(def))
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO resources.items(id,family,scope,name,content,cover_url,revision,version,source_version) VALUES($1,'PROMPT','SYSTEM',$2,$3,$4,1,$5,$5) ON CONFLICT(id) DO NOTHING`, def.ID, def.Label, body, def.CoverURL, c.seed.Version); err != nil {
			return err
		}
		if _, err = c.definition(ctx, tx, def.ID); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if err := c.importImageRecipes(ctx); err != nil {
		return err
	}
	return c.importPresetCategories(ctx)
}

func (c *Catalog) Definition(ctx context.Context, owner, id string) (application.StyleDefinition, error) {
	if owner == "" {
		return application.StyleDefinition{}, domain.ErrNotFound
	}
	def, err := c.definition(ctx, c.pool, id)
	if errors.Is(err, domain.ErrNotFound) {
		return c.ownerDefinition(ctx, owner, id)
	}
	return def, err
}

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (c *Catalog) definition(ctx context.Context, q querier, id string) (application.StyleDefinition, error) {
	var expected application.StyleDefinition
	for _, def := range c.seed.Styles {
		if def.ID == id {
			expected = def
		}
	}
	if expected.ID == "" {
		return expected, domain.ErrNotFound
	}
	var name, cover, hash string
	var revision int64
	var raw []byte
	err := q.QueryRow(ctx, `SELECT i.name,i.cover_url,i.revision,i.content,c.source_hash FROM resources.items i JOIN resources.catalog_imports c ON c.version=i.source_version WHERE i.id=$1 AND i.family='PROMPT' AND i.scope='SYSTEM' AND i.owner_id IS NULL AND i.deleted_at IS NULL AND i.version=$2 AND i.source_version=$2`, id, c.seed.Version).Scan(&name, &cover, &revision, &raw, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.StyleDefinition{}, domain.ErrNotFound
	}
	if err != nil {
		return application.StyleDefinition{}, err
	}
	var stored content
	if strict(raw, &stored) != nil || !reflect.DeepEqual(stored, expectedContent(expected)) || name != expected.Label || cover != expected.CoverURL || revision != expected.Revision || hash != c.hash {
		return application.StyleDefinition{}, domain.ErrConflict
	}
	return expected, nil
}
