package application

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/execution/domain"
	"testing"
)

func TestCollaborativeCanvasUsesStorageOwnerAndTrueGatewayActor(t *testing.T) {
	s, store, g := versionTestService(t)
	s.WithProjectAccess(func(_ context.Context, actor, project string) (string, error) {
		if actor != "owner" || project != "project" {
			return "", domain.ErrNotFound
		}
		return "canonical-owner", nil
	})
	task, e := promptCanvas(t, s, `{"capabilityVersion":"1","params":{"prompt":"write a story"},"routerParameters":{}}`)
	if e != nil {
		t.Fatal(e)
	}
	if task.OwnerID != "canonical-owner" || task.InitiatedBy != "owner" || g.actor.SubjectRef != "owner" {
		t.Fatal("storage owner replaced the caller")
	}
	s.execute(context.Background(), task, "lease")
	if store.task.State != "SUCCEEDED" || g.submits != 1 || g.actor.SubjectRef != "owner" {
		t.Fatal("worker lost initiator")
	}
	key := uuid.NewString()
	if actorKey(key, "owner", "canonical-owner") == actorKey(key, "other-member", "canonical-owner") || actorKey(key, "owner", "owner") != key {
		t.Fatal("collaborator receipt collision or private receipt changed")
	}
}

func TestCollaborativeCanvasRechecksRevocationAndCanonicalOwner(t *testing.T) {
	for _, revoke := range []bool{true, false} {
		t.Run(map[bool]string{true: "revoked", false: "forged-owner"}[revoke], func(t *testing.T) {
			s, store, g := versionTestService(t)
			revoked := false
			s.WithProjectAccess(func(context.Context, string, string) (string, error) {
				if revoked {
					return "", errors.New("membership removed")
				}
				return "canonical-owner", nil
			})
			task, e := promptCanvas(t, s, `{"capabilityVersion":"1","params":{"prompt":"write a story"},"routerParameters":{}}`)
			if e != nil {
				t.Fatal(e)
			}
			if revoke {
				revoked = true
			} else {
				task.OwnerID = "foreign-owner"
			}
			s.execute(context.Background(), task, "lease")
			if store.task.State != "FAILED" || g.submits != 0 || g.reads != 0 {
				t.Fatal("unauthorized worker invoked model")
			}
		})
	}
}
