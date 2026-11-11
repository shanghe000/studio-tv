package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/modules/resources/application"
	"studiotv.local/service/api/internal/modules/resources/domain"
)

func preferenceRoot(ctx context.Context, tx pgx.Tx, a domain.Actor) error {
	if e := a.Validate(); e != nil {
		return e
	}
	if e := lockOwner(ctx, tx, a.OwnerID, "preferences"); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, "INSERT INTO resources.preferences(owner_id) VALUES($1) ON CONFLICT DO NOTHING", a.OwnerID)
	return unavailable(e)
}
func preferences(ctx context.Context, tx pgx.Tx, a domain.Actor) (domain.Preferences, error) {
	v := domain.Preferences{UserID: a.OwnerID}
	e := tx.QueryRow(ctx, "SELECT revision,shortcut_key_config,buzzy_pop_flag FROM resources.preferences WHERE owner_id=$1", a.OwnerID).Scan(&v.Revision, &v.ShortcutKeyConfig, &v.BuzzyPopFlag)
	return v, unavailable(e)
}
func (r *Repository) Preferences(ctx context.Context, a domain.Actor) (domain.Preferences, error) {
	var v domain.Preferences
	e := r.within(ctx, func(tx pgx.Tx) error {
		if e := preferenceRoot(ctx, tx, a); e != nil {
			return e
		}
		var e error
		v, e = preferences(ctx, tx, a)
		return e
	})
	return v, e
}
func (r *Repository) UpdatePreferences(ctx context.Context, a domain.Actor, i domain.PreferenceInput, m application.Mutation) (domain.Preferences, error) {
	var v domain.Preferences
	if e := i.Validate(); e != nil {
		return v, e
	}
	e := r.within(ctx, func(tx pgx.Tx) error {
		if e := preferenceRoot(ctx, tx, a); e != nil {
			return e
		}
		current, e := preferences(ctx, tx, a)
		if e != nil {
			return e
		}
		if current.Revision != m.Expected {
			return &domain.VersionConflict{Current: current.Revision}
		}
		config := current.ShortcutKeyConfig
		if len(i.ShortcutKeyConfig) > 0 {
			config = i.ShortcutKeyConfig
		}
		flag := current.BuzzyPopFlag
		if i.BuzzyPopFlag != nil {
			flag = *i.BuzzyPopFlag
		}
		_, e = tx.Exec(ctx, "UPDATE resources.preferences SET revision=revision+1,shortcut_key_config=$2,buzzy_pop_flag=$3 WHERE owner_id=$1", a.OwnerID, config, flag)
		if e != nil {
			return domain.ErrUnavailable
		}
		v, e = preferences(ctx, tx, a)
		return e
	})
	return v, e
}
func tags(ctx context.Context, tx pgx.Tx, a domain.Actor) (domain.Tags, error) {
	v := domain.Tags{Tags: []domain.Tag{}}
	if e := tx.QueryRow(ctx, "SELECT tag_revision FROM resources.preferences WHERE owner_id=$1", a.OwnerID).Scan(&v.Revision); e != nil {
		return v, domain.ErrUnavailable
	}
	rows, e := tx.Query(ctx, "SELECT id,name,color,sort_order,visible FROM resources.tags WHERE owner_id=$1 ORDER BY sort_order,id", a.OwnerID)
	if e != nil {
		return v, domain.ErrUnavailable
	}
	defer rows.Close()
	for rows.Next() {
		var t domain.Tag
		if rows.Scan(&t.ID, &t.Name, &t.Color, &t.SortOrder, &t.Visible) != nil {
			return v, domain.ErrUnavailable
		}
		v.Tags = append(v.Tags, t)
	}
	return v, unavailable(rows.Err())
}
func (r *Repository) Tags(ctx context.Context, a domain.Actor) (domain.Tags, error) {
	var v domain.Tags
	e := r.within(ctx, func(tx pgx.Tx) error {
		if e := preferenceRoot(ctx, tx, a); e != nil {
			return e
		}
		var e error
		v, e = tags(ctx, tx, a)
		return e
	})
	return v, e
}
func (r *Repository) MutateTags(ctx context.Context, a domain.Actor, op, id string, t domain.Tag, ids []string, replace bool, m application.Mutation) (domain.Tags, error) {
	var result domain.Tags
	e := r.within(ctx, func(tx pgx.Tx) error {
		if e := preferenceRoot(ctx, tx, a); e != nil {
			return e
		}
		replayed, e := receipt(ctx, tx, a, "tag:"+op, m, &result)
		if e != nil {
			return e
		}
		if replayed {
			return nil
		}
		current, e := tags(ctx, tx, a)
		if e != nil {
			return e
		}
		if current.Revision != m.Expected {
			return &domain.VersionConflict{Current: current.Revision}
		}
		found := false
		names := map[string]string{}
		for _, v := range current.Tags {
			if v.ID == id {
				found = true
			}
			names[v.Name] = v.ID
		}
		switch op {
		case "create", "update":
			if op == "update" {
				if !found {
					return domain.ErrNotFound
				}
				for _, prior := range current.Tags {
					if prior.ID == id {
						if t.Name == "" {
							t.Name = prior.Name
						}
						if t.Color == "" {
							t.Color = prior.Color
						}
						if !t.HasVisibility {
							t.Visible = prior.Visible
						}
					}
				}
			} else if !t.HasVisibility {
				t.Visible = true
			}
			if t.Validate() != nil {
				return domain.ErrInvalid
			}
			if names[t.Name] != "" && names[t.Name] != id {
				return domain.ErrInvalid
			}
			if op == "create" {
				if len(current.Tags) >= 100 {
					return domain.ErrInvalid
				}
				id = "tag_" + uuid.NewString()
				_, e = tx.Exec(ctx, "INSERT INTO resources.tags(id,owner_id,name,color,sort_order,visible) VALUES($1,$2,$3,$4,$5,$6)", id, a.OwnerID, t.Name, t.Color, len(current.Tags), t.Visible)
			} else {
				if !found {
					return domain.ErrNotFound
				}
				_, e = tx.Exec(ctx, "UPDATE resources.tags SET name=$3,color=$4,visible=$5 WHERE id=$1 AND owner_id=$2", id, a.OwnerID, t.Name, t.Color, t.Visible)
			}
		case "delete":
			if !found {
				return domain.ErrNotFound
			}
			_, e = tx.Exec(ctx, "DELETE FROM resources.tags WHERE id=$1 AND owner_id=$2", id, a.OwnerID)
		case "order":
			if len(ids) != len(current.Tags) {
				return domain.ErrInvalid
			}
			valid := map[string]bool{}
			for _, v := range current.Tags {
				valid[v.ID] = true
			}
			for n, id := range ids {
				if !valid[id] {
					return domain.ErrInvalid
				}
				delete(valid, id)
				if _, e = tx.Exec(ctx, "UPDATE resources.tags SET sort_order=$3 WHERE id=$1 AND owner_id=$2", id, a.OwnerID, n); e != nil {
					return domain.ErrUnavailable
				}
			}
		case "preset":
			var raw []byte
			e = tx.QueryRow(ctx, "SELECT content FROM resources.catalog_values WHERE namespace='TAG_PRESET' AND key=$1", id).Scan(&raw)
			if errors.Is(e, pgx.ErrNoRows) {
				return domain.ErrUnsupported
			}
			if e != nil {
				return domain.ErrUnavailable
			}
			var preset []domain.Tag
			if json.Unmarshal(raw, &preset) != nil || len(preset) > 100 {
				return domain.ErrUnavailable
			}
			if replace {
				if _, e = tx.Exec(ctx, "DELETE FROM resources.tags WHERE owner_id=$1", a.OwnerID); e != nil {
					return domain.ErrUnavailable
				}
				current.Tags = nil
				names = map[string]string{}
			}
			for _, v := range preset {
				if v.Validate() != nil {
					return domain.ErrUnavailable
				}
				if names[v.Name] != "" {
					continue
				}
				if len(current.Tags) >= 100 {
					return domain.ErrInvalid
				}
				_, e = tx.Exec(ctx, "INSERT INTO resources.tags(id,owner_id,name,color,sort_order) VALUES($1,$2,$3,$4,$5)", "tag_"+uuid.NewString(), a.OwnerID, v.Name, v.Color, len(current.Tags))
				if e != nil {
					return domain.ErrUnavailable
				}
				current.Tags = append(current.Tags, v)
				names[v.Name] = "preset"
			}
		default:
			return domain.ErrInvalid
		}
		if e != nil {
			return domain.ErrUnavailable
		}
		if op == "delete" {
			if _, e = tx.Exec(ctx, "WITH ordered AS(SELECT id,row_number() OVER(ORDER BY sort_order,id)-1 AS n FROM resources.tags WHERE owner_id=$1) UPDATE resources.tags t SET sort_order=o.n FROM ordered o WHERE t.id=o.id AND t.owner_id=$1", a.OwnerID); e != nil {
				return domain.ErrUnavailable
			}
		}
		_, e = tx.Exec(ctx, "UPDATE resources.preferences SET tag_revision=tag_revision+1 WHERE owner_id=$1", a.OwnerID)
		if e != nil {
			return domain.ErrUnavailable
		}
		result, e = tags(ctx, tx, a)
		if e != nil {
			return e
		}
		return saveReceipt(ctx, tx, a, "tag:"+op, m, result)
	})
	return result, e
}
