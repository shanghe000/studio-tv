package auth

import (
	"context"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"studiotv.local/service/api/internal/auth/oidcrp"
	coreconfig "studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/security"
)

func TestPostgresLiveIdentityDeadlinesUseVerifiedTokenAndCurrentSession(t *testing.T) {
	db := authTestDatabase(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	var upstreamExpiry atomic.Int64
	upstreamExpiry.Store(now.Add(time.Hour).Unix())
	server := statusTestServer(t, func(state *sessionStatus) {
		state.ExpiresAt = time.Unix(upstreamExpiry.Load(), 0).UTC()
	})
	base := coreconfig.Config{SigningSecret: strings.Repeat("t", 40), Issuer: "rhtv-service", Audience: "rhtv-web", PublicBaseURL: "http://localhost:18880", AllowLocalHTTP: true}
	s := &Service{base: base, db: db, tokens: security.New(base), cfg: Config{IssuerURL: "https://ipac.example", BaseURL: server.URL, ClientID: "test-client", ClientSecret: "test-only-secret"}}
	uid, sid, _, err := s.establish(ctx, oidcrp.Identity{SubjectID: "live-expiry-employee", SessionID: "live-expiry-session", SessionVersion: 1, DisplayName: "测试员工"})
	if err != nil {
		t.Fatal(err)
	}
	localExpiry := now.Add(20 * time.Minute)
	if _, err = db.Exec(ctx, "UPDATE sessions SET expires_at=$2 WHERE id=$1", sid, localExpiry); err != nil {
		t.Fatal(err)
	}
	access, err := s.tokens.Sign(map[string]any{"sub": uid, "sid": sid}, "access", 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/api/v2/projects/p/events?expiresAt=4102444800", nil)
	r.Header.Set("Authorization", "Bearer "+access)
	r.Header.Set("X-Access-Expires-At", "4102444800")
	who, err := s.Authenticate(ctx, r)
	if err != nil || who.AccessExpiresAt.Before(now.Add(4*time.Minute)) || who.AccessExpiresAt.After(time.Now().Add(5*time.Minute)) || !who.SessionExpiresAt.Equal(localExpiry) {
		t.Fatalf("deadline must come from verified token and persisted session: %+v, %v", who, err)
	}
	tokenExpiry := who.AccessExpiresAt
	if who.AccessIssuedAt.Before(now) || who.AccessIssuedAt.After(time.Now()) {
		t.Fatalf("issued time must come from verified JWT: %+v", who)
	}
	shorter := now.Add(2 * time.Minute)
	upstreamExpiry.Store(shorter.Unix())
	who, err = s.Authenticate(ctx, r)
	if err != nil || !who.SessionExpiresAt.Equal(localExpiry) {
		t.Fatalf("ordinary request did not retain its bounded verified lifetime: %+v, %v", who, err)
	}
	// Exact TTL and upstream hard-expiry boundaries are clock-driven in the
	// generic lease tests. Invalidate to exercise the next verification here.
	key := sessionStatusRequest{SubjectID: "live-expiry-employee", SessionID: "live-expiry-session", SessionVersion: 1}
	s.sessionLease().Delete(key)
	who, err = s.Authenticate(ctx, r)
	if err != nil || !who.SessionExpiresAt.Equal(shorter) || !who.AccessExpiresAt.Equal(tokenExpiry) {
		t.Fatalf("upstream shortening was not observed on a fresh verification: %+v, %v", who, err)
	}
	upstreamExpiry.Store(now.Add(2 * time.Hour).Unix())
	s.sessionLease().Delete(key)
	who, err = s.Authenticate(ctx, r)
	if err != nil || !who.SessionExpiresAt.Equal(localExpiry) {
		t.Fatalf("upstream extension exceeded persisted local lifetime: %+v, %v", who, err)
	}
	// Session-only credentials may authenticate asset reads, but must never
	// manufacture a Bearer expiry acceptable for a long-lived project stream.
	who, err = s.AuthenticateSession(ctx, uid, sid)
	if err != nil || !who.AccessExpiresAt.IsZero() || !who.SessionExpiresAt.Equal(localExpiry) {
		t.Fatalf("session-only authentication invented an access expiry: %+v, %v", who, err)
	}
}
