package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/auth/oidcrp"
	coreconfig "studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/security"
	"studiotv.local/service/api/internal/testdb"
	"studiotv.local/service/api/migrations"
)

func authTestDatabase(t *testing.T) *pgxpool.Pool {
	t.Helper()
	db := testdb.New(t).Open(t)
	ctx := context.Background()
	initial, err := migrations.Files.ReadFile("001_core.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, string(initial)); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, "CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now()); INSERT INTO schema_migrations(name) VALUES('001_core.sql')"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, "INSERT INTO users(id,email,password_hash,display_name) VALUES('legacy-user','legacy@example.invalid','retired-hash','历史用户'); INSERT INTO sessions(id,user_id,expires_at) VALUES('legacy-session','legacy-user',now()+interval '30 days'); INSERT INTO projects(id,owner_id,name) VALUES('legacy-project','legacy-user','保留项目')"); err != nil {
		t.Fatal(err)
	}
	if err = database.Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestPostgresIdentityRefreshLogoutAndMigration(t *testing.T) {
	db := authTestDatabase(t)
	ctx := context.Background()
	base := coreconfig.Config{SigningSecret: strings.Repeat("t", 40), Issuer: "rhtv-service", Audience: "rhtv-web", PublicBaseURL: "http://localhost:18880", AllowLocalHTTP: true, AllowedOrigins: []string{"http://localhost:18880"}}
	s := &Service{base: base, db: db, tokens: security.New(base), cfg: Config{IssuerURL: "https://ipac.example", ClientID: "test-client", ClientSecret: "test-only-secret", BaseURL: "https://ipac.example"}}
	identity := oidcrp.Identity{SubjectID: "employee-test", DisplayName: "飞书测试", AvatarURL: "https://example.invalid/avatar.png", SessionID: "ipac-session", SessionVersion: 1}
	statusServer := statusTestServer(t, nil)
	s.cfg.BaseURL = statusServer.URL
	uid, sid, refresh, err := s.establish(ctx, identity)
	if err != nil {
		t.Fatal(err)
	}
	uidAgain, _, _, err := s.establish(ctx, identity)
	if err != nil || uidAgain != uid {
		t.Fatal("issuer+subject association is not stable", err)
	}
	if uid == "legacy-user" {
		t.Fatal("unified identity auto-merged into old account")
	}
	var legacyRevoked, projectPreserved bool
	if err = db.QueryRow(ctx, "SELECT revoked_at IS NOT NULL FROM sessions WHERE id='legacy-session'").Scan(&legacyRevoked); err != nil || !legacyRevoked {
		t.Fatal("password session was not retired", err)
	}
	if err = db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM projects WHERE id='legacy-project' AND owner_id='legacy-user')").Scan(&projectPreserved); err != nil || !projectPreserved {
		t.Fatal("migration lost existing project", err)
	}
	access, err := s.tokens.Sign(map[string]any{"sub": uid, "sid": sid}, "access", accessLifetime)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/api/v1/projects", nil)
	r.Header.Set("Authorization", "Bearer "+access)
	if who, err := s.Authenticate(ctx, r); err != nil || who.UserID != uid {
		t.Fatal("persisted verified session was not accepted", err)
	}
	csrf, _ := s.tokens.Sign(map[string]any{"nonce": "test"}, "csrf", time.Hour)
	request := func(token string) *http.Request {
		r := httptest.NewRequest("POST", "/api/v1/auth/sessions/refresh", nil)
		r.AddCookie(&http.Cookie{Name: s.cookieName("refresh"), Value: token})
		r.AddCookie(&http.Cookie{Name: s.cookieName("csrf"), Value: csrf})
		r.Header.Set("X-CSRF-Token", csrf)
		r.Header.Set("Origin", base.PublicBaseURL)
		return r
	}
	w := httptest.NewRecorder()
	if err = s.refresh(w, request(refresh)); err != nil {
		t.Fatal(err)
	}
	var response struct {
		Data struct {
			AccessToken string `json:"accessToken"`
			User        struct {
				ID string `json:"id"`
			} `json:"user"`
		} `json:"data"`
	}
	if json.Unmarshal(w.Body.Bytes(), &response) != nil || response.Data.User.ID != uid || response.Data.AccessToken == "" {
		t.Fatal("refresh response shape changed")
	}
	var next string
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == s.cookieName("refresh") {
			next = cookie.Value
			if !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode {
				t.Fatal("refresh cookie attributes unsafe")
			}
		}
	}
	if next == "" || next == refresh {
		t.Fatal("refresh was not rotated")
	}
	w = httptest.NewRecorder()
	err = s.refresh(w, request(refresh))
	var api *httpapi.Error
	if !errors.As(err, &api) || api.Status != 401 || api.Code != "REFRESH_RACE_RETRY" || !api.Retryable || w.Header().Get("Retry-After") != "1" || len(w.Result().Cookies()) != 0 {
		t.Fatal("recent competing token must fail without credentials or cookie deletion", err)
	}
	if _, err = s.Authenticate(ctx, r); err != nil {
		t.Fatal("recent refresh competition revoked a healthy session", err)
	}
	// Move the owned test row past the exact grace boundary; a genuinely old
	// replay still revokes the complete refresh-token family without sleeping.
	if _, err = db.Exec(ctx, "UPDATE refresh_tokens SET consumed_at=clock_timestamp()-interval '6 seconds' WHERE token_hash=$1", security.Digest(refresh)); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	err = s.refresh(w, request(refresh))
	if !errors.As(err, &api) || api.Status != 401 || api.Code != "REFRESH_REVOKED" {
		t.Fatal("refresh replay did not fail", err)
	}
	if _, err = s.Authenticate(ctx, r); err == nil {
		t.Fatal("replayed token family still accepts access token")
	}
	if _, _, _, err = s.rotate(ctx, next, httpapi.RandomToken()); err == nil {
		t.Fatal("replayed family next token accepted")
	}
	_, sid, refresh, err = s.establish(ctx, identity)
	if err != nil {
		t.Fatal(err)
	}
	access, _ = s.tokens.Sign(map[string]any{"sub": uid, "sid": sid}, "access", accessLifetime)
	r.Header.Set("Authorization", "Bearer "+access)
	w = httptest.NewRecorder()
	if err = s.logout(w, request(refresh)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Authenticate(ctx, r); err == nil {
		t.Fatal("logout failed to revoke access")
	}
	legacyAccess, _ := s.tokens.Sign(map[string]any{"sub": "legacy-user", "sid": "legacy-session"}, "access", accessLifetime)
	r.Header.Set("Authorization", "Bearer "+legacyAccess)
	if _, err = s.Authenticate(ctx, r); err == nil {
		t.Fatal("legacy password session accepted")
	}
}

func TestPostgresLoginTransactionSingleUseAndExpiry(t *testing.T) {
	db := authTestDatabase(t)
	s := &Service{db: db}
	ctx := context.Background()
	tx := oidcrp.Transaction{State: "state", Nonce: "nonce", PKCEVerifier: "verifier", ReturnTo: "/projects/", CreatedAt: time.Now()}
	encoded, _ := json.Marshal(tx)
	raw := httpapi.RandomToken()
	_, err := db.Exec(ctx, "INSERT INTO oidc_login_transactions(token_hash,transaction,expires_at)VALUES($1,$2::jsonb,now()+interval '5 minutes')", security.Digest(raw), encoded)
	if err != nil {
		t.Fatal(err)
	}
	if actual, err := s.consumeTransaction(ctx, raw); err != nil || actual.State != tx.State {
		t.Fatal("transaction consumption failed", err)
	}
	if _, err = s.consumeTransaction(ctx, raw); err == nil {
		t.Fatal("transaction replay succeeded")
	}
	raw = httpapi.RandomToken()
	_, err = db.Exec(ctx, "INSERT INTO oidc_login_transactions(token_hash,transaction,expires_at)VALUES($1,$2::jsonb,now()-interval '1 minute')", security.Digest(raw), encoded)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.consumeTransaction(ctx, raw); err == nil {
		t.Fatal("expired transaction succeeded")
	}
}

func TestPostgresUpstreamSessionRevocationAndRefreshFailClosed(t *testing.T) {
	db := authTestDatabase(t)
	ctx := context.Background()
	var active atomic.Bool
	active.Store(true)
	var calls atomic.Uint64
	server := statusTestServer(t, func(state *sessionStatus) { calls.Add(1); state.Active = active.Load() })
	base := coreconfig.Config{SigningSecret: strings.Repeat("t", 40), Issuer: "rhtv-service", Audience: "rhtv-web", PublicBaseURL: "http://localhost:18880", AllowLocalHTTP: true, AllowedOrigins: []string{"http://localhost:18880"}}
	s := &Service{base: base, db: db, tokens: security.New(base), cfg: Config{IssuerURL: "https://ipac.example", BaseURL: server.URL, ClientID: "test-client", ClientSecret: "test-only-secret"}}
	identity := oidcrp.Identity{SubjectID: "employee", SessionID: "ipac-session", SessionVersion: 3, DisplayName: "测试员工"}
	uid, sid, refresh, err := s.establish(ctx, identity)
	if err != nil {
		t.Fatal(err)
	}
	var expiry time.Time
	if err = db.QueryRow(ctx, "SELECT expires_at FROM sessions WHERE id=$1", sid).Scan(&expiry); err != nil || time.Until(expiry) > 2*time.Hour {
		t.Fatal("local session exceeds upstream lifetime", err)
	}
	before := calls.Load()
	who, err := s.AuthenticateSession(ctx, uid, sid)
	if err != nil || who.IPACSubjectID != identity.SubjectID || who.IPACSessionID != identity.SessionID || who.IPACSessionVersion != identity.SessionVersion || calls.Load() != before {
		t.Fatal("trusted principal or seeded verification lease missing", err)
	}
	key := sessionStatusRequest{SubjectID: identity.SubjectID, SessionID: identity.SessionID, SessionVersion: identity.SessionVersion}
	// An already verified lease remains valid during a transient outage until
	// its bounded deadline. An uncached check fails closed without local revoke.
	s.statusHTTP = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("test-only upstream outage") })}
	if _, err = s.AuthenticateSession(ctx, uid, sid); err != nil {
		t.Fatal("outage prematurely invalidated an existing verified lease", err)
	}
	s.sessionLease().Delete(key)
	if _, err = s.AuthenticateSession(ctx, uid, sid); err == nil {
		t.Fatal("upstream outage was bypassed")
	}
	var revoked bool
	if err = db.QueryRow(ctx, "SELECT revoked_at IS NOT NULL FROM sessions WHERE id=$1", sid).Scan(&revoked); err != nil || revoked {
		t.Fatal("transient failure revoked a healthy session", err)
	}
	s.statusHTTP = nil
	s.sessionLease().Delete(key)
	if _, err = s.AuthenticateSession(ctx, uid, sid); err != nil {
		t.Fatal("healthy recovery did not restore session", err)
	}
	// Upstream revocation is observed on the next live check, bounded by the
	// five-minute lease. Simulate that boundary explicitly rather than sleeping.
	active.Store(false)
	if _, err = s.AuthenticateSession(ctx, uid, sid); err != nil {
		t.Fatal("upstream change bypassed the agreed ordinary request lease", err)
	}
	s.sessionLease().Delete(key)
	if _, err = s.AuthenticateSession(ctx, uid, sid); err == nil {
		t.Fatal("revoked upstream sid accepted")
	}
	if err = db.QueryRow(ctx, "SELECT revoked_at IS NOT NULL FROM sessions WHERE id=$1", sid).Scan(&revoked); err != nil || !revoked {
		t.Fatal("upstream revocation not persisted", err)
	}
	active.Store(true)
	before = calls.Load()
	if _, err = s.AuthenticateSession(ctx, uid, sid); err == nil {
		t.Fatal("revoked local session revived")
	}
	if calls.Load() != before {
		t.Fatal("revoked local session reached the upstream cache")
	}
	_, sid, refresh, err = s.establish(ctx, identity)
	if err != nil {
		t.Fatal(err)
	}
	active.Store(false)
	if _, err = s.AuthenticateSession(ctx, uid, sid); err != nil {
		t.Fatal("fresh session lease was not reused before refresh", err)
	}
	if _, _, _, err = s.rotate(ctx, refresh, httpapi.RandomToken()); err == nil {
		t.Fatal("refresh bypassed upstream revocation")
	}
	if err = db.QueryRow(ctx, "SELECT revoked_at IS NOT NULL FROM sessions WHERE id=$1", sid).Scan(&revoked); err != nil || !revoked {
		t.Fatal("refresh revocation not persisted", err)
	}
	var consumed bool
	if err = db.QueryRow(ctx, "SELECT consumed_at IS NOT NULL FROM refresh_tokens WHERE token_hash=$1", security.Digest(refresh)).Scan(&consumed); err != nil || consumed {
		t.Fatal("revoked refresh rotated token", err)
	}
}

func TestPostgresLocalRestrictionsStillApplyToVerifiedSessionLease(t *testing.T) {
	db := authTestDatabase(t)
	ctx := context.Background()
	var calls atomic.Uint64
	server := statusTestServer(t, func(*sessionStatus) { calls.Add(1) })
	base := coreconfig.Config{SigningSecret: strings.Repeat("t", 40), Issuer: "rhtv-service", Audience: "rhtv-web"}
	s := &Service{base: base, db: db, tokens: security.New(base), cfg: Config{IssuerURL: "https://ipac.example", BaseURL: server.URL, ClientID: "test-client", ClientSecret: "test-only-secret"}}
	uid, sid, _, err := s.establish(ctx, oidcrp.Identity{SubjectID: "local-restriction-person", SessionID: "local-restriction-sid", SessionVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.AuthenticateSession(ctx, uid, sid); err != nil || calls.Load() != 1 {
		t.Fatal("session verification was not seeded", err, calls.Load())
	}
	if _, err = db.Exec(ctx, "UPDATE users SET disabled=true WHERE id=$1", uid); err != nil {
		t.Fatal(err)
	}
	if _, err = s.AuthenticateSession(ctx, uid, sid); err == nil || calls.Load() != 1 {
		t.Fatal("disabled account bypassed local validation with a cached upstream lease", err, calls.Load())
	}
	if _, err = db.Exec(ctx, "UPDATE users SET disabled=false WHERE id=$1", uid); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, "UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE id=$1", sid); err != nil {
		t.Fatal(err)
	}
	if _, err = s.AuthenticateSession(ctx, uid, sid); err == nil || calls.Load() != 1 {
		t.Fatal("expired local session bypassed validation with a cached upstream lease", err, calls.Load())
	}
	if _, err = db.Exec(ctx, "UPDATE sessions SET expires_at=now()+interval '1 hour' WHERE id=$1", sid); err != nil {
		t.Fatal(err)
	}
	if _, err = s.AuthenticateSession(ctx, uid, sid); err != nil || calls.Load() != 1 {
		t.Fatal("healthy local session did not reuse the valid upstream lease", err, calls.Load())
	}
	if err = s.RevokeSession(ctx, sid); err != nil {
		t.Fatal(err)
	}
	if _, err = s.AuthenticateSession(ctx, uid, sid); err == nil || calls.Load() != 1 {
		t.Fatal("revoked local session bypassed validation with a cached upstream lease", err, calls.Load())
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
