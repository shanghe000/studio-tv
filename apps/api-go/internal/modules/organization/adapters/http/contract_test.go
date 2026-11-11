package http_test

import (
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"net/http"
	"os"
	"studiotv.local/service/api/internal/httpapi"
	organizationHTTP "studiotv.local/service/api/internal/modules/organization/adapters/http"
	"studiotv.local/service/api/internal/modules/organization/application"
	"strings"
	"testing"
)

func TestOrganizationContractMatchesEveryRegisteredImplementedRoute(t *testing.T) {
	raw, e := os.ReadFile("../../../../../../../contracts/organization-extension.json")
	if e != nil {
		t.Fatal(e)
	}
	var document map[string]any
	if json.Unmarshal(raw, &document) != nil {
		t.Fatal("invalid organization contract")
	}
	paths := document["paths"].(map[string]any)
	s, _ := application.New(&store{})
	router := chi.NewRouter()
	if e = organizationHTTP.RegisterRoutes(router, s, func(_ string, h httpapi.Handler) http.HandlerFunc { return httpapi.Wrap(h) }); e != nil {
		t.Fatal(e)
	}
	registered := map[string]bool{}
	e = chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		registered[strings.ToLower(method)+" "+route] = true
		return nil
	})
	if e != nil {
		t.Fatal(e)
	}
	count := 0
	for path, methods := range paths {
		for method, value := range methods.(map[string]any) {
			op := value.(map[string]any)
			key := method + " " + path
			if !registered[key] {
				t.Fatal("unregistered contract route", key)
			}
			delete(registered, key)
			if op["x-implementation-stage"] != "IMPLEMENTED" {
				t.Fatal("incorrect route status", key)
			}
			if len(op["security"].([]any)) != 1 {
				t.Fatal("missing security", key)
			}
			count++
		}
	}
	if count != 23 || len(registered) != 0 {
		t.Fatal("route inventory mismatch", count, registered)
	}
	var check func(any)
	check = func(v any) {
		switch v := v.(type) {
		case map[string]any:
			if ref, ok := v["$ref"].(string); ok {
				var current any = document
				for _, part := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
					m, ok := current.(map[string]any)
					if !ok || m[part] == nil {
						t.Fatal("broken schema reference", ref)
					}
					current = m[part]
				}
			}
			for _, child := range v {
				check(child)
			}
		case []any:
			for _, child := range v {
				check(child)
			}
		}
	}
	check(document)
}
