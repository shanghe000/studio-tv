package application

import (
	"context"
	"encoding/json"
	"errors"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
)

type Snapshot struct {
	Revision int64
	Graph    json.RawMessage
}
type Repository interface {
	OwnedSnapshot(context.Context, string, string) (Snapshot, error)
}
type Service struct{ repository Repository }

func New(repository Repository) (*Service, error) {
	if repository == nil {
		return nil, errors.New("canvas context repository required")
	}
	return &Service{repository}, nil
}
func (s *Service) Read(ctx context.Context, owner, project string) (domain.Context, error) {
	if owner == "" || project == "" {
		return domain.Context{}, domain.ErrInvalid
	}
	value, err := s.repository.OwnedSnapshot(ctx, owner, project)
	if err != nil {
		return domain.Context{}, err
	}
	return domain.Build(project, value.Revision, value.Graph)
}
