package stylecatalog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/execution/domain"
)

// Independent version: importing these recipes never rewrites the v1 style catalog.
func (c *Catalog) importImageRecipes(ctx context.Context) error {
	const version = "studio-image-recipes-1"
	defs := application.PublishedImagePresets()
	encoded, _ := json.Marshal(defs)
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
	if _, err = tx.Exec(ctx, `INSERT INTO resources.catalog_imports(version,source_hash,source_name,row_count) VALUES($1,$2,'STUDIO authored image recipes v1; public nine presets and original character labels',$3) ON CONFLICT(version) DO NOTHING`, version, hash, len(defs)); err != nil {
		return err
	}
	var storedHash string
	if err = tx.QueryRow(ctx, "SELECT source_hash FROM resources.catalog_imports WHERE version=$1", version).Scan(&storedHash); err != nil {
		return err
	}
	if storedHash != hash {
		return domain.ErrConflict
	}
	tabs := []string{"basic", "face", "hair", "body", "outfit", "style"}
	labels := []string{"基础（STUDIO）", "五官（STUDIO）", "发型（STUDIO）", "体型（STUDIO）", "穿搭（STUDIO）", "风格（STUDIO）"}
	sections := []string{"presentation", "expression", "length", "build", "wardrobe", "rendering"}
	for i, tab := range tabs {
		id := fmt.Sprint(910001 + i)
		body, _ := json.Marshal(map[string]any{"id": 910001 + i, "name": labels[i], "prop": map[string]any{"tab": tab, "sectionKey": sections[i]}, "children": []any{}})
		if _, err = tx.Exec(ctx, `INSERT INTO resources.categories(namespace,id,name,context,content,sort_order,source_version) VALUES('PROMPT',$1,$2,'{"scope":"IMAGE","menuType":"role_design"}',$3,$4,$5) ON CONFLICT(namespace,id) DO NOTHING`, id, labels[i], body, i, version); err != nil {
			return err
		}
		var valid bool
		if err = tx.QueryRow(ctx, `SELECT source_version=$2 AND content=$3::jsonb AND context='{"scope":"IMAGE","menuType":"role_design"}'::jsonb AND parent_id IS NULL FROM resources.categories WHERE namespace='PROMPT' AND id=$1`, id, version, body).Scan(&valid); err != nil {
			return err
		}
		if !valid {
			return domain.ErrConflict
		}
	}
	portrait := application.PortraitRecipes()
	var categoryNode func(int) map[string]any
	categoryNode = func(id int) map[string]any {
		for _, cat := range portrait.Categories {
			if cat.ID == id {
				children := []any{}
				for _, child := range portrait.Categories {
					if child.ParentID != nil && *child.ParentID == id {
						children = append(children, categoryNode(child.ID))
					}
				}
				return map[string]any{"id": id, "name": cat.Name + "（PF语义）", "prop": cat.Prop, "children": children}
			}
		}
		return nil
	}
	for i, cat := range portrait.Categories {
		body, _ := json.Marshal(categoryNode(cat.ID))
		var parent any
		if cat.ParentID != nil {
			parent = fmt.Sprint(*cat.ParentID)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO resources.categories(namespace,id,parent_id,name,context,content,sort_order,source_version) VALUES('PROMPT',$1,$2,$3,'{"scope":"IMAGE","menuType":"portrait"}',$4,$5,$6) ON CONFLICT(namespace,id) DO NOTHING`, fmt.Sprint(cat.ID), parent, cat.Name+"（PF语义）", body, i, version); err != nil {
			return err
		}
		var valid bool
		if err = tx.QueryRow(ctx, `SELECT source_version=$2 AND content=$3::jsonb AND context='{"scope":"IMAGE","menuType":"portrait"}'::jsonb AND parent_id IS NOT DISTINCT FROM $4 FROM resources.categories WHERE namespace='PROMPT' AND id=$1`, fmt.Sprint(cat.ID), version, body, parent).Scan(&valid); err != nil {
			return err
		}
		if !valid {
			return domain.ErrConflict
		}
	}
	for _, def := range defs {
		promptType, menuType := "PROMPT", ""
		cat := []string{}
		key := ""
		body := map[string]any{"schemaVersion": "1", "preset": def, "prefixPrompt": def.Prompt, "suffixPrompt": "", "promptType": promptType, "mediaScope": "IMAGE", "menuType": menuType, "description": "STUDIO owned recipe; not a recovered hidden original-site prompt."}
		if strings.HasPrefix(def.Key, "roleDesign:") {
			parts := strings.Split(def.Key, ":")
			for i, tab := range tabs {
				if parts[1] == tab {
					cat = []string{fmt.Sprint(910001 + i)}
					body["categoryId"] = 910001 + i
				}
			}
			key = strings.TrimSuffix(strings.TrimPrefix(def.ID, "studio-role-"+parts[1]+"-"), "-v1")
			body["menuType"] = "role_design"
			body["promptCode"] = def.PromptCode
			body["prop"] = map[string]string{"key": key}
			body["promptHidden"] = false
		}
		for _, item := range portrait.Items {
			if item.Definition.ID == def.ID {
				cat = []string{fmt.Sprint(item.CategoryID)}
				body["menuType"] = "portrait"
				body["promptCode"] = def.PromptCode
				body["promptHidden"] = false
				body["prop"] = item.Prop
				body["categoryId"] = item.CategoryID
			}
		}
		raw, _ := json.Marshal(body)
		if _, err = tx.Exec(ctx, `INSERT INTO resources.items(id,family,scope,name,description,content,category_ids,revision,version,source_version) VALUES($1,'PROMPT','SYSTEM',$2,'STUDIO 自有公开配方；不代表原站隐藏提示词。',$3,$4,1,$5,$5) ON CONFLICT(id) DO NOTHING`, def.ID, def.Label, raw, cat, version); err != nil {
			return err
		}
		var matched bool
		if err = tx.QueryRow(ctx, `SELECT content=$2::jsonb AND revision=1 AND family='PROMPT' AND scope='SYSTEM' AND source_version=$3 AND version=$3 AND deleted_at IS NULL AND name=$4 FROM resources.items WHERE id=$1`, def.ID, raw, version, def.Label).Scan(&matched); err != nil {
			return err
		}
		if !matched {
			return domain.ErrConflict
		}
	}
	return tx.Commit(ctx)
}
