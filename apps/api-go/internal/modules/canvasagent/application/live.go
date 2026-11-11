package application

import (
	"context"
	"errors"
	"studiotv.local/service/api/internal/canvasdelta"

	"studiotv.local/service/api/internal/modules/canvasagent/domain"
)

type LiveRepository interface {
	OwnedLiveSnapshot(context.Context, string, string) (domain.LiveSnapshot, error)
	OwnedProjectEvents(context.Context, string, string, int64, int) (domain.EventPage, error)
}

type LiveService struct {
	repository LiveRepository
	deltas     *canvasdelta.Cache
}

func NewLiveService(repository LiveRepository, caches ...*canvasdelta.Cache) (*LiveService, error) {
	if repository == nil {
		return nil, errors.New("project live repository required")
	}
	s := &LiveService{repository: repository}
	if len(caches) == 1 {
		s.deltas = caches[0]
	}
	return s, nil
}

func (s *LiveService) Snapshot(ctx context.Context, owner, project string) (domain.LiveSnapshot, error) {
	if owner == "" || !domain.ValidCommandID(project) {
		return domain.LiveSnapshot{}, domain.ErrInvalid
	}
	return s.repository.OwnedLiveSnapshot(ctx, owner, project)
}

func (s *LiveService) Events(ctx context.Context, owner, project string, after int64, limit int) (domain.EventPage, error) {
	if owner == "" || !domain.ValidCommandID(project) || after < 0 || limit < 1 || limit > domain.MaxEventPageSize {
		return domain.EventPage{}, domain.ErrInvalid
	}
	return s.repository.OwnedProjectEvents(ctx, owner, project, after, limit)
}
