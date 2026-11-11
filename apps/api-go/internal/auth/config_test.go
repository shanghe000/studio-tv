package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	coreconfig "studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/security"
)

func TestAuthenticationConfigUsesTrustedSessionProtocol(t *testing.T) {
	base := coreconfig.Config{PublicBaseURL: "http://localhost:18880", AllowLocalHTTP: true}
	env := map[string]string{"IPAC_ISSUER_URL": "https://ipac.example", "IPAC_APP_ID": "client", "IPAC_APP_SECRET": "test-only-secret"}
	get := func(k string) string { return env[k] }
	cfg, err := configFrom(base, get)
	if err != nil || cfg.unavailableReason() != "" || cfg.BaseURL != cfg.IssuerURL {
		t.Fatal("valid IPAC config rejected", err)
	}
	// Legacy source claims and subject allowlists cannot bypass the live status
	// check; provenance now comes only from IPAC's persisted upstream session.
	env["IPAC_FEISHU_SOURCE_CLAIM"] = "amr"
	env["IPAC_FEISHU_SUBJECT_ALLOWLIST"] = "*"
	cfg, err = configFrom(base, get)
	if err != nil || cfg.unavailableReason() != "" {
		t.Fatal("deprecated config changes protocol requirement", err)
	}
	env["IPAC_ISSUER_URL"] = "http://ipac.example"
	if _, err = configFrom(base, get); err == nil {
		t.Fatal("insecure IPAC enabled by frontend HTTP alone")
	}
	env["IPAC_ALLOW_INSECURE_HTTP"] = "true"
	if _, err = configFrom(base, get); err != nil {
		t.Fatal(err)
	}
	base.AllowLocalHTTP = false
	if _, err = configFrom(base, get); err == nil {
		t.Fatal("production insecure override accepted")
	}
	base.AllowLocalHTTP = true
	env["IPAC_BASE_URL"] = "https://ipac.example?redirect=evil"
	if _, err = configFrom(base, get); err == nil {
		t.Fatal("runtime base with query accepted")
	}
}

func TestLoginGoesDirectlyThroughExistingFeishuStart(t *testing.T) {
	login, err := feishuStartURL("https://ipac.example", "https://ipac.example/oauth2/authorize?client_id=app&nonce=n&state=s")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(login, "https://ipac.example/oauth2/feishu/start?return_to=") {
		t.Fatal("generic login page used")
	}
	if _, err := feishuStartURL("https://ipac.example", "https://evil.invalid/oauth2/authorize?state=s"); err == nil {
		t.Fatal("external authorize continuation accepted")
	}
}

func TestLoginReturnPathRejectsOpenRedirectAndLoginLoops(t *testing.T) {
	for _, raw := range []string{"https://evil.invalid/", "//evil.invalid/", "/\\evil.invalid/", "/%2f%2fevil.invalid/", "/%5cevil.invalid/", "/projects/\r\nX-Header: value", "/%0d%0a", "/api/v1/auth/feishu/login", "/api/v1/auth/feishu/callback?code=a", "/login/"} {
		if safeReturnTo(raw) {
			t.Errorf("unsafe return path accepted: %q", raw)
		}
	}
	for _, raw := range []string{"/projects/", "/project/canvas/prj_123", "/projects/?tab=mine", "/"} {
		if !safeReturnTo(raw) {
			t.Errorf("valid return path rejected: %q", raw)
		}
	}
}

func TestCSRFAndUnavailableProviderBoundary(t *testing.T) {
	base := coreconfig.Config{SigningSecret: strings.Repeat("s", 40), Issuer: "rhtv", Audience: "web", AllowedOrigins: []string{"http://localhost:18880"}}
	s := &Service{base: base, cfg: Config{}, tokens: security.New(base)}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/v1/auth/config", nil)
	if err := s.configuration(w, r); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(w.Body.String(), `"configured":false`) || !strings.Contains(w.Body.String(), "IPAC_NOT_CONFIGURED") {
		t.Fatal("provider unavailable boundary missing")
	}
	if err := s.requireConfigured(); err == nil {
		t.Fatal("missing proof policy allowed login")
	}
	w = httptest.NewRecorder()
	if err := s.csrf(w, r); err != nil {
		t.Fatal(err)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly {
		t.Fatal("CSRF cookie missing HttpOnly")
	}
	post := httptest.NewRequest(http.MethodPost, "/api/v1/auth/refresh", nil)
	post.AddCookie(cookies[0])
	post.Header.Set("X-CSRF-Token", cookies[0].Value)
	if err := s.requireCsrf(post); err != nil {
		t.Fatal(err)
	}
	post.Header.Set("X-CSRF-Token", "invalid")
	if s.requireCsrf(post) == nil {
		t.Fatal("forged CSRF accepted")
	}
	post.Header.Set("X-CSRF-Token", cookies[0].Value)
	post.Header.Set("Origin", "https://evil.invalid")
	if s.requireCsrf(post) == nil {
		t.Fatal("untrusted origin accepted")
	}
}
