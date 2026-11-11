package application

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/organization/domain"
	"strings"
	"testing"
)

type failStore struct{ Store }

func (failStore) CreateFolder(context.Context, domain.Actor, domain.FolderInput, Mutation) (domain.Folder, error) {
	return domain.Folder{}, errors.New("store reached")
}
func TestCommandsBindRevisionAndServiceRejectsUntrustedInput(t *testing.T) {
	key := uuid.NewString()
	a, _ := Command(1, key, map[string]any{"name": "a"})
	b, _ := Command(2, key, map[string]any{"name": "a"})
	c, _ := Command(1, key, map[string]any{"name": "b"})
	upper, _ := Command(1, strings.ToUpper(key), map[string]any{"name": "a"})
	if a.Hash == b.Hash || a.Hash == c.Hash || a != upper {
		t.Fatal("receipt hash/key semantics")
	}
	if _, e := Command(0, "not-a-uuid", nil); e == nil {
		t.Fatal("invalid key accepted")
	}
	if _, e := New(nil); e == nil {
		t.Fatal("nil store accepted")
	}
	s, _ := New(failStore{})
	if _, e := s.CreateFolder(context.Background(), domain.Actor{}, domain.FolderInput{Name: "valid"}, a); !errors.Is(e, domain.ErrUnauthenticated) {
		t.Fatal("untrusted actor reached store")
	}
	if _, e := s.CreateFolder(context.Background(), domain.Actor{OwnerID: "a"}, domain.FolderInput{Name: ""}, a); !errors.Is(e, domain.ErrInvalid) {
		t.Fatal("invalid input reached store")
	}
}
