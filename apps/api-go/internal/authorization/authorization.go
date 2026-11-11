// Package authorization checks the right to use Studio TV. IPAC scopes
// remain internal authorization evidence, never business data partitions.
package authorization

import (
	"context"
	"errors"
	"os"
	"strings"
	"time"

	ipacruntime "studio.example.invalid/maintainer/ipac-client-kit/runtime"
	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/ipachttp"
	"studiotv.local/service/api/internal/ipaclease"
)

const TVAccess = "tv.access"

var CapabilityCodes = []string{TVAccess}

type SessionVerifier interface {
	AuthenticateSession(context.Context, string, string) (httpapi.Identity, error)
	RevokeSession(context.Context, string) error
}
type Service struct {
	client        ipacruntime.Client
	applicationID string
	sessions      SessionVerifier
	leases        *ipaclease.Cache[leaseKey, bool]
}

type leaseKey struct {
	applicationID, issuer, subjectID, upstreamSessionID string
	sessionVersion                                      uint64
	localSessionID, userID, capability                  string
}

func New(client ipacruntime.Client, applicationID string, sessions SessionVerifier) *Service {
	return &Service{client: client, applicationID: applicationID, sessions: sessions, leases: ipaclease.New[leaseKey, bool](ipaclease.Lifetime)}
}

func FromEnv(cfg config.Config, sessions SessionVerifier) (*Service, error) {
	baseURL := strings.TrimSpace(os.Getenv("IPAC_BASE_URL"))
	if baseURL == "" {
		baseURL = strings.TrimSpace(os.Getenv("IPAC_ISSUER_URL"))
	}
	appID, secret := strings.TrimSpace(os.Getenv("IPAC_APP_ID")), os.Getenv("IPAC_APP_SECRET")
	if baseURL == "" || appID == "" || secret == "" {
		// Unconfigured authentication remains usable only for its explanatory
		// error. No authenticated business operation can bypass this service.
		return New(nil, appID, sessions), nil
	}
	insecure := os.Getenv("IPAC_ALLOW_INSECURE_HTTP") == "true"
	if insecure && !cfg.AllowLocalHTTP {
		return nil, errors.New("insecure IPAC authorization requires explicit local development")
	}
	client, err := ipacruntime.NewHTTPClient(ipacruntime.HTTPConfig{
		BaseURL: baseURL, ApplicationID: appID, ApplicationSecret: secret,
		HTTPClient:        ipachttp.NewClient(0),
		AllowInsecureHTTP: insecure,
	})
	if err != nil {
		return nil, errors.New("invalid IPAC authorization configuration")
	}
	return New(client, appID, sessions), nil
}

func principal(identity httpapi.Identity) error {
	if identity.UserID == "" || identity.SessionID == "" || identity.IPACIssuer == "" || identity.IPACSubjectID == "" || identity.IPACSessionID == "" || identity.IPACSessionVersion == 0 {
		return httpapi.Fail(401, "UNAUTHENTICATED", "登录状态无效，请重新登录。")
	}
	return nil
}
func unavailable() error {
	return httpapi.Retry(503, "IPAC_AUTHORIZATION_UNAVAILABLE", "统一授权服务暂时不可用。")
}

func denied() error {
	return httpapi.Fail(403, "IPAC_PERMISSION_DENIED", "当前账号没有使用 Studio TV 的权限。")
}

func (s *Service) stale(ctx context.Context, identity httpapi.Identity) error {
	if s.sessions != nil {
		if err := s.sessions.RevokeSession(ctx, identity.SessionID); err != nil {
			return unavailable()
		}
	}
	return httpapi.Fail(401, "IPAC_SESSION_STALE", "统一登录状态已失效，请重新登录。")
}

// Check uses a bounded lease of IPAC's effective grants. Any verified tv.access
// grant permits use of the whole tool; scopes remain internal evidence, never
// business ownership or caller-selected partitions. Local authentication still
// checks the persisted account and session for every request.
func (s *Service) Check(ctx context.Context, identity httpapi.Identity, capability string) error {
	if err := principal(identity); err != nil {
		return err
	}
	if s == nil || s.client == nil || s.applicationID == "" {
		return unavailable()
	}
	if capability != TVAccess {
		return denied()
	}
	if !identity.SessionExpiresAt.IsZero() && !time.Now().Before(identity.SessionExpiresAt) {
		return httpapi.Fail(401, "UNAUTHENTICATED", "登录状态已过期，请重新登录。")
	}
	key := leaseKey{
		applicationID: s.applicationID, issuer: identity.IPACIssuer, subjectID: identity.IPACSubjectID,
		upstreamSessionID: identity.IPACSessionID, sessionVersion: identity.IPACSessionVersion,
		localSessionID: identity.SessionID, userID: identity.UserID, capability: capability,
	}
	_, err := s.leases.Get(ctx, key, func(loadContext context.Context) (bool, time.Time, error) {
		return s.loadGrant(loadContext, identity)
	})
	// The shared loader only verifies evidence. Each waiting request revokes its
	// own local session after receiving stale evidence, using its own context.
	if err != nil {
		if contextErr := ctx.Err(); contextErr != nil {
			return contextErr
		}
		if errors.Is(err, ipacruntime.ErrStaleSession) {
			return s.stale(ctx, identity)
		}
		var api *httpapi.Error
		if errors.As(err, &api) {
			return err
		}
		return unavailable()
	}
	return nil
}

func (s *Service) loadGrant(ctx context.Context, identity httpapi.Identity) (bool, time.Time, error) {
	started := time.Now()
	result, err := s.client.EffectiveScopes(ctx, ipacruntime.EffectiveScopesRequest{
		SubjectID: identity.IPACSubjectID, SessionVersion: identity.IPACSessionVersion, CapabilityCodes: []string{TVAccess},
	})
	if errors.Is(err, ipacruntime.ErrStaleSession) || err == nil && result.CurrentSessionVersion.Uint64() != identity.IPACSessionVersion {
		return false, time.Time{}, ipacruntime.ErrStaleSession
	}
	if err != nil {
		return false, time.Time{}, unavailable()
	}
	if result.SubjectStatus != "ACTIVE" || result.ApplicationStatus != "ACTIVE" {
		return false, time.Time{}, denied()
	}
	granted := false
	for _, effective := range result.Scopes {
		matches := false
		for _, code := range effective.CapabilityCodes {
			if code == TVAccess {
				matches = true
				break
			}
		}
		if !matches {
			continue
		}
		if strings.TrimSpace(effective.ProjectID) == "" || strings.TrimSpace(effective.EnvironmentID) == "" {
			return false, time.Time{}, unavailable()
		}
		granted = true
	}
	if !granted {
		return false, time.Time{}, denied()
	}
	// SDK responses do not distinguish an omitted TTL from zero. Positive TTLs
	// can shorten the local five-minute limit, but can never extend it.
	expires := started.Add(ipaclease.Lifetime)
	if result.CacheTTLSeconds > 0 {
		upstreamExpiry := started.Add(time.Duration(result.CacheTTLSeconds) * time.Second)
		if upstreamExpiry.Before(expires) {
			expires = upstreamExpiry
		}
	}
	if !identity.SessionExpiresAt.IsZero() && identity.SessionExpiresAt.Before(expires) {
		expires = identity.SessionExpiresAt
	}
	return true, expires, nil
}

func (s *Service) SignedIdentity(ctx context.Context, userID, sessionID string) (httpapi.Identity, error) {
	if s == nil || s.sessions == nil {
		return httpapi.Identity{}, unavailable()
	}
	if userID == "" || sessionID == "" {
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "素材签名缺少登录会话。")
	}
	identity, err := s.sessions.AuthenticateSession(ctx, userID, sessionID)
	if err != nil {
		return httpapi.Identity{}, err
	}
	if identity.UserID != userID || identity.SessionID != sessionID {
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "素材签名会话不匹配。")
	}
	if err := principal(identity); err != nil {
		return httpapi.Identity{}, err
	}
	return identity, nil
}
