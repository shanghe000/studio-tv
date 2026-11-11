// Package domain defines owner-scoped organization data, independent of HTTP and PostgreSQL.
package domain

import (
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var (
	ErrInvalid         = errors.New("invalid organization input")
	ErrUnauthenticated = errors.New("verified organization actor required")
	ErrNotFound        = errors.New("organization resource not found")
	ErrConflict        = errors.New("organization idempotency conflict")
	ErrUnavailable     = errors.New("organization persistence unavailable")
	ErrTooLarge        = errors.New("organization tree exceeds bounded response")
)

type VersionConflict struct{ Current int64 }

func (*VersionConflict) Error() string { return "organization revision changed" }

const MaxLevel = 3
const MaxFolders = 1000

type Actor struct{ OwnerID string }

func (a Actor) Validate() error {
	if !ID(a.OwnerID) {
		return ErrUnauthenticated
	}
	return nil
}

var ids = regexp.MustCompile(`^[A-Za-z0-9_-]{1,200}$`)

func ID(s string) bool { return ids.MatchString(s) }
func Text(s string, max int, required bool) bool {
	if !utf8.ValidString(s) || utf8.RuneCountInString(s) > max || required && strings.TrimSpace(s) == "" {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

type Folder struct {
	ID                   string    `json:"id"`
	ParentID             *string   `json:"parentId"`
	Name                 string    `json:"name"`
	Revision             int64     `json:"revision"`
	Level                int       `json:"level"`
	MaxLevel             int       `json:"maxLevel"`
	AllowCreateSubFolder bool      `json:"allowCreateSubFolder"`
	ItemCount            int64     `json:"itemCount"`
	Total                int64     `json:"total"`
	ByteSize             int64     `json:"byteSize"`
	CreatedAt            time.Time `json:"createdAt"`
	UpdatedAt            time.Time `json:"updatedAt"`
}
type FolderInput struct {
	Name     string  `json:"name"`
	ParentID *string `json:"parentId"`
}

func (i FolderInput) Validate() error {
	if !Text(i.Name, 100, true) || i.ParentID != nil && !ID(*i.ParentID) {
		return ErrInvalid
	}
	return nil
}

type Project struct {
	ID           string    `json:"id"`
	OwnerID      string    `json:"ownerId"`
	TeamID       *string   `json:"teamId"`
	CoverAssetID *string   `json:"coverAssetId"`
	Name         string    `json:"name"`
	Pinned       bool      `json:"pinned"`
	Revision     int64     `json:"revision"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}
type Membership struct {
	ProjectID string  `json:"projectId"`
	FolderID  *string `json:"folderId"`
	Revision  int64   `json:"revision"`
}
type Entry struct {
	Type     string   `json:"type"`
	Folder   *Folder  `json:"folder,omitempty"`
	Project  *Project `json:"project,omitempty"`
	FolderID *string  `json:"folderId"`
	ByteSize int64    `json:"byteSize"`
}
type Query struct {
	Page, Size           int
	ParentID             *string
	Keyword, Scope, Sort string
}

func (q Query) Validate() error {
	if q.Page < 1 || q.Page > 100000 || q.Size < 1 || q.Size > 100 || q.ParentID != nil && !ID(*q.ParentID) || !Text(q.Keyword, 200, false) {
		return ErrInvalid
	}
	switch q.Scope {
	case "", "ALL", "FOLDER", "CANVAS":
	default:
		return ErrInvalid
	}
	switch q.Sort {
	case "", "UPDATED_DESC", "UPDATED_ASC", "CREATED_DESC", "CREATED_ASC", "NAME_ASC", "NAME_DESC", "SIZE_ASC", "SIZE_DESC":
	default:
		return ErrInvalid
	}
	return nil
}
func (q Query) Offset() int64 { return int64(q.Page-1) * int64(q.Size) }

type Page struct {
	Records  []Entry `json:"records"`
	Page     int     `json:"page"`
	Current  int     `json:"current"`
	Size     int     `json:"size"`
	Total    int64   `json:"total"`
	Pages    int64   `json:"pages"`
	HasNext  bool    `json:"hasNext"`
	Revision int64   `json:"revision"`
}

func NewPage(q Query, records []Entry, total, revision int64) Page {
	return Page{records, q.Page, q.Page, q.Size, total, (total + int64(q.Size) - 1) / int64(q.Size), q.Offset()+int64(len(records)) < total, revision}
}

type TreeNode struct {
	ID                   *string     `json:"id"`
	FolderID             *string     `json:"folderId"`
	ParentID             *string     `json:"parentId,omitempty"`
	CanvasID             string      `json:"canvasId,omitempty"`
	Type                 string      `json:"type"`
	Name                 string      `json:"name"`
	Revision             int64       `json:"revision,omitempty"`
	Level                int         `json:"level"`
	MaxLevel             int         `json:"maxLevel"`
	AllowCreateSubFolder bool        `json:"allowCreateSubFolder"`
	ItemCount            int64       `json:"itemCount"`
	Total                int64       `json:"total"`
	NodesCount           int64       `json:"nodesCount,omitempty"`
	ChildList            []*TreeNode `json:"childList"`
}
type Tree struct {
	Records  []*TreeNode `json:"records"`
	Revision int64       `json:"revision"`
}
type Deletion struct {
	ID                string    `json:"id"`
	Revision          int64     `json:"revision"`
	DeletedFolderIDs  []string  `json:"deletedFolderIds"`
	DeletedProjectIDs []string  `json:"deletedProjectIds"`
	DeletedAt         time.Time `json:"deletedAt"`
}
type Notification struct {
	ID        string            `json:"id"`
	Type      string            `json:"type"`
	Title     map[string]string `json:"title"`
	Body      map[string]string `json:"body"`
	Read      bool              `json:"read"`
	TargetURL *string           `json:"targetUrl"`
	CreatedAt time.Time         `json:"createdAt"`
	Revision  int64             `json:"revision"`
}

func NotificationType(s string) bool {
	return s == "" || s == "UPDATE_RECORD" || s == "OFFICIAL_MESSAGE" || s == "GENERATION"
}

type NotificationPage struct {
	Items    []Notification `json:"items"`
	Page     int            `json:"page"`
	PageSize int            `json:"pageSize"`
	Total    int64          `json:"total"`
	HasMore  bool           `json:"hasMore"`
}
type Counts struct {
	UpdateRecords    int64 `json:"updateRecords"`
	OfficialMessages int64 `json:"officialMessages"`
	Generations      int64 `json:"generations"`
	Total            int64 `json:"total"`
}
type NotificationDeletion struct {
	ID        string    `json:"id"`
	Revision  int64     `json:"revision"`
	DeletedAt time.Time `json:"deletedAt"`
}
type BatchDeletion struct {
	DeletedIDs []string `json:"deletedIds"`
	Counts     Counts   `json:"counts"`
}

func IDs(v []string) bool {
	if len(v) < 1 || len(v) > 100 {
		return false
	}
	seen := map[string]bool{}
	for _, id := range v {
		if !ID(id) || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}
