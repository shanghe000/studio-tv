package http

import (
	"github.com/go-chi/chi/v5"
	"net/http"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/resources/domain"
)

func (h handler) preferences(w http.ResponseWriter, r *http.Request) error {
	if _, e := values(r); e != nil {
		return e
	}
	v, e := h.s.Store.Preferences(r.Context(), actor(r))
	if e != nil {
		return e
	}
	return output(w, r, 200, v.Revision, v)
}
func (h handler) updatePreferences(w http.ResponseWriter, r *http.Request) error {
	var v domain.PreferenceInput
	if e := httpapi.Decode(w, r, &v); e != nil {
		return e
	}
	if e := v.Validate(); e != nil {
		return e
	}
	m, e := mutation(r, v, true, false)
	if e != nil {
		return e
	}
	result, e := h.s.Store.UpdatePreferences(r.Context(), actor(r), v, m)
	if e != nil {
		return e
	}
	return output(w, r, 200, result.Revision, result)
}
func (h handler) tags(w http.ResponseWriter, r *http.Request) error {
	if _, e := values(r); e != nil {
		return e
	}
	v, e := h.s.Store.Tags(r.Context(), actor(r))
	if e != nil {
		return e
	}
	return output(w, r, 200, v.Revision, v)
}
func (h handler) mutateTags(op string) httpapi.Handler {
	return func(w http.ResponseWriter, r *http.Request) error {
		var t domain.Tag
		var ids []string
		var replace bool
		var body any
		id := chi.URLParam(r, "id")
		switch op {
		case "create", "update":
			var input struct {
				Name    *string `json:"name"`
				Color   *string `json:"color"`
				Visible *bool   `json:"visible"`
			}
			if e := httpapi.Decode(w, r, &input); e != nil {
				return e
			}
			if input.Name != nil {
				t.Name = *input.Name
				if !domain.Text(t.Name, 60, true) {
					return domain.ErrInvalid
				}
			}
			if input.Color != nil {
				t.Color = *input.Color
				test := domain.Tag{Name: "validation", Color: t.Color}
				if test.Validate() != nil {
					return domain.ErrInvalid
				}
			}
			if input.Visible != nil {
				t.Visible = *input.Visible
				t.HasVisibility = true
			}
			if op == "create" {
				if e := t.Validate(); e != nil {
					return e
				}
			} else if input.Name == nil && input.Color == nil && input.Visible == nil {
				return domain.ErrInvalid
			}
			body = input

		case "order":
			var input struct {
				IDs []string `json:"ids"`
			}
			if e := httpapi.Decode(w, r, &input); e != nil {
				return e
			}
			if input.IDs == nil || len(input.IDs) > 100 {
				return domain.ErrInvalid
			}
			ids = input.IDs
			body = input
		case "preset":
			var input struct {
				Preset  string `json:"preset"`
				Replace bool   `json:"replace"`
			}
			if e := httpapi.Decode(w, r, &input); e != nil {
				return e
			}
			if !domain.ID(input.Preset) {
				return domain.ErrInvalid
			}
			id = input.Preset
			replace = input.Replace
			body = input
		case "delete":
			if !domain.ID(id) {
				return domain.ErrInvalid
			}
		}
		m, e := mutation(r, body, true, op == "create" || op == "preset")
		if e != nil {
			return e
		}
		v, e := h.s.Store.MutateTags(r.Context(), actor(r), op, id, t, ids, replace, m)
		if e != nil {
			return e
		}
		return output(w, r, 200, v.Revision, v)
	}
}
