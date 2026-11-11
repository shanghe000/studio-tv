package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/auth/oidcrp"
	coreconfig "studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/security"
)

func TestSessionDeadlineIsExactlySevenTimesTwentyFourHours(t *testing.T) {
	// A fixed duration also spans a calendar's daylight-saving transition.
	now := time.Date(2026, 3, 7, 18, 20, 0, 0, time.FixedZone("before-DST", -5*60*60))
	deadline := now.Add(168 * time.Hour)
	for _, test := range []struct {
		name     string
		upstream time.Time
		want     time.Time
	}{
		{"long upstream cannot extend seven days", now.Add(30 * 24 * time.Hour), deadline},
		{"exact upstream deadline", deadline, deadline},
		{"shorter real upstream deadline", now.Add(2 * time.Hour), now.Add(2 * time.Hour)},
		{"expired upstream remains expired", now.Add(-time.Second), now.Add(-time.Second)},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := sessionExpiryAt(now, test.upstream); !got.Equal(test.want) {
				t.Fatal("session deadline changed", got, test.want)
			}
		})
	}
	if sessionLifetime != 168*time.Hour || deadline.Sub(now) != 168*time.Hour {
		t.Fatal("session lifetime is not exactly seven 24-hour periods")
	}
}

func TestRefreshRaceGraceHasExactNonSlidingBoundary(t *testing.T) {
	consumed := time.Date(2026, 10, 7, 1, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		offset time.Duration
		want   bool
	}{
		{-time.Nanosecond, false},
		{0, true},
		{refreshRaceGrace - time.Nanosecond, true},
		{refreshRaceGrace, false},
		{refreshRaceGrace + time.Nanosecond, false},
		{24 * time.Hour, false},
	} {
		if got := refreshRaceAt(consumed.Add(test.offset), consumed); got != test.want {
			t.Fatalf("offset %s: got %v, want %v", test.offset, got, test.want)
		}
	}
}

func lifetimeTestService(t *testing.T, db *pgxpool.Pool, mutate func(*sessionStatus)) *Service {
	t.Helper()
	server := statusTestServer(t, mutate)
	base := coreconfig.Config{SigningSecret: strings.Repeat("t", 40), Issuer: "rhtv-service", Audience: "rhtv-web", PublicBaseURL: "http://localhost:18880", AllowLocalHTTP: true, AllowedOrigins: []string{"http://localhost:18880"}}
	return &Service{base: base, db: db, tokens: security.New(base), cfg: Config{IssuerURL: "https://ipac.example", BaseURL: server.URL, ClientID: "test-client", ClientSecret: "test-only-secret"}}
}

func lifetimeRefreshRequest(s *Service, raw, csrf string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/sessions/refresh", nil)
	r.AddCookie(&http.Cookie{Name: s.cookieName("refresh"), Value: raw})
	r.AddCookie(&http.Cookie{Name: s.cookieName("csrf"), Value: csrf})
	r.Header.Set("X-CSRF-Token", csrf)
	r.Header.Set("Origin", s.base.PublicBaseURL)
	return r
}

func TestPostgresSevenDaySessionRefreshNeverSlidesAndExpiresDespiteValidJWT(t *testing.T) {
	db := authTestDatabase(t)
	ctx := context.Background()
	var upstreamExpiry atomic.Int64
	upstreamExpiry.Store(time.Now().Add(30 * 24 * time.Hour).UnixNano())
	var checks atomic.Int64
	s := lifetimeTestService(t, db, func(state *sessionStatus) {
		checks.Add(1)
		state.ExpiresAt = time.Unix(0, upstreamExpiry.Load()).UTC()
	})
	before := time.Now()
	identity := oidcrp.Identity{SubjectID: "seven-day-employee", SessionID: "real-seven-day-ipac-sid", SessionVersion: 1}
	uid, sid, raw, err := s.establish(ctx, identity)
	if err != nil {
		t.Fatal(err)
	}
	after := time.Now()
	var deadline, tokenDeadline time.Time
	if err := db.QueryRow(ctx, `SELECT s.expires_at,t.expires_at FROM sessions s JOIN refresh_tokens t ON t.session_id=s.id WHERE s.id=$1`, sid).Scan(&deadline, &tokenDeadline); err != nil {
		t.Fatal(err)
	}
	if deadline.Before(before.Add(168*time.Hour)) || deadline.After(after.Add(168*time.Hour)) || !deadline.Equal(tokenDeadline) {
		t.Fatal("login did not persist one fixed seven-day session/token deadline", deadline, tokenDeadline)
	}
	for i := 0; i < 3; i++ {
		next := httpapi.RandomToken()
		gotUID, gotSID, gotExpiry, err := s.rotate(ctx, raw, next)
		if err != nil || gotUID != uid || gotSID != sid || !gotExpiry.Equal(deadline) {
			t.Fatal("rotation changed the principal or slid the seven-day deadline", gotExpiry, err)
		}
		if err := db.QueryRow(ctx, `SELECT expires_at FROM refresh_tokens WHERE token_hash=$1`, security.Digest(next)).Scan(&tokenDeadline); err != nil || !tokenDeadline.Equal(deadline) {
			t.Fatal("rotated refresh token changed its absolute deadline", tokenDeadline, err)
		}
		raw = next
	}
	// A later upstream extension still cannot extend the original local login.
	upstreamExpiry.Store(time.Now().Add(60 * 24 * time.Hour).UnixNano())
	next := httpapi.RandomToken()
	if _, _, expiry, err := s.rotate(ctx, raw, next); err != nil || !expiry.Equal(deadline) {
		t.Fatal("upstream extension slid the local seven-day window", expiry, err)
	}
	raw = next
	// A genuine shorter upstream deadline must shorten both stored lifetimes.
	shorter := time.Now().UTC().Truncate(time.Second).Add(90 * time.Second)
	upstreamExpiry.Store(shorter.UnixNano())
	next = httpapi.RandomToken()
	if _, _, expiry, err := s.rotate(ctx, raw, next); err != nil || !expiry.Equal(shorter) {
		t.Fatal("shorter upstream deadline was ignored", expiry, err)
	}
	raw = next
	if err := db.QueryRow(ctx, `SELECT s.expires_at,t.expires_at FROM sessions s JOIN refresh_tokens t ON t.session_id=s.id WHERE t.token_hash=$1`, security.Digest(raw)).Scan(&deadline, &tokenDeadline); err != nil || !deadline.Equal(shorter) || !tokenDeadline.Equal(shorter) {
		t.Fatal("upstream deadline did not persist in local session and next token", deadline, tokenDeadline, err)
	}
	csrf, err := s.tokens.Sign(map[string]any{"nonce": "seven-day-test"}, "csrf", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	if err := s.refresh(w, lifetimeRefreshRequest(s, raw, csrf)); err != nil {
		t.Fatal(err)
	}
	var response struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || len(response.Data) != 4 || string(response.Data["expiresIn"]) != "900" || response.Data["sessionExpiresAt"] != nil {
		t.Fatal("frozen v1 Session response changed", err)
	}
	var access string
	if err := json.Unmarshal(response.Data["accessToken"], &access); err != nil || access == "" {
		t.Fatal("refresh did not issue a short access JWT", err)
	}
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == s.cookieName("refresh") {
			raw = cookie.Value
			if !cookie.Expires.Equal(shorter) || cookie.MaxAge < 1 || cookie.MaxAge > 90 || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode {
				t.Fatal("refresh cookie exceeded the actual absolute deadline")
			}
		}
	}
	// Move the test's own persisted deadline to its boundary, without sleeping.
	// The still-valid 15-minute JWT must never bypass a day-seven/local expiry.
	if _, err := db.Exec(ctx, `UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, sid); err != nil {
		t.Fatal(err)
	}
	if _, err := s.tokens.Verify(access, "access"); err != nil {
		t.Fatal("test JWT expired before local-session boundary was exercised", err)
	}
	beforeChecks := checks.Load()
	r := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	r.Header.Set("Authorization", "Bearer "+access)
	if _, err := s.Authenticate(ctx, r); err == nil {
		t.Fatal("expired absolute session accepted a valid short JWT")
	}
	if _, err := s.AuthenticateSession(ctx, uid, sid); err == nil {
		t.Fatal("signed-media session resolution bypassed absolute expiry")
	}
	if _, _, _, err := s.rotate(ctx, raw, httpapi.RandomToken()); err == nil {
		t.Fatal("expired seven-day session renewed itself")
	}
	if checks.Load() != beforeChecks {
		t.Fatal("expired local session reached the upstream verification lease")
	}
}

func TestPostgresConcurrentRefreshRaceFailsWithoutRevokingWinner(t *testing.T) {
	db := authTestDatabase(t)
	ctx := context.Background()
	var blocked atomic.Bool
	arrived, release := make(chan struct{}, 1), make(chan struct{})
	var once sync.Once
	s := lifetimeTestService(t, db, func(state *sessionStatus) {
		state.ExpiresAt = time.Now().Add(168 * time.Hour)
		if blocked.Load() {
			select {
			case arrived <- struct{}{}:
			default:
			}
			<-release
		}
	})
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	uid, sid, raw, err := s.establish(ctx, oidcrp.Identity{SubjectID: "parallel-employee", SessionID: "parallel-real-sid", SessionVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	csrf, err := s.tokens.Sign(map[string]any{"nonce": "parallel-test"}, "csrf", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	blocked.Store(true)
	type result struct {
		w   *httptest.ResponseRecorder
		err error
	}
	results := make(chan result, 2)
	refresh := func() {
		w := httptest.NewRecorder()
		err := s.refresh(w, lifetimeRefreshRequest(s, raw, csrf))
		results <- result{w, err}
	}
	go refresh()
	select {
	case <-arrived:
	case <-time.After(5 * time.Second):
		t.Fatal("first rotation did not hold the owned refresh row")
	}
	go refresh()
	blocked.Store(false)
	once.Do(func() { close(release) })
	var winner result
	var success, races int
	for i := 0; i < 2; i++ {
		var got result
		select {
		case got = <-results:
		case <-time.After(5 * time.Second):
			t.Fatal("parallel rotation did not finish")
		}
		if got.err == nil {
			winner, success = got, success+1
			continue
		}
		var failure *httpapi.Error
		if !errors.As(got.err, &failure) || failure.Status != 401 || failure.Code != "REFRESH_RACE_RETRY" || !failure.Retryable || got.w.Header().Get("Retry-After") != "1" || len(got.w.Result().Cookies()) != 0 || got.w.Body.Len() != 0 {
			t.Fatal("losing refresh received credentials, deleted cookies, or failed permanently", got.err)
		}
		races++
	}
	if success != 1 || races != 1 {
		t.Fatal("parallel refresh did not produce one winner and one retryable refusal", success, races)
	}
	var next string
	for _, cookie := range winner.w.Result().Cookies() {
		if cookie.Name == s.cookieName("refresh") {
			next = cookie.Value
		}
	}
	if next == "" || next == raw {
		t.Fatal("winner did not receive a rotated cookie")
	}
	if _, err := s.AuthenticateSession(ctx, uid, sid); err != nil {
		t.Fatal("loser revoked the winning session", err)
	}
	if _, _, _, err := s.rotate(ctx, next, httpapi.RandomToken()); err != nil {
		t.Fatal("browser could not retry with the winner's updated cookie", err)
	}
	// The grace is available only after the ordinary HTTP Origin/CSRF checks.
	wrongCSRF := lifetimeRefreshRequest(s, raw, "forged-csrf")
	if err := s.refresh(httptest.NewRecorder(), wrongCSRF); err == nil {
		t.Fatal("refresh race bypassed CSRF validation")
	}
	var revoked bool
	if err := db.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM sessions WHERE id=$1`, sid).Scan(&revoked); err != nil || revoked {
		t.Fatal("legitimate parallel refresh or rejected CSRF revoked the session", err)
	}
}

func TestPostgresRefreshRaceNeverProtectsInvalidSession(t *testing.T) {
	db := authTestDatabase(t)
	ctx := context.Background()
	s := lifetimeTestService(t, db, func(state *sessionStatus) {
		state.ExpiresAt = time.Now().Add(168 * time.Hour)
	})
	csrf, err := s.tokens.Sign(map[string]any{"nonce": "invalid-session-test"}, "csrf", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name string
		sql  string
	}{
		{"explicit logout", `UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1`},
		{"disabled account", `UPDATE users SET disabled=true WHERE id=(SELECT user_id FROM sessions WHERE id=$1)`},
		{"expired absolute session", `UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`},
		{"expired consumed token", `UPDATE refresh_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1`},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, sid, raw, err := s.establish(ctx, oidcrp.Identity{SubjectID: "invalid-" + test.name, SessionID: "ipac-" + test.name, SessionVersion: 1})
			if err != nil {
				t.Fatal(err)
			}
			if _, _, _, err = s.rotate(ctx, raw, httpapi.RandomToken()); err != nil {
				t.Fatal(err)
			}
			if _, err = db.Exec(ctx, test.sql, sid); err != nil {
				t.Fatal(err)
			}
			w := httptest.NewRecorder()
			err = s.refresh(w, lifetimeRefreshRequest(s, raw, csrf))
			var failure *httpapi.Error
			if !errors.As(err, &failure) || failure.Status != 401 || failure.Code != "REFRESH_REVOKED" || w.Header().Get("Retry-After") != "" {
				t.Fatal("refresh grace protected an invalid local session", err)
			}
			cookies := w.Result().Cookies()
			if len(cookies) != 1 || cookies[0].Name != s.cookieName("refresh") || cookies[0].MaxAge != -1 || cookies[0].Value != "" {
				t.Fatal("permanent refusal did not clear its refresh cookie")
			}
		})
	}
}
