package http

import (
	"github.com/go-chi/chi/v5"
	"net/http"
	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/httpapi"
	"testing"
)

func TestEveryProtectedMediaRouteUsesTVAccess(t *testing.T) {
	count := 0
	protect := func(permission string, _ httpapi.Handler) http.HandlerFunc {
		if permission != "tv.access" {
			t.Fatal("unexpected execution RBAC", permission)
		}
		count++
		return func(http.ResponseWriter, *http.Request) {}
	}
	r := chi.NewRouter()
	RegisterRoutes(r, nil, protect)
	RegisterStudioRoutes(r, r, nil, nil, config.Config{}, protect, nil)
	if count != 10 {
		t.Fatal("protected routes count changed", count)
	}
}
