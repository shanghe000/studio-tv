package http

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

type catalogGateway struct {
	application.Unconfigured
	seen   application.Actor
	query  application.CapabilityQuery
	result application.CapabilityPage
	err    error
	calls  int
}

func (g *catalogGateway) Capabilities(_ context.Context, actor application.Actor, q application.CapabilityQuery) (application.CapabilityPage, error) {
	g.seen, g.query = actor, q
	g.calls++
	return g.result, g.err
}

func catalogHandler(t *testing.T, g application.Gateway, identity string) http.Handler {
	t.Helper()
	r := chi.NewRouter()
	err := RegisterRoutes(r, g, func(capability string, next httpapi.Handler) http.HandlerFunc {
		if capability != "tv.access" {
			t.Fatal("unexpected tool permission")
		}
		return httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			return next(w, httpapi.WithIdentity(r, httpapi.Identity{UserID: identity}))
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestActualCapabilitiesUseVerifiedActorAndDoNotExposePricing(t *testing.T) {
	mode := "NONE"
	g := &catalogGateway{result: application.CapabilityPage{Items: []application.Capability{{Ref: "image.internal", Version: "1", Kind: "TEXT_TO_IMAGE", ExecutionKind: "MODEL", ParameterSchemaVersion: "1", ParameterSchema: json.RawMessage(`{"type":"object"}`), InputKinds: []string{"TEXT"}, OutputKinds: []string{"IMAGE"}, SessionMode: &mode, Available: false, Model: &application.ModelDescriptor{ProviderRef: "supplier", ModelRef: "public-model", Title: "Public model", Version: "6.1"}}}}}
	h := catalogHandler(t, g, "usr_verified")
	r := httptest.NewRequest("GET", "/api/v2/model-capabilities?kind=TEXT_TO_IMAGE&limit=10", nil)
	r.Header.Set("X-Router-Subject-Ref", "usr_forged")
	r.Header.Set("X-Workspace-Id", "fake")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || g.seen.SubjectRef != "usr_verified" || g.query.Kind != "TEXT_TO_IMAGE" || g.query.Limit != 10 {
		t.Fatalf("actor/query projection failed: status %d", w.Code)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("actor-specific model availability must not be cached")
	}
	var envelope struct {
		Data struct {
			Items []map[string]any `json:"items"`
		} `json:"data"`
	}
	if json.Unmarshal(w.Body.Bytes(), &envelope) != nil || len(envelope.Data.Items) != 1 {
		t.Fatal("invalid catalog response")
	}
	item := envelope.Data.Items[0]
	model, ok := item["model"].(map[string]any)
	if !ok || model["providerRef"] != "supplier" || model["modelRef"] != "public-model" || model["version"] != "6.1" || len(model) != 4 {
		t.Fatal("public model descriptor was lost or expanded")
	}
	if item["available"] != false || item["testMode"] != false || item["sessionMode"] != "NONE" {
		t.Fatal("real availability changed")
	}
	for _, key := range []string{"price", "billing", "skuId", "balance", "nativeModelId", "endpoint"} {
		if _, exists := item[key]; exists {
			t.Fatalf("unexpected product catalog field %s", key)
		}
	}
}

func TestCatalogRejectsInvalidQueriesBeforeCallingInfrastructure(t *testing.T) {
	for _, path := range []string{"?ownerId=x", "?limit=0", "?limit=101", "?limit=01", "?limit=1&limit=2", "?kind=llm", "?kind=", "?cursor=" + strings.Repeat("x", 2001), "?cursor=%FF"} {
		t.Run(path[:min(len(path), 40)], func(t *testing.T) {
			g := &catalogGateway{}
			h := catalogHandler(t, g, "usr_a")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "/api/v2/model-capabilities"+path, nil))
			if w.Code != 400 || g.calls != 0 {
				t.Fatal("invalid query reached Router")
			}
		})
	}
}

func TestRequirementsAreIntentAndCatalogDoesNotFallBackToExamples(t *testing.T) {
	g := &catalogGateway{err: application.ErrNotConfigured}
	h := catalogHandler(t, g, "usr_a")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/v2/model-requirements", nil))
	if w.Code != 200 || g.calls != 0 || !strings.Contains(w.Body.String(), "OMNI_REFERENCE") {
		t.Fatal("requirements must not fabricate provider availability")
	}
	if w.Header().Get("Cache-Control") != "" {
		t.Fatal("shared model requirements cache policy changed")
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/v2/model-capabilities", nil))
	if w.Code != 501 || !strings.Contains(w.Body.String(), "MODEL_ROUTER_NOT_CONFIGURED") || strings.Contains(w.Body.String(), "image.internal") {
		t.Fatal("unconfigured catalog fell back to sample data")
	}
	g.err = &application.Fault{Code: "INVALID_REQUEST"}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/v2/model-capabilities?cursor=unsupported", nil))
	if w.Code != 400 {
		t.Fatal("upstream unsupported query lost meaning")
	}
	g.err = errors.New("private upstream secret")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/v2/model-capabilities", nil))
	if w.Code != 503 || strings.Contains(w.Body.String(), "secret") {
		t.Fatal("upstream detail leaked")
	}
}

func TestNoIdentityCannotReadCatalogOrRequirements(t *testing.T) {
	g := &catalogGateway{}
	h := catalogHandler(t, g, "")
	for _, path := range []string{"/api/v2/model-capabilities", "/api/v2/model-requirements"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 401 {
			t.Fatal("missing identity was accepted")
		}
	}
	if g.calls != 0 {
		t.Fatal("unauthenticated Router access")
	}
}
