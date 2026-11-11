package application_test

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/resources/application"
	"studiotv.local/service/api/internal/modules/resources/domain"
	"testing"
)

type store struct {
	application.Store
	calls int
	actor domain.Actor
}

func (s *store) Save(_ context.Context, a domain.Actor, f domain.Family, id string, i domain.Input, m application.Mutation) (domain.Resource, error) {
	s.calls++
	s.actor = a
	return domain.Resource{ID: "persisted", Input: i, Revision: 1}, nil
}
func TestServiceRejectsBeforePersistenceAndKeepsTrustedOwner(t *testing.T) {
	repo := &store{}
	s, _ := application.New(repo)
	ctx := context.Background()
	i := domain.Input{Name: "x", CategoryIDs: []string{}, Content: json.RawMessage(`{"prefixPrompt":"p"}`)}
	m, _ := application.Command(0, uuid.NewString(), i)
	if _, e := s.Save(ctx, domain.Actor{}, domain.Prompt, "", i, m); !errors.Is(e, domain.ErrUnauthenticated) {
		t.Fatal(e)
	}
	if _, e := s.Save(ctx, domain.Actor{OwnerID: "a"}, domain.App, "", i, m); !errors.Is(e, domain.ErrInvalid) {
		t.Fatal(e)
	}
	m.Key = "native-key"
	if _, e := s.Save(ctx, domain.Actor{OwnerID: "a"}, domain.Prompt, "", i, m); !errors.Is(e, domain.ErrInvalid) {
		t.Fatal(e)
	}
	if repo.calls != 0 {
		t.Fatal("invalid calls reached persistence")
	}
	m, _ = application.Command(0, uuid.NewString(), i)
	v, e := s.Save(ctx, domain.Actor{OwnerID: "stable-local-owner"}, domain.Prompt, "", i, m)
	if e != nil || v.ID != "persisted" || repo.actor.OwnerID != "stable-local-owner" {
		t.Fatal("actor changed")
	}
}
func TestCanonicalHashes(t *testing.T) {
	a, _ := application.Command(1, uuid.NewString(), map[string]any{"b": 2, "a": "x"})
	b, _ := application.Command(1, uuid.NewString(), map[string]any{"a": "x", "b": 2})
	if a.Hash != b.Hash {
		t.Fatal("hash depends on key order")
	}
	if _, e := application.New(nil); e == nil {
		t.Fatal("nil dependencies")
	}
}
func TestNestedRawContentHashesIgnoreFieldOrderButKeepLargeNumbers(t *testing.T) {
	a, _ := application.Command(0, "", domain.Input{Name: "x", Content: json.RawMessage(`{"n":9007199254740993,"s":"x"}`)})
	b, _ := application.Command(0, "", domain.Input{Name: "x", Content: json.RawMessage(`{ "s":"x", "n":9007199254740993}`)})
	c, _ := application.Command(0, "", domain.Input{Name: "x", Content: json.RawMessage(`{"n":9007199254740992,"s":"x"}`)})
	if a.Hash != b.Hash || a.Hash == c.Hash {
		t.Fatal("nested canonicalization or precision lost")
	}
}
