// Package application defines explicit product resource ports. Runtime configuration is supplied by composition.
package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/resources/domain"
	"strings"
)

type Mutation struct {
	Expected int64
	Key      string
	Hash     string
}

func Key(key string) error {
	v, e := uuid.Parse(key)
	if e != nil || len(key) != 36 || strings.ToLower(key) != v.String() {
		return domain.ErrInvalid
	}
	return nil
}
func Command(expected int64, key string, body any) (Mutation, error) {
	if key != "" {
		if e := Key(key); e != nil {
			return Mutation{}, e
		}
	}
	raw, e := json.Marshal(body)
	if e != nil {
		return Mutation{}, domain.ErrInvalid
	}
	var normalized any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&normalized) != nil {
		return Mutation{}, domain.ErrInvalid
	}
	raw, e = json.Marshal(normalized)
	if e != nil {
		return Mutation{}, domain.ErrInvalid
	}
	h := sha256.Sum256(raw)
	return Mutation{expected, strings.ToLower(key), hex.EncodeToString(h[:])}, nil
}

type ResourceRepository interface {
	List(context.Context, domain.Actor, domain.Family, domain.Query) (domain.Page, error)
	Get(context.Context, domain.Actor, domain.Family, string) (domain.Resource, error)
	Save(context.Context, domain.Actor, domain.Family, string, domain.Input, Mutation) (domain.Resource, error)
	Delete(context.Context, domain.Actor, domain.Family, string, Mutation) (int64, error)
	Favorite(context.Context, domain.Actor, domain.Family, string, bool, Mutation) (domain.Resource, error)
	Use(context.Context, domain.Actor, domain.Family, string, *string, *string, Mutation) (domain.Usage, error)
	History(context.Context, domain.Actor, string, domain.Query) ([]domain.Usage, int64, error)
}
type CatalogRepository interface {
	Categories(context.Context, string, map[string]string) ([]json.RawMessage, error)
	Values(context.Context, string, []string) ([]json.RawMessage, error)
	Entries(context.Context, domain.Actor, string, domain.Query) (domain.Page, error)
	Entry(context.Context, domain.Actor, string, string) (domain.Resource, error)
}
type PreferencesRepository interface {
	Preferences(context.Context, domain.Actor) (domain.Preferences, error)
	UpdatePreferences(context.Context, domain.Actor, domain.PreferenceInput, Mutation) (domain.Preferences, error)
	Tags(context.Context, domain.Actor) (domain.Tags, error)
	MutateTags(context.Context, domain.Actor, string, string, domain.Tag, []string, bool, Mutation) (domain.Tags, error)
}
type StudioRepository interface {
	StudioList(context.Context, domain.Actor, domain.Query) ([]domain.StudioProject, int64, error)
	StudioGet(context.Context, domain.Actor, string) (domain.StudioProject, error)
	StudioSave(context.Context, domain.Actor, string, domain.StudioInput, Mutation) (domain.StudioProject, error)
	StudioDelete(context.Context, domain.Actor, string, Mutation) (int64, error)
	File(context.Context, domain.Actor, string, string) (domain.StudioFile, error)
	WriteFiles(context.Context, domain.Actor, string, string, []domain.FileWrite, string, Mutation) (domain.StudioProject, error)
	StudioSessions(context.Context, domain.Actor, string) ([]json.RawMessage, error)
	BindSession(context.Context, domain.Actor, string, string, Mutation) error
}
type Store interface {
	ResourceRepository
	CatalogRepository
	PreferencesRepository
	StudioRepository
}
type CatalogMedia struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}
type CatalogMediaRepository interface {
	CatalogMedia(context.Context, domain.Actor, string, string) (CatalogMedia, error)
}
type MediaImport struct {
	OwnerID        string
	ProjectID      string
	SourcePath     string
	IdempotencyKey string
	RequestHash    string
}
type MaterializedAsset struct {
	AssetID string `json:"assetId"`
}

// MediaMaterializer belongs to the core asset lane. Only an audited internal catalog path is passed.
type MediaMaterializer interface {
	ImportCatalogMedia(context.Context, MediaImport) (MaterializedAsset, error)
}
type Service struct {
	Store   Store
	Media   MediaMaterializer
	History CreationHistory
}

func NewWithMedia(store Store, media MediaMaterializer) (*Service, error) {
	s, e := New(store)
	if e != nil {
		return nil, e
	}
	s.Media = media
	return s, nil
}
func (s *Service) ImportMedia(ctx context.Context, a domain.Actor, source, project string, m Mutation) (MaterializedAsset, error) {
	if e := a.Validate(); e != nil {
		return MaterializedAsset{}, e
	}
	if !domain.ID(project) || !domain.Text(source, 512, true) || Key(m.Key) != nil {
		return MaterializedAsset{}, domain.ErrInvalid
	}
	repo, ok := s.Store.(CatalogMediaRepository)
	if !ok {
		return MaterializedAsset{}, domain.ErrUnsupported
	}
	v, e := repo.CatalogMedia(ctx, a, source, project)
	if e != nil {
		return MaterializedAsset{}, e
	}
	if s.Media == nil {
		return MaterializedAsset{}, domain.ErrUnsupported
	}
	return s.Media.ImportCatalogMedia(ctx, MediaImport{a.OwnerID, project, v.Path, m.Key, m.Hash})
}

func New(store Store) (*Service, error) {
	if store == nil {
		return nil, errors.New("resource repositories are required")
	}
	return &Service{Store: store}, nil
}
func (s *Service) List(ctx context.Context, a domain.Actor, f domain.Family, q domain.Query) (domain.Page, error) {
	if e := a.Validate(); e != nil {
		return domain.Page{}, e
	}
	if !f.Valid() {
		return domain.Page{}, domain.ErrInvalid
	}
	q.Keyword = strings.TrimSpace(q.Keyword)
	if e := q.Validate(); e != nil {
		return domain.Page{}, e
	}
	return s.Store.List(ctx, a, f, q)
}
func (s *Service) Get(ctx context.Context, a domain.Actor, f domain.Family, id string) (domain.Resource, error) {
	if e := a.Validate(); e != nil {
		return domain.Resource{}, e
	}
	if !f.Valid() || !domain.ID(id) {
		return domain.Resource{}, domain.ErrInvalid
	}
	return s.Store.Get(ctx, a, f, id)
}
func (s *Service) Save(ctx context.Context, a domain.Actor, f domain.Family, id string, i domain.Input, m Mutation) (domain.Resource, error) {
	if e := a.Validate(); e != nil {
		return domain.Resource{}, e
	}
	if e := i.Validate(f); e != nil {
		return domain.Resource{}, e
	}
	if id == "" {
		if Key(m.Key) != nil {
			return domain.Resource{}, domain.ErrInvalid
		}
	} else if !domain.ID(id) || m.Expected < 1 {
		return domain.Resource{}, domain.ErrInvalid
	}
	i = i.WithDefaults(f)
	return s.Store.Save(ctx, a, f, id, i, m)
}
func (s *Service) Delete(ctx context.Context, a domain.Actor, f domain.Family, id string, m Mutation) (int64, error) {
	if e := a.Validate(); e != nil {
		return 0, e
	}
	if !f.PrivateWritable() || !domain.ID(id) || m.Expected < 1 {
		return 0, domain.ErrInvalid
	}
	return s.Store.Delete(ctx, a, f, id, m)
}
func (s *Service) Favorite(ctx context.Context, a domain.Actor, f domain.Family, id string, v bool, m Mutation) (domain.Resource, error) {
	if e := a.Validate(); e != nil {
		return domain.Resource{}, e
	}
	if !f.Valid() || !domain.ID(id) || m.Expected < 1 {
		return domain.Resource{}, domain.ErrInvalid
	}
	return s.Store.Favorite(ctx, a, f, id, v, m)
}
func (s *Service) Use(ctx context.Context, a domain.Actor, f domain.Family, id string, project, node *string, m Mutation) (domain.Usage, error) {
	if e := a.Validate(); e != nil {
		return domain.Usage{}, e
	}
	if !f.Valid() || !domain.ID(id) || Key(m.Key) != nil || project != nil && !domain.ID(*project) || node != nil && (!domain.ID(*node) || project == nil) {
		return domain.Usage{}, domain.ErrInvalid
	}
	return s.Store.Use(ctx, a, f, id, project, node, m)
}

// CreationHistory is supplied by the root execution/media lane. Usage receipts are not completed creations.
type Creation struct {
	ID                   string `json:"id"`
	TaskID               string `json:"taskId"`
	AssetID              string `json:"assetId"`
	CreationShowreelInfo struct {
		FileURL string `json:"fileUrl"`
	} `json:"creationShowreelInfo"`
}
type CreationPage struct {
	Records []Creation `json:"records"`
	Total   int64      `json:"total"`
}
type CreationHistory interface {
	Creations(context.Context, domain.Actor, string, domain.Query) (CreationPage, error)
}
