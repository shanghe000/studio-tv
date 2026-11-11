package application

import (
	"context"
	"errors"
	"studiotv.local/service/api/internal/modules/library/domain"
)

type EntryMutation struct {
	Expected int64
	Key      string
	Hash     string
}
type EntryRepository interface {
	State(context.Context, domain.VerifiedActor) (int64, error)
	Folders(context.Context, domain.VerifiedActor, domain.EntryQuery) (domain.EntriesPage, error)
	Folder(context.Context, domain.VerifiedActor, string) (domain.Folder, error)
	CreateFolder(context.Context, domain.VerifiedActor, domain.FolderInput, EntryMutation) (domain.Folder, error)
	UpdateFolder(context.Context, domain.VerifiedActor, string, domain.FolderPatch, EntryMutation) (domain.Folder, error)
	Entries(context.Context, domain.VerifiedActor, domain.EntryQuery) (domain.EntriesPage, error)
	Node(context.Context, domain.VerifiedActor, string) (domain.Node, error)
	UpdateNode(context.Context, domain.VerifiedActor, string, domain.NodeInput, EntryMutation) (domain.Node, error)
	BatchCreate(context.Context, domain.VerifiedActor, domain.BatchCreate, EntryMutation) (domain.BatchResult, error)
	BatchMutate(context.Context, domain.VerifiedActor, domain.BatchMutation, bool, EntryMutation) (domain.BatchResult, error)
}
type EntryService struct{ Repo EntryRepository }

func NewEntries(repo EntryRepository) (*EntryService, error) {
	if repo == nil {
		return nil, errors.New("library entry repository required")
	}
	return &EntryService{repo}, nil
}
