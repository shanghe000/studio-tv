package core

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/httpapi"
	"testing"
)

func graphFrom(t *testing.T, raw string) map[string]any {
	t.Helper()
	var graph map[string]any
	decoder := json.NewDecoder(bytes.NewBufferString(raw))
	decoder.UseNumber()
	if e := decoder.Decode(&graph); e != nil {
		t.Fatal(e)
	}
	return graph
}
func TestGraphNativeMetaAndAuthorizedReferences(t *testing.T) {
	raw := `{"schemaVersion":"1","nodes":[{"id":"group","type":"group","position":{"x":0,"y":0},"data":{}},{"id":"child","type":"image","position":{"x":0,"y":0},"data":{"__rhtv":{"native":{"parentId":"group"}},"url":"rhtv-asset:ast_example"}},{"id":"rhtv_meta_v1","type":"__rhtv_meta","position":{"x":0,"y":0},"data":{"version":"1","meta":{},"edges":{}}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`
	graph := graphFrom(t, raw)
	refs, e := validateGraph(graph)
	if e != nil || len(refs) != 1 || refs[0] != "ast_example" {
		t.Fatalf("invalid refs %v %v", refs, e)
	}
	for _, test := range []struct{ name, old, new string }{{"meta mismatch", "\"type\":\"__rhtv_meta\"", "\"type\":\"text\""}, {"parent cycle", "\"parentId\":\"group\"", "\"parentId\":\"child\""}, {"dangling parent", "\"parentId\":\"group\"", "\"parentId\":\"missing\""}, {"secret", "\"url\":\"rhtv-asset:ast_example\"", "\"apiKey\":\"private\""}, {"proto", "\"meta\":{}", "\"meta\":{\"__proto__\":{}}"}, {"unavailable model", "\"url\":\"rhtv-asset:ast_example\"", "\"modelAssetId\":\"mas_unverified\""}, {"blob", "rhtv-asset:ast_example", "blob:temporary"}, {"infinite number", "\"meta\":{}", "\"meta\":{\"tooLarge\":1e400}"}} {
		t.Run(test.name, func(t *testing.T) {
			input := bytes.ReplaceAll([]byte(raw), []byte(test.old), []byte(test.new))
			if _, e := validateGraph(graphFrom(t, string(input))); e == nil {
				t.Fatal("invalid graph accepted")
			}
		})
	}
}
func TestRanges(t *testing.T) {
	for _, test := range []struct {
		input      string
		start, end int64
	}{{"bytes=0-31", 0, 31}, {"bytes=-10", 90, 99}, {"bytes=10-", 10, 99}, {"bytes=0-1000", 0, 99}} {
		r, e := ParseRange(test.input, 100)
		if e != nil || r.Start != test.start || r.End != test.end {
			t.Fatalf("range mismatch %#v %v", r, e)
		}
	}
	for _, input := range []string{"bytes=100-", "bytes=-0", "bytes=3-1", "bytes=0-1,3-4", "bytes=a-b"} {
		if _, e := ParseRange(input, 100); e == nil {
			t.Fatalf("invalid accepted %s", input)
		}
	}
}
func TestAssetETagConditionalComparison(t *testing.T) {
	for _, test := range []struct {
		name, header string
		matches      bool
	}{
		{"strong", `"owned"`, true},
		{"weak", `W/"owned"`, true},
		{"wildcard", " * ", true},
		{"list", `"other", W/"owned", "third"`, true},
		{"opaque comma", `"other,tag", "owned"`, true},
		{"empty list members", `, "other",, W/"owned",`, true},
		{"empty list member whitespace", `"owned", `, true},
		{"different", `W/"other"`, false},
		{"missing", "", false},
		{"unterminated", `W/"owned`, false},
		{"unquoted", `owned`, false},
		{"control character", "\"invalid\nvalue\", \"owned\"", false},
		{"missing list separator", `"other" "owned"`, false},
		{"wildcard invalid suffix", `*oops`, false},
		{"matching tag invalid suffix", `"owned"junk`, false},
		{"matching tag missing separator", `"owned" "other"`, false},
		{"matching tag malformed later member", `"owned", other`, false},
		{"matching tag unterminated later member", `"owned", "other`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if actual := assetETagMatches(test.header, `"owned"`); actual != test.matches {
				t.Fatalf("conditional ETag matched=%v wanted=%v", actual, test.matches)
			}
		})
	}
}
func testConfig(t *testing.T) config.Config {
	t.Helper()
	contract, e := filepath.Abs("../../../../contracts/openapi.json")
	if e != nil {
		t.Fatal(e)
	}
	return config.Config{SigningSecret: "test-only-signing-secret-32-bytes-long", Issuer: "rhtv-service", Audience: "rhtv-web", PublicBaseURL: "http://localhost:18880", AllowedOrigins: []string{"http://localhost:18880"}, StorageRoot: t.TempDir(), ContractPath: contract, MaxUploadBytes: 536870912, FFprobePath: "ffprobe", Features: map[string]bool{}}
}
func TestRouterKnownReservedDisabledAndUnknown(t *testing.T) {
	cfg := testConfig(t)
	auth := httpapi.AuthFunc(func(context.Context, *http.Request) (httpapi.Identity, error) {
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "please sign in")
	})
	router, e := New(cfg, nil, auth)
	if e != nil {
		t.Fatal(e)
	}
	for _, test := range []struct {
		method, path, code string
		status             int
	}{{"GET", "/api/v1/projects", "UNAUTHENTICATED", 401}, {"POST", "/api/v1/auth/sessions", "NOT_IMPLEMENTED", 501}, {"GET", "/api/v1/wallet", "FEATURE_DISABLED", 403}, {"GET", "/api/v1/not-a-route", "NOT_FOUND", 404}, {"GET", "/api/v1/billing/unknown", "NOT_FOUND", 404}} {
		r := httptest.NewRequest(test.method, test.path, nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != test.status {
			t.Fatalf("%s: %d %s", test.path, w.Code, w.Body.String())
		}
		var response map[string]any
		json.Unmarshal(w.Body.Bytes(), &response)
		if response["code"] != test.code || response["requestId"] == "" {
			t.Fatalf("wrong error %s", w.Body.String())
		}
	}
	cfg.Features = map[string]bool{"billing": true}
	cfg.Edition = "external"
	router, e = New(cfg, nil, httpapi.AuthFunc(func(context.Context, *http.Request) (httpapi.Identity, error) {
		return httpapi.Identity{UserID: "usr_test"}, nil
	}))
	if e != nil {
		t.Fatal(e)
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/wallet", nil))
	if w.Code != 501 {
		t.Fatalf("external unavailable should 501: %s", w.Body.String())
	}
}

func TestInternalBillingRoutesDenyProgrammaticOverride(t *testing.T) {
	for _, edition := range []string{"internal", ""} {
		t.Run(edition, func(t *testing.T) {
			cfg := testConfig(t)
			cfg.Edition = edition
			cfg.Features["billing"] = true
			authCalls := 0
			router, err := New(cfg, nil, httpapi.AuthFunc(func(context.Context, *http.Request) (httpapi.Identity, error) {
				authCalls++
				return httpapi.Identity{UserID: "usr_test"}, nil
			}))
			if err != nil {
				t.Fatal(err)
			}
			for _, request := range []struct{ method, path string }{
				{"GET", "/api/v1/wallet"}, {"GET", "/api/v1/wallet/entries"}, {"GET", "/api/v1/membership"},
				{"GET", "/api/v1/catalog/products"}, {"POST", "/api/v1/orders"}, {"GET", "/api/v1/orders/ord_test"},
				{"POST", "/api/v1/orders/ord_test/checkout"}, {"POST", "/api/v1/orders/ord_test/cancel"},
				{"POST", "/api/v1/billing/webhooks/test"},
				{"POST", "/api/v1/generation-quotes"}, {"GET", "/api/v1/generation-quotes/quo_test"},
				{"POST", "/api/v1/generations/gen_test/quote"}, {"POST", "/api/v1/generations/gen_test/confirm"},
			} {
				w := httptest.NewRecorder()
				router.ServeHTTP(w, httptest.NewRequest(request.method, request.path, nil))
				var response map[string]any
				if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
					t.Fatal(err)
				}
				if w.Code != 403 || response["code"] != "FEATURE_DISABLED" {
					t.Fatalf("%s %s: %d %s", request.method, request.path, w.Code, w.Body.String())
				}
			}
			if authCalls != 0 {
				t.Fatalf("disabled billing entered auth/handler: calls=%d", authCalls)
			}
			for _, path := range []string{"/api/v1/generations"} {
				w := httptest.NewRecorder()
				router.ServeHTTP(w, httptest.NewRequest("POST", path, nil))
				var response map[string]any
				if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
					t.Fatal(err)
				}
				if w.Code != 501 || response["code"] != "MODEL_PROVIDER_NOT_CONFIGURED" {
					t.Fatalf("generation placeholder changed for %s: %d %s", path, w.Code, w.Body.String())
				}
			}
			for _, path := range []string{"/api/v1/billing/unknown", "/api/v1/generations/quote"} {
				w := httptest.NewRecorder()
				router.ServeHTTP(w, httptest.NewRequest("POST", path, nil))
				if w.Code != 404 {
					t.Fatalf("unregistered route changed for %s: %d %s", path, w.Code, w.Body.String())
				}
			}
		})
	}
}
