package http

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

type exactCatalogGateway struct {
	application.Unconfigured
	actor        application.Actor
	ref, version string
	item         application.Capability
	err          error
	calls        int
}

func (g *exactCatalogGateway) CapabilityVersion(_ context.Context, actor application.Actor, ref, version string) (application.Capability, error) {
	g.actor, g.ref, g.version = actor, ref, version
	g.calls++
	return g.item, g.err
}

func TestExactVersionHTTPKeepsOldSchemaAndVerifiedActor(t *testing.T) {
	g := &exactCatalogGateway{item: application.Capability{Ref: "chat.general", Version: "1", Kind: "LLM", ExecutionKind: "MODEL", ParameterSchemaVersion: "1", ParameterSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`), InputKinds: []string{"TEXT"}, OutputKinds: []string{"TEXT"}, Available: true}}
	h := catalogHandler(t, g, "usr_verified")
	r := httptest.NewRequest("GET", capabilityVersionPath+"?ref=chat.general&version=1", nil)
	r.Header.Set("X-Router-Subject-Ref", "usr_forged")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || g.actor.SubjectRef != "usr_verified" || g.ref != "chat.general" || g.version != "1" || g.calls != 1 {
		t.Fatalf("exact query failed: %d %s", w.Code, w.Body)
	}
	var envelope struct {
		Data capabilityDTO `json:"data"`
	}
	if json.Unmarshal(w.Body.Bytes(), &envelope) != nil || envelope.Data.Version != "1" || envelope.Data.ParameterSchemaVersion != "1" || string(envelope.Data.ParameterSchema) != `{"type":"object","additionalProperties":false}` {
		t.Fatal("old metadata was upgraded or extra-wrapped")
	}
}

func TestExactVersionHTTPRejectsMalformedUnauthorizedUnknownAndWrongPair(t *testing.T) {
	for _, suffix := range []string{"", "?ref=chat.general", "?version=1", "?ref=chat.general&version=1&version=2", "?ref=chat.general&version=1&ownerId=forged", "?ref=chat.general&version=%FF", "?ref=chat.general&version=" + strings.Repeat("1", 101)} {
		g := &exactCatalogGateway{}
		w := httptest.NewRecorder()
		catalogHandler(t, g, "usr_a").ServeHTTP(w, httptest.NewRequest("GET", capabilityVersionPath+suffix, nil))
		if w.Code != 400 || g.calls != 0 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("invalid exact query reached Router or was cached")
		}
	}
	for _, test := range []struct {
		identity string
		err      error
		item     application.Capability
		status   int
	}{{"", nil, application.Capability{}, 401}, {"usr_a", &application.Fault{Code: "CAPABILITY_NOT_FOUND"}, application.Capability{}, 404}, {"usr_a", nil, application.Capability{Ref: "chat.general", Version: "2"}, 503}} {
		g := &exactCatalogGateway{item: test.item, err: test.err}
		w := httptest.NewRecorder()
		catalogHandler(t, g, test.identity).ServeHTTP(w, httptest.NewRequest("GET", capabilityVersionPath+"?ref=chat.general&version=1", nil))
		if w.Code != test.status || w.Header().Get("Cache-Control") != "no-store" || test.identity == "" && g.calls != 0 {
			t.Fatalf("failure policy: %d", w.Code)
		}
	}
	// The policy decorator can deny tv.access before identity/Router reads.
	g := &exactCatalogGateway{}
	r := chi.NewRouter()
	if err := RegisterRoutes(r, g, func(permission string, _ httpapi.Handler) http.HandlerFunc {
		if permission != "tv.access" {
			t.Fatal("wrong exact-version permission")
		}
		return httpapi.Wrap(func(http.ResponseWriter, *http.Request) error {
			return httpapi.Fail(403, "FORBIDDEN", "禁止访问。")
		})
	}); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", capabilityVersionPath+"?ref=chat.general&version=1", nil))
	if w.Code != 403 || g.calls != 0 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("policy denial reached Router or was cached")
	}
}

func TestExactVersionHTTPQueryOnlyBodyAndMethods(t *testing.T) {
	path := capabilityVersionPath + "?ref=chat.general&version=1"
	for _, test := range []struct {
		name   string
		setup  func(*http.Request)
		status int
	}{
		{"no_body", func(*http.Request) {}, 200},
		{"empty_no_body", func(r *http.Request) { r.Body = http.NoBody }, 200},
		{"body", func(r *http.Request) {
			*r = *httptest.NewRequest("GET", path, strings.NewReader(`{}`))
		}, 400},
		{"unknown_length", func(r *http.Request) { r.ContentLength = -1 }, 400},
		{"transfer_encoding", func(r *http.Request) { r.TransferEncoding = []string{"chunked"} }, 400},
		{"declared_length", func(r *http.Request) { r.ContentLength = 1 }, 400},
	} {
		t.Run(test.name, func(t *testing.T) {
			g := &exactCatalogGateway{item: application.Capability{Ref: "chat.general", Version: "1"}}
			r := httptest.NewRequest("GET", path, nil)
			test.setup(r)
			w := httptest.NewRecorder()
			catalogHandler(t, g, "usr_verified").ServeHTTP(w, r)
			wantCalls := 0
			if test.status == 200 {
				wantCalls = 1
			}
			if w.Code != test.status || g.calls != wantCalls || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("query-only policy: status=%d calls=%d", w.Code, g.calls)
			}
		})
	}
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"} {
		t.Run(method, func(t *testing.T) {
			g := &exactCatalogGateway{}
			w := httptest.NewRecorder()
			catalogHandler(t, g, "usr_verified").ServeHTTP(w, httptest.NewRequest(method, path, nil))
			if w.Code != 405 || g.calls != 0 {
				t.Fatalf("non-GET query reached Router: status=%d calls=%d", w.Code, g.calls)
			}
		})
	}
}
