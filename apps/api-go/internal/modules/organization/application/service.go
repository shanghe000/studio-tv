package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/organization/domain"
	"strings"
)

type Mutation struct {
	Expected  int64
	Key, Hash string
}

func Key(k string) error {
	u, e := uuid.Parse(k)
	if e != nil || len(k) != 36 || strings.ToLower(k) != u.String() {
		return domain.ErrInvalid
	}
	return nil
}
func Command(expected int64, key string, body any) (Mutation, error) {
	if Key(key) != nil {
		return Mutation{}, domain.ErrInvalid
	}
	raw, e := json.Marshal(struct {
		Expected int64 `json:"expected"`
		Body     any   `json:"body"`
	}{expected, body})
	if e != nil {
		return Mutation{}, domain.ErrInvalid
	}
	h := sha256.Sum256(raw)
	return Mutation{expected, strings.ToLower(key), hex.EncodeToString(h[:])}, nil
}

type Store interface {
	Folders(context.Context, domain.Actor, domain.Query) (domain.Page, error)
	Folder(context.Context, domain.Actor, string) (domain.Folder, error)
	CreateFolder(context.Context, domain.Actor, domain.FolderInput, Mutation) (domain.Folder, error)
	RenameFolder(context.Context, domain.Actor, string, string, Mutation) (domain.Folder, error)
	DeleteFolder(context.Context, domain.Actor, string, Mutation) (domain.Deletion, error)
	Entries(context.Context, domain.Actor, domain.Query) (domain.Page, error)
	Tree(context.Context, domain.Actor, string) (domain.Tree, error)
	Membership(context.Context, domain.Actor, string) (domain.Membership, error)
	Move(context.Context, domain.Actor, string, *string, Mutation) (domain.Membership, error)
	CreateProject(context.Context, domain.Actor, string, *string, Mutation) (domain.Project, error)
	Notifications(context.Context, domain.Actor, string, int, int) (domain.NotificationPage, error)
	Notification(context.Context, domain.Actor, string) (domain.Notification, error)
	Unread(context.Context, domain.Actor) (domain.Counts, error)
	Read(context.Context, domain.Actor, []string, Mutation) (domain.Counts, error)
	DeleteNotification(context.Context, domain.Actor, string, Mutation) (domain.NotificationDeletion, error)
	DeleteNotifications(context.Context, domain.Actor, []string, Mutation) (domain.BatchDeletion, error)
}
type Service struct{ Store Store }

func New(s Store) (*Service, error) {
	if s == nil {
		return nil, errors.New("organization store required")
	}
	return &Service{s}, nil
}
func (s *Service) Folders(c context.Context, a domain.Actor, q domain.Query) (domain.Page, error) {
	if e := a.Validate(); e != nil {
		return domain.Page{}, e
	}
	if e := q.Validate(); e != nil {
		return domain.Page{}, e
	}
	return s.Store.Folders(c, a, q)
}
func (s *Service) Folder(c context.Context, a domain.Actor, id string) (domain.Folder, error) {
	if e := a.Validate(); e != nil {
		return domain.Folder{}, e
	}
	if !domain.ID(id) {
		return domain.Folder{}, domain.ErrInvalid
	}
	return s.Store.Folder(c, a, id)
}
func (s *Service) CreateFolder(c context.Context, a domain.Actor, i domain.FolderInput, m Mutation) (domain.Folder, error) {
	if e := a.Validate(); e != nil {
		return domain.Folder{}, e
	}
	i.Name = strings.TrimSpace(i.Name)
	if i.Validate() != nil || Key(m.Key) != nil {
		return domain.Folder{}, domain.ErrInvalid
	}
	return s.Store.CreateFolder(c, a, i, m)
}
func (s *Service) RenameFolder(c context.Context, a domain.Actor, id, name string, m Mutation) (domain.Folder, error) {
	if e := a.Validate(); e != nil {
		return domain.Folder{}, e
	}
	name = strings.TrimSpace(name)
	if !domain.ID(id) || !domain.Text(name, 100, true) || m.Expected < 1 || Key(m.Key) != nil {
		return domain.Folder{}, domain.ErrInvalid
	}
	return s.Store.RenameFolder(c, a, id, name, m)
}
func (s *Service) DeleteFolder(c context.Context, a domain.Actor, id string, m Mutation) (domain.Deletion, error) {
	if e := a.Validate(); e != nil {
		return domain.Deletion{}, e
	}
	if !domain.ID(id) || m.Expected < 1 || Key(m.Key) != nil {
		return domain.Deletion{}, domain.ErrInvalid
	}
	return s.Store.DeleteFolder(c, a, id, m)
}
func (s *Service) Entries(c context.Context, a domain.Actor, q domain.Query) (domain.Page, error) {
	if e := a.Validate(); e != nil {
		return domain.Page{}, e
	}
	if q.Validate() != nil {
		return domain.Page{}, domain.ErrInvalid
	}
	return s.Store.Entries(c, a, q)
}
func (s *Service) Tree(c context.Context, a domain.Actor, id string) (domain.Tree, error) {
	if e := a.Validate(); e != nil {
		return domain.Tree{}, e
	}
	if !domain.ID(id) {
		return domain.Tree{}, domain.ErrInvalid
	}
	return s.Store.Tree(c, a, id)
}
func (s *Service) Membership(c context.Context, a domain.Actor, id string) (domain.Membership, error) {
	if e := a.Validate(); e != nil {
		return domain.Membership{}, e
	}
	if !domain.ID(id) {
		return domain.Membership{}, domain.ErrInvalid
	}
	return s.Store.Membership(c, a, id)
}
func (s *Service) Move(c context.Context, a domain.Actor, id string, folder *string, m Mutation) (domain.Membership, error) {
	if e := a.Validate(); e != nil {
		return domain.Membership{}, e
	}
	if !domain.ID(id) || folder != nil && !domain.ID(*folder) || m.Expected < 1 || Key(m.Key) != nil {
		return domain.Membership{}, domain.ErrInvalid
	}
	return s.Store.Move(c, a, id, folder, m)
}
func (s *Service) CreateProject(c context.Context, a domain.Actor, name string, folder *string, m Mutation) (domain.Project, error) {
	if e := a.Validate(); e != nil {
		return domain.Project{}, e
	}
	name = strings.TrimSpace(name)
	if !domain.Text(name, 120, true) || folder != nil && !domain.ID(*folder) || Key(m.Key) != nil {
		return domain.Project{}, domain.ErrInvalid
	}
	return s.Store.CreateProject(c, a, name, folder, m)
}
func (s *Service) Notifications(c context.Context, a domain.Actor, kind string, page, size int) (domain.NotificationPage, error) {
	if e := a.Validate(); e != nil {
		return domain.NotificationPage{}, e
	}
	if !domain.NotificationType(kind) || page < 1 || page > 100000 || size < 1 || size > 100 {
		return domain.NotificationPage{}, domain.ErrInvalid
	}
	return s.Store.Notifications(c, a, kind, page, size)
}
func (s *Service) Notification(c context.Context, a domain.Actor, id string) (domain.Notification, error) {
	if e := a.Validate(); e != nil {
		return domain.Notification{}, e
	}
	if !domain.ID(id) {
		return domain.Notification{}, domain.ErrInvalid
	}
	return s.Store.Notification(c, a, id)
}
func (s *Service) Unread(c context.Context, a domain.Actor) (domain.Counts, error) {
	if e := a.Validate(); e != nil {
		return domain.Counts{}, e
	}
	return s.Store.Unread(c, a)
}
func (s *Service) Read(c context.Context, a domain.Actor, ids []string, m Mutation) (domain.Counts, error) {
	if e := a.Validate(); e != nil {
		return domain.Counts{}, e
	}
	if !domain.IDs(ids) || Key(m.Key) != nil {
		return domain.Counts{}, domain.ErrInvalid
	}
	return s.Store.Read(c, a, ids, m)
}
func (s *Service) DeleteNotification(c context.Context, a domain.Actor, id string, m Mutation) (domain.NotificationDeletion, error) {
	if e := a.Validate(); e != nil {
		return domain.NotificationDeletion{}, e
	}
	if !domain.ID(id) || m.Expected < 1 || Key(m.Key) != nil {
		return domain.NotificationDeletion{}, domain.ErrInvalid
	}
	return s.Store.DeleteNotification(c, a, id, m)
}
func (s *Service) DeleteNotifications(c context.Context, a domain.Actor, ids []string, m Mutation) (domain.BatchDeletion, error) {
	if e := a.Validate(); e != nil {
		return domain.BatchDeletion{}, e
	}
	if !domain.IDs(ids) || Key(m.Key) != nil {
		return domain.BatchDeletion{}, domain.ErrInvalid
	}
	return s.Store.DeleteNotifications(c, a, ids, m)
}
