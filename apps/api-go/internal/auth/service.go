package auth

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/auth/oidcrp"
	coreconfig "studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/ipachttp"
	"studiotv.local/service/api/internal/ipaclease"
	"studiotv.local/service/api/internal/security"
)

// A new verified Feishu login establishes one absolute deadline. Refresh-token
// rotation never moves it; upstream expiry/revocation can shorten it.
const sessionLifetime = 7 * 24 * time.Hour
const accessLifetime = 15 * time.Minute
const transactionLifetime = 5 * time.Minute
const refreshRaceGrace = 5 * time.Second

type Service struct {
	base         coreconfig.Config
	cfg          Config
	db           *pgxpool.Pool
	tokens       *security.Tokens
	mu           sync.Mutex
	oidc         *oidcrp.Client
	statusHTTP   *http.Client
	leaseMu      sync.Mutex
	sessionCache *ipaclease.Cache[sessionStatusRequest, sessionStatus]
	probeCache   *ipaclease.Cache[bool, bool]
	decorateHTTP func(http.RoundTripper) http.RoundTripper
}

func New(base coreconfig.Config, db *pgxpool.Pool, tokens *security.Tokens, decorators ...func(http.RoundTripper) http.RoundTripper) (*Service, error) {
	if len(decorators) > 1 {
		return nil, errors.New("one IPAC transport decorator is permitted")
	}
	cfg, err := LoadConfig(base)
	if err != nil {
		return nil, err
	}
	s := &Service{base: base, cfg: cfg, db: db, tokens: tokens}
	if len(decorators) == 1 {
		s.decorateHTTP = decorators[0]
	}
	s.statusHTTP = s.httpClient(3 * time.Second)
	return s, nil
}

func (s *Service) httpClient(timeout time.Duration) *http.Client {
	client := ipachttp.NewClient(timeout)
	if s.decorateHTTP != nil {
		client.Transport = s.decorateHTTP(client.Transport)
	}
	return client
}

func (s *Service) RegisterRoutes(r chi.Router) {
	r.Get("/api/v1/auth/config", httpapi.Wrap(s.configuration))
	r.Get("/api/v1/auth/feishu/login", httpapi.Wrap(s.login))
	r.Get("/api/v1/auth/feishu/callback", httpapi.Wrap(s.callback))
	r.Get("/api/v1/auth/csrf", httpapi.Wrap(s.csrf))
	r.Post("/api/v1/auth/sessions", httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
		return httpapi.Fail(501, "AUTH_METHOD_UNAVAILABLE", "请通过统一飞书登录；账号密码和验证码登录未启用。")
	}))
	r.Post("/api/v1/auth/sessions/refresh", httpapi.Wrap(s.refresh))
	r.Post("/api/v1/auth/refresh", httpapi.Wrap(s.refresh))
	r.Delete("/api/v1/auth/session", httpapi.Wrap(s.logout))
	r.Post("/api/v1/auth/logout", httpapi.Wrap(s.logout))
	r.Get("/api/v1/me", httpapi.RequireAuth(s, s.me))
	r.Patch("/api/v1/me/preferences", httpapi.RequireAuth(s, s.preferences))
}

func (s *Service) cookieName(purpose string) string {
	if s.base.SecureCookies {
		return "__Host-rhtv_" + purpose
	}
	return "rhtv_dev_" + purpose
}

func (s *Service) setCookie(w http.ResponseWriter, purpose, value string, age int) {
	cookie := &http.Cookie{Name: s.cookieName(purpose), Value: value, Path: "/", Secure: s.base.SecureCookies, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: age}
	if age < 0 {
		cookie.Expires = time.Unix(1, 0)
	} else {
		cookie.Expires = time.Now().Add(time.Duration(age) * time.Second)
	}
	http.SetCookie(w, cookie)
}

func (s *Service) setRefreshCookie(w http.ResponseWriter, value string, expiry time.Time) error {
	age := int(time.Until(expiry).Seconds())
	if age < 1 {
		s.setCookie(w, "refresh", "", -1)
		return httpapi.Fail(401, "REFRESH_REVOKED", "登录会话已到期，请重新使用飞书登录。")
	}
	http.SetCookie(w, &http.Cookie{Name: s.cookieName("refresh"), Value: value, Path: "/", Secure: s.base.SecureCookies, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: age, Expires: expiry.UTC()})
	return nil
}

func cookie(r *http.Request, name string) string {
	value, err := r.Cookie(name)
	if err != nil {
		return ""
	}
	return value.Value
}

func (s *Service) configuration(w http.ResponseWriter, r *http.Request) error {
	reason := s.cfg.unavailableReason()
	if reason == "" {
		if _, err := s.cachedProtocolProbe(r.Context()); err != nil {
			reason = "IPAC_SESSION_STATUS_UNAVAILABLE"
		}
	}
	var reasonValue any
	if reason != "" {
		reasonValue = reason
	}
	return httpapi.OK(w, r, 200, map[string]any{"provider": "IPAC_FEISHU", "configured": reason == "", "loginUrl": "/api/v1/auth/feishu/login", "unavailableReason": reasonValue})
}

func (s *Service) requireConfigured() error {
	if reason := s.cfg.unavailableReason(); reason != "" {
		message := "统一飞书登录尚未配置，请联系管理员完成接入。"
		return httpapi.Fail(503, reason, message)
	}
	return nil
}

func (s *Service) client(ctx context.Context) (*oidcrp.Client, error) {
	if err := s.requireConfigured(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.oidc != nil {
		return s.oidc, nil
	}
	client, err := oidcrp.New(ctx, oidcrp.Config{IssuerURL: s.cfg.IssuerURL, ClientID: s.cfg.ClientID, ClientSecret: s.cfg.ClientSecret, RedirectURL: s.cfg.RedirectURI, AllowInsecureHTTP: s.cfg.AllowInsecureHTTP, HTTPClient: s.httpClient(5 * time.Second)})
	if err != nil {
		return nil, httpapi.Retry(503, "IPAC_UNAVAILABLE", "统一登录服务暂时不可用，请稍后重试。")
	}
	s.oidc = client
	return client, nil
}

func (s *Service) login(w http.ResponseWriter, r *http.Request) error {
	if err := s.checkOrigin(r); err != nil {
		return err
	}
	if err := rejectTeam(r); err != nil {
		return err
	}
	client, err := s.client(r.Context())
	if err != nil {
		return err
	}
	returnTo := r.URL.Query().Get("returnTo")
	if returnTo == "" {
		returnTo = "/projects/"
	}
	if len(r.URL.Query()["returnTo"]) > 1 || !safeReturnTo(returnTo) {
		return httpapi.Fail(400, "RETURN_TO_INVALID", "登录后的返回位置必须是有效的站内路径。")
	}
	authorization, err := client.Begin(returnTo)
	if err != nil {
		return httpapi.Fail(400, "RETURN_TO_INVALID", "登录后的返回位置必须是站内路径。")
	}
	beginURL, err := feishuStartURL(s.cfg.IssuerURL, authorization.URL)
	if err != nil {
		return httpapi.Fail(503, "IPAC_PROTOCOL_UNSUPPORTED", "统一登录地址与配置不一致。")
	}
	raw := httpapi.RandomToken()
	encoded, err := json.Marshal(authorization.Transaction)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(r.Context(), "INSERT INTO oidc_login_transactions(token_hash,transaction,expires_at) VALUES($1,$2::jsonb,now()+interval '5 minutes')", security.Digest(raw), encoded)
	if err != nil {
		return unavailable()
	}
	s.setCookie(w, "oidc", raw, int(transactionLifetime.Seconds()))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	http.Redirect(w, r, beginURL, http.StatusFound)
	return nil
}

func safeReturnTo(raw string) bool {
	if len(raw) > 4096 || strings.ContainsAny(raw, "\r\n\\") {
		return false
	}
	u, err := url.ParseRequestURI(raw)
	if err != nil || u.IsAbs() || u.Host != "" || u.Fragment != "" || !strings.HasPrefix(u.Path, "/") || strings.HasPrefix(u.Path, "//") || strings.ContainsAny(u.Path, "\r\n\\") {
		return false
	}
	path := strings.TrimRight(u.Path, "/")
	return path != "/login" && path != "/auth" && !strings.HasPrefix(path, "/auth/") && path != "/api/v1/auth" && !strings.HasPrefix(path, "/api/v1/auth/")
}

// IPAC already supports a safe authorize continuation in its dedicated Feishu
// start handler. This avoids offering the generic password-login screen; the
// callback still independently checks trustworthy source evidence.
func feishuStartURL(issuer, authorization string) (string, error) {
	u, err := url.Parse(authorization)
	if err != nil {
		return "", err
	}
	i, err := url.Parse(issuer)
	if err != nil {
		return "", err
	}
	if u.Scheme != i.Scheme || u.Host != i.Host || u.Path != "/oauth2/authorize" || u.Fragment != "" || u.User != nil {
		return "", errors.New("authorization endpoint is not an IPAC authorize continuation")
	}
	start := *i
	start.Path = "/oauth2/feishu/start"
	start.RawQuery = url.Values{"return_to": {u.RequestURI()}}.Encode()
	return start.String(), nil
}

func (s *Service) consumeTransaction(ctx context.Context, raw string) (oidcrp.Transaction, error) {
	var transaction oidcrp.Transaction
	if raw == "" {
		return transaction, httpapi.Fail(401, "LOGIN_TRANSACTION_INVALID", "登录请求已失效，请重新登录。")
	}
	var encoded []byte
	var unexpired bool
	err := s.db.QueryRow(ctx, "DELETE FROM oidc_login_transactions WHERE token_hash=$1 RETURNING transaction, expires_at>now()", security.Digest(raw)).Scan(&encoded, &unexpired)
	// The SDK also validates the transaction timestamp, including future dates.
	if errors.Is(err, pgx.ErrNoRows) {
		return transaction, httpapi.Fail(401, "LOGIN_TRANSACTION_INVALID", "登录请求已失效，请重新登录。")
	}
	if err != nil {
		return transaction, unavailable()
	}
	if !unexpired {
		return transaction, httpapi.Fail(401, "LOGIN_TRANSACTION_INVALID", "登录请求已失效，请重新登录。")
	}
	if json.Unmarshal(encoded, &transaction) != nil {
		return transaction, httpapi.Fail(401, "LOGIN_TRANSACTION_INVALID", "登录请求已失效，请重新登录。")
	}
	return transaction, nil
}

func (s *Service) callback(w http.ResponseWriter, r *http.Request) error {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	client, err := s.client(r.Context())
	if err != nil {
		return err
	}
	for _, key := range []string{"state", "code", "error", "error_description"} {
		if len(r.URL.Query()[key]) > 1 {
			return httpapi.Fail(400, "CALLBACK_INVALID", "登录回调参数无效。")
		}
	}
	raw := cookie(r, s.cookieName("oidc"))
	s.setCookie(w, "oidc", "", -1)
	transaction, err := s.consumeTransaction(r.Context(), raw)
	if err != nil {
		return err
	}
	q := r.URL.Query()
	identity, err := client.Exchange(r.Context(), oidcrp.Callback{State: q.Get("state"), Code: q.Get("code"), Error: q.Get("error"), ErrorDescription: q.Get("error_description")}, transaction)
	if err != nil {
		return httpapi.Fail(401, "IPAC_AUTHENTICATION_FAILED", "统一登录校验失败，请重新使用飞书登录。")
	}
	userID, sessionID, refresh, err := s.establish(r.Context(), identity.Identity)
	if err != nil {
		return err
	}
	who, err := s.AuthenticateSession(r.Context(), userID, sessionID)
	if err != nil {
		return err
	}
	if err = s.setRefreshCookie(w, refresh, who.SessionExpiresAt); err != nil {
		return err
	}
	http.Redirect(w, r, identity.ReturnTo, http.StatusSeeOther)
	return nil
}

func (s *Service) establish(ctx context.Context, identity oidcrp.Identity) (userID, sessionID, refresh string, err error) {
	state, err := s.verifiedSession(ctx, identity)
	if err != nil {
		return "", "", "", err
	}
	expires := minSessionExpiry(state.ExpiresAt)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", "", "", unavailable()
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", s.cfg.IssuerURL+"\x1f"+identity.SubjectID)
	if err != nil {
		return "", "", "", unavailable()
	}
	err = tx.QueryRow(ctx, "SELECT user_id FROM federated_identities WHERE issuer=$1 AND subject_id=$2", s.cfg.IssuerURL, identity.SubjectID).Scan(&userID)
	name := strings.TrimSpace(identity.DisplayName)
	if name == "" {
		name = "飞书用户"
	}
	name = truncate(name, 120)
	avatar := safeAvatar(identity.AvatarURL)
	if errors.Is(err, pgx.ErrNoRows) {
		userID = "usr_" + strings.ReplaceAll(uuid.NewString(), "-", "")
		// Synthetic email occupies the legacy schema field. Never merge by an
		// upstream email/name, and never expose this synthetic identifier.
		email := "ipac_" + security.Digest(s.cfg.IssuerURL+"\x1f"+identity.SubjectID) + "@identity.invalid"
		_, err = tx.Exec(ctx, "INSERT INTO users(id,email,password_hash,display_name,avatar_url) VALUES($1,$2,NULL,$3,$4)", userID, email, name, avatar)
		if err == nil {
			_, err = tx.Exec(ctx, "INSERT INTO federated_identities(issuer,subject_id,user_id,provider) VALUES($1,$2,$3,'feishu')", s.cfg.IssuerURL, identity.SubjectID, userID)
		}
	} else if err == nil {
		var disabled bool
		err = tx.QueryRow(ctx, "SELECT disabled FROM users WHERE id=$1 FOR UPDATE", userID).Scan(&disabled)
		if err == nil && disabled {
			return "", "", "", httpapi.Fail(403, "ACCOUNT_DISABLED", "当前账号已停用。")
		}
		if err == nil {
			_, err = tx.Exec(ctx, "UPDATE users SET display_name=$2,avatar_url=$3 WHERE id=$1", userID, name, avatar)
		}
	}
	if err != nil {
		return "", "", "", unavailable()
	}
	sessionID = "ses_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	refresh = httpapi.RandomToken()
	_, err = tx.Exec(ctx, "INSERT INTO sessions(id,user_id,expires_at,ipac_issuer,ipac_subject,ipac_session_id,ipac_session_version) VALUES($1,$2,$3,$4,$5,$6,$7)", sessionID, userID, expires, s.cfg.IssuerURL, identity.SubjectID, identity.SessionID, identity.SessionVersion)
	if err == nil {
		_, err = tx.Exec(ctx, "INSERT INTO refresh_tokens(token_hash,session_id,expires_at) SELECT $1,id,expires_at FROM sessions WHERE id=$2", security.Digest(refresh), sessionID)
	}
	if err != nil {
		return "", "", "", unavailable()
	}
	if err = tx.Commit(ctx); err != nil {
		return "", "", "", unavailable()
	}
	return userID, sessionID, refresh, nil
}

func (s *Service) Authenticate(ctx context.Context, r *http.Request) (httpapi.Identity, error) {
	match := regexp.MustCompile(`^Bearer ([A-Za-z0-9_.-]+)$`).FindStringSubmatch(r.Header.Get("Authorization"))
	if len(match) != 2 {
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "请先使用统一飞书登录。")
	}
	claims, err := s.tokens.Verify(match[1], "access")
	if err != nil {
		return httpapi.Identity{}, err
	}
	if err := s.requireConfigured(); err != nil {
		return httpapi.Identity{}, err
	}
	uid, _ := claims["sub"].(string)
	sid, _ := claims["sid"].(string)
	if uid == "" || sid == "" {
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "登录状态无效。")
	}
	identity, err := s.AuthenticateSession(ctx, uid, sid)
	if err != nil {
		return httpapi.Identity{}, err
	}
	expiry, err := claims.GetExpirationTime()
	if err != nil || expiry == nil {
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "登录凭据缺少有效截止时间。")
	}
	identity.AccessExpiresAt = expiry.Time
	issued, err := claims.GetIssuedAt()
	if err != nil || issued == nil || issued.Time.After(time.Now()) || !issued.Time.Before(expiry.Time) {
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "登录凭据签发时间无效。")
	}
	identity.AccessIssuedAt = issued.Time
	return identity, nil
}

// AuthenticateSession resolves only a previously persisted local session.
// It is shared by bearer authentication and short-lived signed media URLs;
// neither caller may supply its own IPAC principal or workspace identity.
func (s *Service) AuthenticateSession(ctx context.Context, uid, sid string) (httpapi.Identity, error) {
	if err := s.requireConfigured(); err != nil {
		return httpapi.Identity{}, err
	}
	if uid == "" || sid == "" {
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "登录状态无效。")
	}
	var who httpapi.Identity
	who.UserID, who.SessionID = uid, sid
	err := s.db.QueryRow(ctx, "SELECT s.ipac_issuer,s.ipac_subject,s.ipac_session_id,s.ipac_session_version,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.ipac_issuer=$3 AND s.ipac_subject IS NOT NULL AND s.ipac_session_id IS NOT NULL AND s.ipac_session_version>0 AND NOT u.disabled", sid, uid, s.cfg.IssuerURL).Scan(&who.IPACIssuer, &who.IPACSubjectID, &who.IPACSessionID, &who.IPACSessionVersion, &who.SessionExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "登录状态已撤销或过期。")
	}
	if err != nil {
		return httpapi.Identity{}, unavailable()
	}
	upstream, err := s.cachedVerifiedSession(ctx, oidcrp.Identity{SubjectID: who.IPACSubjectID, SessionID: who.IPACSessionID, SessionVersion: who.IPACSessionVersion})
	if err != nil {
		if isSessionRevoked(err) {
			if revokeErr := s.RevokeSession(ctx, sid); revokeErr != nil {
				return httpapi.Identity{}, revokeErr
			}
		}
		return httpapi.Identity{}, err
	}
	if upstream.ExpiresAt.Before(who.SessionExpiresAt) {
		who.SessionExpiresAt = upstream.ExpiresAt
	}
	return who, nil
}

func (s *Service) RevokeSession(ctx context.Context, sid string) error {
	if sid == "" {
		return nil
	}
	_, err := s.db.Exec(ctx, "UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1", sid)
	if err != nil {
		return unavailable()
	}
	return nil
}

func minSessionExpiry(upstream time.Time) time.Time {
	return sessionExpiryAt(time.Now(), upstream)
}

func sessionExpiryAt(now, upstream time.Time) time.Time {
	local := now.Add(sessionLifetime)
	if upstream.Before(local) {
		return upstream
	}
	return local
}

func unavailable() error {
	return httpapi.Retry(503, "AUTH_BACKEND_UNAVAILABLE", "登录服务暂时不可用，请稍后重试。")
}
func truncate(raw string, length int) string {
	if utf8.RuneCountInString(raw) <= length {
		return raw
	}
	return string([]rune(raw)[:length])
}
func safeAvatar(raw string) any {
	if len(raw) > 4096 {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return nil
	}
	return raw
}

func (s *Service) checkOrigin(r *http.Request) error {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return nil
	}
	for _, allowed := range s.base.AllowedOrigins {
		if origin == allowed {
			return nil
		}
	}
	return httpapi.Fail(403, "ORIGIN_FORBIDDEN", "请求来源不受信任。")
}

func rejectTeam(r *http.Request) error {
	if _, ok := r.Header["X-Team-Id"]; ok {
		return httpapi.Fail(403, "TEAM_SCOPE_UNAVAILABLE", "团队空间尚未启用。")
	}
	return nil
}

func (s *Service) csrf(w http.ResponseWriter, r *http.Request) error {
	if err := s.checkOrigin(r); err != nil {
		return err
	}
	raw := cookie(r, s.cookieName("csrf"))
	if _, err := s.tokens.Verify(raw, "csrf"); err != nil {
		raw = ""
	}
	if raw == "" {
		var err error
		raw, err = s.tokens.Sign(map[string]any{"nonce": httpapi.RandomToken()}, "csrf", 24*time.Hour)
		if err != nil {
			return err
		}
	}
	s.setCookie(w, "csrf", raw, 86400)
	return httpapi.OK(w, r, 200, map[string]any{"csrfToken": raw})
}

func (s *Service) requireCsrf(r *http.Request) error {
	if err := s.checkOrigin(r); err != nil {
		return err
	}
	if err := rejectTeam(r); err != nil {
		return err
	}
	raw := cookie(r, s.cookieName("csrf"))
	header := r.Header.Get("X-CSRF-Token")
	if raw == "" || len(raw) != len(header) || subtle.ConstantTimeCompare([]byte(raw), []byte(header)) != 1 {
		return httpapi.Fail(403, "CSRF_INVALID", "CSRF 校验失败，请重新获取令牌。")
	}
	if _, err := s.tokens.Verify(raw, "csrf"); err != nil {
		return httpapi.Fail(403, "CSRF_INVALID", "CSRF 令牌已过期。")
	}
	return nil
}

func (s *Service) refresh(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireCsrf(r); err != nil {
		return err
	}
	raw := cookie(r, s.cookieName("refresh"))
	if raw == "" {
		return httpapi.Fail(401, "UNAUTHENTICATED", "刷新会话不存在。")
	}
	if err := s.requireConfigured(); err != nil {
		return err
	}
	next := httpapi.RandomToken()
	uid, sid, expiry, err := s.rotate(r.Context(), raw, next)
	if err != nil {
		var failure *httpapi.Error
		if errors.As(err, &failure) && failure.Code == "REFRESH_RACE_RETRY" {
			// Another same-browser tab may still be receiving the winning cookie.
			// The old token receives no credential and cannot revoke that session.
			w.Header().Set("Retry-After", "1")
		} else if isSessionRevoked(err) {
			s.setCookie(w, "refresh", "", -1)
		}
		return err
	}
	if err = s.setRefreshCookie(w, next, expiry); err != nil {
		return err
	}
	return s.sessionResponse(w, r, uid, sid)
}

func (s *Service) rotate(ctx context.Context, raw, next string) (uid, sid string, expiry time.Time, err error) {
	denied := func() error {
		return httpapi.Fail(401, "REFRESH_REVOKED", "刷新会话无效、已使用或已撤销。")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", "", expiry, unavailable()
	}
	defer tx.Rollback(ctx)
	var consumed *time.Time
	var tokenExpiry time.Time
	err = tx.QueryRow(ctx, "SELECT session_id,expires_at,consumed_at FROM refresh_tokens WHERE token_hash=$1 FOR UPDATE", security.Digest(raw)).Scan(&sid, &tokenExpiry, &consumed)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", expiry, denied()
	}
	if err != nil {
		return "", "", expiry, unavailable()
	}
	var revoked *time.Time
	var issuer *string
	var subject, ipacSID *string
	var version *uint64
	var disabled bool
	err = tx.QueryRow(ctx, "SELECT s.user_id,s.expires_at,s.revoked_at,s.ipac_issuer,s.ipac_subject,s.ipac_session_id,s.ipac_session_version,u.disabled FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 FOR UPDATE OF s", sid).Scan(&uid, &expiry, &revoked, &issuer, &subject, &ipacSID, &version, &disabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", expiry, denied()
	}
	if err != nil {
		return "", "", expiry, unavailable()
	}
	if consumed != nil {
		var databaseNow time.Time
		if err = tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&databaseNow); err != nil {
			return "", "", expiry, unavailable()
		}
		if revoked == nil && !disabled && issuer != nil && *issuer == s.cfg.IssuerURL && subject != nil && ipacSID != nil && version != nil && *version > 0 && databaseNow.Before(expiry) && databaseNow.Before(tokenExpiry) && refreshRaceAt(databaseNow, *consumed) {
			return "", "", expiry, httpapi.Retry(401, "REFRESH_RACE_RETRY", "另一个页面正在更新登录会话，请稍后重试。")
		}
		_, err = tx.Exec(ctx, "UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1", sid)
		if err != nil {
			return "", "", expiry, unavailable()
		}
		if tx.Commit(ctx) != nil {
			return "", "", expiry, unavailable()
		}
		return "", "", expiry, denied()
	}
	if revoked != nil || disabled || issuer == nil || *issuer != s.cfg.IssuerURL || subject == nil || ipacSID == nil || version == nil || *version == 0 || !time.Now().Before(expiry) || !time.Now().Before(tokenExpiry) {
		return "", "", expiry, denied()
	}
	upstream, err := s.verifiedSession(ctx, oidcrp.Identity{SubjectID: *subject, SessionID: *ipacSID, SessionVersion: *version})
	if err != nil {
		if isSessionRevoked(err) {
			if _, revokeErr := tx.Exec(ctx, "UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1", sid); revokeErr != nil {
				return "", "", expiry, unavailable()
			}
			if tx.Commit(ctx) != nil {
				return "", "", expiry, unavailable()
			}
		}
		return "", "", expiry, err
	}
	// A newly observed shorter upstream deadline is authoritative. A longer
	// upstream lifetime must never slide the original local seven-day window.
	if upstream.ExpiresAt.Before(expiry) {
		expiry = upstream.ExpiresAt
		if _, err = tx.Exec(ctx, "UPDATE sessions SET expires_at=$2 WHERE id=$1", sid, expiry); err != nil {
			return "", "", expiry, unavailable()
		}
	}
	_, err = tx.Exec(ctx, "UPDATE refresh_tokens SET consumed_at=clock_timestamp() WHERE token_hash=$1", security.Digest(raw))
	if err == nil {
		_, err = tx.Exec(ctx, "INSERT INTO refresh_tokens(token_hash,session_id,expires_at) VALUES($1,$2,$3)", security.Digest(next), sid, expiry)
	}
	if err != nil {
		return "", "", expiry, unavailable()
	}
	if tx.Commit(ctx) != nil {
		return "", "", expiry, unavailable()
	}
	return uid, sid, expiry, nil
}

// Use the database clock for both consumption and classification. This window
// tolerates only a just-consumed token; it never turns a replay into success.
func refreshRaceAt(now, consumed time.Time) bool {
	return !now.Before(consumed) && now.Before(consumed.Add(refreshRaceGrace))
}

func (s *Service) sessionResponse(w http.ResponseWriter, r *http.Request, uid, sid string) error {
	if _, err := s.AuthenticateSession(r.Context(), uid, sid); err != nil {
		return err
	}
	user, err := s.publicUser(r.Context(), uid)
	if err != nil {
		return err
	}
	token, err := s.tokens.Sign(map[string]any{"sub": uid, "sid": sid}, "access", accessLifetime)
	if err != nil {
		return err
	}
	return httpapi.OK(w, r, 200, map[string]any{"accessToken": token, "tokenType": "Bearer", "expiresIn": int(accessLifetime.Seconds()), "user": user})
}

func (s *Service) logout(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireCsrf(r); err != nil {
		return err
	}
	// The refresh cookie is shared by tabs, while a tab can still hold an older
	// access token. Revoke both local sessions atomically. Verify the access
	// proof locally and bind sid to its signed subject; never accept a raw sid
	// or require a healthy upstream service merely to end a local session.
	uid, sid := s.logoutBearer(r)
	refreshHash := ""
	if raw := cookie(r, s.cookieName("refresh")); raw != "" {
		refreshHash = security.Digest(raw)
	}
	if sid != "" || refreshHash != "" {
		_, err := s.db.Exec(r.Context(), "UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE ($1<>'' AND id=$1 AND user_id=$2) OR ($3<>'' AND id IN (SELECT session_id FROM refresh_tokens WHERE token_hash=$3))", sid, uid, refreshHash)
		if err != nil {
			return unavailable()
		}
	}
	s.setCookie(w, "refresh", "", -1)
	return httpapi.OK(w, r, 200, map[string]any{"accepted": true})
}

func (s *Service) logoutBearer(r *http.Request) (uid, sid string) {
	match := regexp.MustCompile(`^Bearer ([A-Za-z0-9_.-]+)$`).FindStringSubmatch(r.Header.Get("Authorization"))
	if len(match) != 2 {
		return "", ""
	}
	claims, err := s.tokens.VerifyForRevocation(match[1])
	if err != nil {
		// Preserve cookie-only logout when no valid local access proof exists.
		return "", ""
	}
	uid, _ = claims["sub"].(string)
	sid, _ = claims["sid"].(string)
	if uid == "" || sid == "" {
		return "", ""
	}
	return uid, sid
}

func (s *Service) publicUser(ctx context.Context, uid string) (map[string]any, error) {
	var id, name, locale string
	var avatar *string
	err := s.db.QueryRow(ctx, "SELECT id,display_name,locale,avatar_url FROM users WHERE id=$1 AND NOT disabled", uid).Scan(&id, &name, &locale, &avatar)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpapi.Fail(401, "UNAUTHENTICATED", "登录状态无效。")
	}
	if err != nil {
		return nil, unavailable()
	}
	return map[string]any{"id": id, "displayName": name, "avatarUrl": avatar, "locale": locale, "memberships": []any{}, "wallet": map[string]string{"currency": "USD", "amount": "0.000000"}, "teamIds": []string{}}, nil
}

func (s *Service) me(w http.ResponseWriter, r *http.Request) error {
	user, err := s.publicUser(r.Context(), httpapi.IdentityFrom(r).UserID)
	if err != nil {
		return err
	}
	return httpapi.OK(w, r, 200, user)
}

func (s *Service) preferences(w http.ResponseWriter, r *http.Request) error {
	var body map[string]any
	if err := httpapi.Decode(w, r, &body); err != nil {
		return err
	}
	if err := validatePreferences(body); err != nil {
		return err
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	var data []byte
	err = s.db.QueryRow(r.Context(), "UPDATE users SET preferences=preferences||$2::jsonb,locale=COALESCE($3,locale) WHERE id=$1 RETURNING preferences", httpapi.IdentityFrom(r).UserID, encoded, body["locale"]).Scan(&data)
	if err != nil {
		return unavailable()
	}
	var result map[string]any
	if json.Unmarshal(data, &result) != nil {
		return unavailable()
	}
	return httpapi.OK(w, r, 200, result)
}

func validatePreferences(body map[string]any) error {
	invalid := func() error { return httpapi.Fail(400, "VALIDATION_FAILED", "用户偏好字段无效。") }
	if body == nil {
		return invalid()
	}
	enums := map[string][]string{"locale": {"zh-CN", "en", "ja", "ko"}, "defaultMode": {"AGENT", "IMAGE", "VIDEO", "MOTION_TRANSFER"}, "executionPolicy": {"ASK", "AUTO"}}
	for key, value := range body {
		if values, ok := enums[key]; ok {
			text, valid := value.(string)
			found := false
			for _, candidate := range values {
				found = found || candidate == text
			}
			if !valid || !found {
				return invalid()
			}
			continue
		}
		switch key {
		case "imageModelId", "videoModelId":
			if value != nil {
				text, ok := value.(string)
				if !ok || !regexp.MustCompile(`^[A-Za-z0-9_-]{1,200}$`).MatchString(text) {
					return invalid()
				}
			}
		case "imageParams", "videoParams":
			if _, ok := value.(map[string]any); !ok {
				return invalid()
			}
		default:
			return invalid()
		}
	}
	return nil
}
