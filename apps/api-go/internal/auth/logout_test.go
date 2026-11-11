package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/security"
)

func signedLogoutToken(t *testing.T, tokens *security.Tokens, claims map[string]any, purpose string, lifetime time.Duration) string {
	t.Helper()
	raw, err := tokens.Sign(claims, purpose, lifetime)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestLogoutBearerRequiresSignedLocalAccessIdentity(t *testing.T) {
	base := config.Config{SigningSecret: strings.Repeat("s", 40), Issuer: "rhtv-service", Audience: "rhtv-web"}
	s := &Service{tokens: security.New(base)}
	claims := map[string]any{"sub": "user-old-tab", "sid": "session-old-tab"}
	valid := signedLogoutToken(t, s.tokens, claims, "access", time.Hour)
	otherSecret := base
	otherSecret.SigningSecret = strings.Repeat("f", 40)
	otherIssuer := base
	otherIssuer.Issuer = "different-issuer"
	otherAudience := base
	otherAudience.Audience = "different-audience"
	cases := []struct {
		name, header string
		valid        bool
	}{
		{"valid local access", "Bearer " + valid, true},
		{"missing bearer", "", false},
		{"wrong scheme", "Basic " + valid, false},
		{"raw session id", "Bearer session-old-tab", false},
		{"forged signature", "Bearer " + signedLogoutToken(t, security.New(otherSecret), claims, "access", time.Hour), false},
		{"wrong issuer", "Bearer " + signedLogoutToken(t, security.New(otherIssuer), claims, "access", time.Hour), false},
		{"wrong audience", "Bearer " + signedLogoutToken(t, security.New(otherAudience), claims, "access", time.Hour), false},
		{"wrong purpose", "Bearer " + signedLogoutToken(t, s.tokens, claims, "csrf", time.Hour), false},
		{"expired access remains a revocation proof", "Bearer " + signedLogoutToken(t, s.tokens, claims, "access", -time.Hour), true},
		{"missing subject", "Bearer " + signedLogoutToken(t, s.tokens, map[string]any{"sid": "session-old-tab"}, "access", time.Hour), false},
		{"missing session", "Bearer " + signedLogoutToken(t, s.tokens, map[string]any{"sub": "user-old-tab"}, "access", time.Hour), false},
		{"non string subject", "Bearer " + signedLogoutToken(t, s.tokens, map[string]any{"sub": 123, "sid": "session-old-tab"}, "access", time.Hour), false},
		{"non string session", "Bearer " + signedLogoutToken(t, s.tokens, map[string]any{"sub": "user-old-tab", "sid": 123}, "access", time.Hour), false},
		{"empty subject", "Bearer " + signedLogoutToken(t, s.tokens, map[string]any{"sub": "", "sid": "session-old-tab"}, "access", time.Hour), false},
		{"empty session", "Bearer " + signedLogoutToken(t, s.tokens, map[string]any{"sub": "user-old-tab", "sid": ""}, "access", time.Hour), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/session", nil)
			r.Header.Set("Authorization", tc.header)
			uid, sid := s.logoutBearer(r)
			if tc.valid {
				if uid != "user-old-tab" || sid != "session-old-tab" {
					t.Fatal("valid signed identity was not preserved")
				}
			} else if uid != "" || sid != "" {
				t.Fatal("untrusted logout identity was accepted")
			}
		})
	}
}

func TestPostgresLogoutRevokesBothTabAndCookieSessions(t *testing.T) {
	db := authTestDatabase(t)
	ctx := context.Background()
	base := config.Config{SigningSecret: strings.Repeat("s", 40), Issuer: "rhtv-service", Audience: "rhtv-web", PublicBaseURL: "http://localhost:18880", AllowLocalHTTP: true, AllowedOrigins: []string{"http://localhost:18880"}}
	cases := []struct {
		name, bearerMode, cookieMode string
		badCSRF, badOrigin, outage   bool
		oldRevoked, cookieRevoked    bool
	}{
		{name: "different users in tab and shared cookie", bearerMode: "valid", cookieMode: "valid", oldRevoked: true, cookieRevoked: true},
		{name: "expired bearer also revokes its old tab session", bearerMode: "expired", cookieMode: "valid", oldRevoked: true, cookieRevoked: true},
		{name: "bearer only", bearerMode: "valid", oldRevoked: true},
		{name: "forged bearer still permits cookie logout", bearerMode: "forged", cookieMode: "valid", cookieRevoked: true},
		{name: "signed sid cannot revoke a different subject", bearerMode: "mismatch", cookieMode: "valid", cookieRevoked: true},
		{name: "raw body sid is ignored in legacy cookie logout", cookieMode: "valid", cookieRevoked: true},
		{name: "invalid csrf cannot revoke either session", bearerMode: "valid", cookieMode: "valid", badCSRF: true},
		{name: "untrusted origin cannot revoke either session", bearerMode: "valid", cookieMode: "valid", badOrigin: true},
		{name: "upstream outage does not prevent local logout", bearerMode: "valid", cookieMode: "valid", outage: true, oldRevoked: true, cookieRevoked: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := &Service{base: base, db: db, tokens: security.New(base), cfg: Config{IssuerURL: "https://ipac.example", BaseURL: "https://ipac.example", ClientID: "test-client", ClientSecret: "test-only-secret"}}
			var upstreamCalls atomic.Uint64
			s.statusHTTP = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				upstreamCalls.Add(1)
				return nil, errors.New("test-only upstream outage")
			})}
			userIDs := []string{"usr_" + httpapi.RandomToken(), "usr_" + httpapi.RandomToken(), "usr_" + httpapi.RandomToken()}
			sessionIDs := []string{"ses_" + httpapi.RandomToken(), "ses_" + httpapi.RandomToken(), "ses_" + httpapi.RandomToken()}
			refresh := httpapi.RandomToken()
			for i := range userIDs {
				if _, err := db.Exec(ctx, "INSERT INTO users(id,email,display_name) VALUES($1,$2,'退出测试')", userIDs[i], userIDs[i]+"@example.invalid"); err != nil {
					t.Fatal(err)
				}
				if _, err := db.Exec(ctx, "INSERT INTO sessions(id,user_id,expires_at,ipac_issuer,ipac_subject,ipac_session_id,ipac_session_version) VALUES($1,$2,now()+interval '1 hour',$3,$4,$5,1)", sessionIDs[i], userIDs[i], s.cfg.IssuerURL, "ipac-"+userIDs[i], "ipac-"+sessionIDs[i]); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := db.Exec(ctx, "INSERT INTO refresh_tokens(token_hash,session_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", security.Digest(refresh), sessionIDs[1]); err != nil {
				t.Fatal(err)
			}
			csrf := signedLogoutToken(t, s.tokens, map[string]any{"nonce": "test"}, "csrf", time.Hour)
			r := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/session?sid="+sessionIDs[0], strings.NewReader(`{"sid":"`+sessionIDs[0]+`"}`))
			r.AddCookie(&http.Cookie{Name: s.cookieName("csrf"), Value: csrf})
			r.Header.Set("X-CSRF-Token", csrf)
			r.Header.Set("Origin", base.PublicBaseURL)
			if tc.cookieMode == "valid" {
				r.AddCookie(&http.Cookie{Name: s.cookieName("refresh"), Value: refresh})
			}
			if tc.bearerMode != "" {
				claims := map[string]any{"sub": userIDs[0], "sid": sessionIDs[0]}
				tokens := s.tokens
				if tc.bearerMode == "forged" {
					other := base
					other.SigningSecret = strings.Repeat("f", 40)
					tokens = security.New(other)
				} else if tc.bearerMode == "mismatch" {
					claims["sub"] = userIDs[2]
				}
				lifetime := time.Hour
				if tc.bearerMode == "expired" {
					lifetime = -time.Minute
				}
				r.Header.Set("Authorization", "Bearer "+signedLogoutToken(t, tokens, claims, "access", lifetime))
			}
			if tc.badCSRF {
				r.Header.Set("X-CSRF-Token", "invalid")
			}
			if tc.badOrigin {
				r.Header.Set("Origin", "https://untrusted.invalid")
			}
			if tc.outage {
				_, err := s.Authenticate(ctx, r)
				var api *httpapi.Error
				if !errors.As(err, &api) || api.Status != 503 || upstreamCalls.Load() != 1 {
					t.Fatal("test did not establish a genuine upstream failure", err)
				}
			}
			beforeCalls := upstreamCalls.Load()
			w := httptest.NewRecorder()
			err := s.logout(w, r)
			if tc.badCSRF || tc.badOrigin {
				var api *httpapi.Error
				if !errors.As(err, &api) || api.Status != 403 {
					t.Fatal("unsafe logout request was not rejected", err)
				}
			} else {
				if err != nil || w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"accepted":true`) {
					t.Fatal("local logout failed", err)
				}
				clearedCookie := false
				for _, c := range w.Result().Cookies() {
					if c.Name == s.cookieName("refresh") && c.MaxAge == -1 && c.Value == "" {
						clearedCookie = true
					}
				}
				if !clearedCookie {
					t.Fatal("logout did not clear the refresh cookie")
				}
			}
			if upstreamCalls.Load() != beforeCalls {
				t.Fatal("local logout depended on upstream status")
			}
			for i, expected := range []bool{tc.oldRevoked, tc.cookieRevoked, false} {
				var revoked bool
				if err := db.QueryRow(ctx, "SELECT revoked_at IS NOT NULL FROM sessions WHERE id=$1", sessionIDs[i]).Scan(&revoked); err != nil || revoked != expected {
					t.Fatalf("unexpected revocation for session %d: got %v want %v; error %v", i, revoked, expected, err)
				}
			}
		})
	}
}
