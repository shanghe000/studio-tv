package stylecatalog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"

	"studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/execution/domain"
)

type presetCategory struct {
	ID          int              `json:"id"`
	Name        string           `json:"name"`
	Children    []presetCategory `json:"children"`
	ResourceIDs []string         `json:"resourceIds,omitempty"`
}

// This is presentation metadata, versioned independently of immutable recipe
// content. Native pickers require numeric leaf IDs before they issue a list call.
func (c *Catalog) importPresetCategories(ctx context.Context) error {
	const version = "studio-image-preset-categories-1"
	categories := []presetCategory{
		{ID: 930001, Name: "风格库", Children: []presetCategory{{ID: 930011, Name: "动画与插画", Children: []presetCategory{}}, {ID: 930012, Name: "写实", Children: []presetCategory{}}}},
		{ID: 930002, Name: "滤镜", Children: []presetCategory{}},
		{ID: 930003, Name: "功能", Children: []presetCategory{}},
		{ID: 930004, Name: "相机", Children: []presetCategory{}},
	}
	assignments := map[string][]string{}
	for _, def := range c.seed.Styles {
		id := "930012"
		if def.ID == "anime_illustration" {
			id = "930011"
		}
		assignments[def.ID] = []string{id}
	}
	for _, def := range application.PublishedImagePresets() {
		if id, ok := map[string]string{"filter": "930002", "function": "930003", "camera": "930004"}[def.Key]; ok {
			assignments[def.ID] = []string{id}
		}
	}
	var assign func(*presetCategory)
	assign = func(cat *presetCategory) {
		for id, cats := range assignments {
			if cats[0] == fmt.Sprint(cat.ID) {
				cat.ResourceIDs = append(cat.ResourceIDs, id)
			}
		}
		sort.Strings(cat.ResourceIDs)
		for i := range cat.Children {
			assign(&cat.Children[i])
		}
	}
	for i := range categories {
		assign(&categories[i])
	}
	encoded, _ := json.Marshal(struct {
		Categories  []presetCategory
		Assignments map[string][]string
	}{categories, assignments})
	sum := sha256.Sum256(encoded)
	hash := hex.EncodeToString(sum[:])
	tx, err := c.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", version); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO resources.catalog_imports(version,source_hash,source_name,row_count) VALUES($1,$2,'STUDIO public image preset navigation metadata',13) ON CONFLICT(version) DO NOTHING`, version, hash); err != nil {
		return err
	}
	var stored string
	if err = tx.QueryRow(ctx, "SELECT source_hash FROM resources.catalog_imports WHERE version=$1", version).Scan(&stored); err != nil {
		return err
	}
	if stored != hash {
		return domain.ErrConflict
	}
	var insert func(presetCategory, any, int) error
	insert = func(cat presetCategory, parent any, sort int) error {
		raw, _ := json.Marshal(cat)
		id := fmt.Sprint(cat.ID)
		if _, err := tx.Exec(ctx, `INSERT INTO resources.categories(namespace,id,parent_id,name,context,content,sort_order,source_version) VALUES('PROMPT',$1,$2,$3,'{"scope":"IMAGE"}',$4,$5,$6) ON CONFLICT(namespace,id) DO NOTHING`, id, parent, cat.Name, raw, sort, version); err != nil {
			return err
		}
		var valid bool
		if err := tx.QueryRow(ctx, `SELECT source_version=$2 AND content=$3::jsonb AND context='{"scope":"IMAGE"}'::jsonb AND parent_id IS NOT DISTINCT FROM $4 FROM resources.categories WHERE namespace='PROMPT' AND id=$1`, id, version, raw, parent).Scan(&valid); err != nil {
			return err
		}
		if !valid {
			return domain.ErrConflict
		}
		for i, child := range cat.Children {
			if err := insert(child, id, i); err != nil {
				return err
			}
		}
		return nil
	}
	for i, cat := range categories {
		if err := insert(cat, nil, i); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
