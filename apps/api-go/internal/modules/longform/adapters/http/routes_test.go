package http

import (
	"errors"
	"net/http"
	"net/http/httptest"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"testing"

	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/httpapi"
	app "studiotv.local/service/api/internal/modules/longform/application"
)

func TestRoutesRequireVerifiedIdentityAndFailClosedWithoutGateway(t *testing.T) {
	r := chi.NewRouter()
	s := app.New(nil, nil, nil, false)
	if e := RegisterRoutes(r, s, func(_ string, h httpapi.Handler) http.HandlerFunc { return httpapi.Wrap(h) }); e != nil {
		t.Fatal(e)
	}
	req := httptest.NewRequest("GET", "/api/v2/longform/capabilities", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 401 {
		t.Fatal("anonymous capabilities", w.Code)
	}
	req = httpapi.WithIdentity(httptest.NewRequest("GET", "/api/v2/longform/capabilities", nil), httpapi.Identity{UserID: "verified"})
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 501 {
		t.Fatal("unconfigured feature pretended success", w.Code, w.Body.String())
	}
}

func TestUpstreamActionConflictsRemainActionable(t *testing.T) {
	for _, code := range []string{"LONGFORM_REVISION_CONFLICT", "PREDECESSOR_REQUIRED", "CONTEXT_RESOLUTION_MISMATCH"} {
		err := mapped(&gateway.Fault{Code: code, HTTPStatus: 409})
		var api *httpapi.Error
		if !errors.As(err, &api) || api.Status != 409 || api.Code != code {
			t.Fatal("actionable fault changed to unavailable", err)
		}
	}
}

func TestArchivedAssetLocationKeepsOnlySignedLocalAssetPath(t *testing.T) {
	const path = "/storage/assets/ast_fixture?token=a%2Bb%2Fc%3D"
	for _, raw := range []string{path, "http://192.0.2.10:18880" + path, "https://studio.example.test" + path} {
		got, err := archivedAssetLocation(raw)
		if err != nil || got != path {
			t.Fatal("trusted signed asset path or exact query changed")
		}
	}
	for _, raw := range []string{
		"https://external.example.test/other?token=test",
		"//external.example.test" + path,
		"https://user:pass@external.example.test" + path,
		"file:///storage/assets/ast_fixture?token=test",
		"/storage/assets/ast_fixture/../ast_other?token=test",
		"/storage/assets/%61st_fixture?token=test",
		"/storage/assets/ast_fixture%2fother?token=test",
		"/storage/assets/ast_fixture?token=test#fragment",
		"/storage/assets/ast_fixture?token=one&token=two",
		"/storage/assets/ast_fixture?token=test&redirect=https://external.example.test",
		"/storage/assets/ast_fixture?token=test;other=value",
		"/storage/assets/ast_fixture?token=",
		"/storage/assets/ast_fixture",
		"/storage/assets/ast_fixture?token=test\r\nLocation: https://external.example.test",
	} {
		if _, err := archivedAssetLocation(raw); err == nil {
			t.Fatal("untrusted archive target accepted")
		}
	}
}
