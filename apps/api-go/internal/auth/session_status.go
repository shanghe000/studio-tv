package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"studio.example.invalid/maintainer/ipac-client-kit/runtime"
	"studiotv.local/service/api/internal/auth/oidcrp"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/ipachttp"
	"studiotv.local/service/api/internal/ipaclease"
)

// SessionStatus is an IPAC extension complementary to the official client-kit.
// It checks the persisted upstream sid, its real authentication source, expiry,
// and the subject's current revocation version using backend-only app credentials.
type sessionStatusRequest struct {
	SubjectID      string `json:"subject_id"`
	SessionID      string `json:"session_id"`
	SessionVersion uint64 `json:"session_version"`
}

type sessionStatus struct {
	Active                 bool                 `json:"active"`
	AuthenticationProvider string               `json:"auth_provider"`
	AMR                    []string             `json:"amr"`
	SubjectID              string               `json:"subject_id"`
	SessionID              string               `json:"session_id"`
	CurrentSessionVersion  runtime.Uint64String `json:"current_session_version"`
	ExpiresAt              time.Time            `json:"expires_at"`
}

func (s *Service) status(ctx context.Context, request sessionStatusRequest) (sessionStatus, error) {
	if err := s.requireConfigured(); err != nil {
		return sessionStatus{}, err
	}
	endpoint, err := url.Parse(s.cfg.BaseURL)
	if err != nil {
		return sessionStatus{}, upstreamUnavailable()
	}
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/oidc/session-status"
	body, err := json.Marshal(request)
	if err != nil {
		return sessionStatus{}, upstreamUnavailable()
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return sessionStatus{}, upstreamUnavailable()
	}
	req.SetBasicAuth(s.cfg.ClientID, s.cfg.ClientSecret)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	client := s.statusHTTP
	if client == nil {
		client = ipachttp.NewClient(3 * time.Second)
	}
	// Redirects must never forward the application credentials to another origin.
	copyClient := *client
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := copyClient.Do(req)
	if err != nil {
		return sessionStatus{}, upstreamUnavailable()
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return sessionStatus{}, upstreamUnavailable()
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	if err != nil || len(data) > 2<<20 {
		return sessionStatus{}, upstreamUnavailable()
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return sessionStatus{}, upstreamUnavailable()
	}
	for _, key := range []string{"active", "auth_provider", "amr", "subject_id", "session_id", "current_session_version", "expires_at"} {
		if _, exists := fields[key]; !exists {
			return sessionStatus{}, upstreamUnavailable()
		}
	}
	if string(fields["active"]) != "true" && string(fields["active"]) != "false" {
		return sessionStatus{}, upstreamUnavailable()
	}
	var result sessionStatus
	if json.Unmarshal(data, &result) != nil || result.AMR == nil || (result.AuthenticationProvider != "feishu" && result.AuthenticationProvider != "external_password" && result.AuthenticationProvider != "unknown") {
		return sessionStatus{}, upstreamUnavailable()
	}
	return result, nil
}

func (s *Service) sessionLease() *ipaclease.Cache[sessionStatusRequest, sessionStatus] {
	s.leaseMu.Lock()
	defer s.leaseMu.Unlock()
	if s.sessionCache == nil {
		s.sessionCache = ipaclease.New[sessionStatusRequest, sessionStatus](ipaclease.Lifetime)
	}
	return s.sessionCache
}

// Login and refresh invalidate any earlier lease and require a fresh verified
// upstream response. A successful check also seeds ordinary API authentication.
func (s *Service) verifiedSession(ctx context.Context, identity oidcrp.Identity) (sessionStatus, error) {
	key := sessionStatusRequest{SubjectID: identity.SubjectID, SessionID: identity.SessionID, SessionVersion: identity.SessionVersion}
	s.sessionLease().Delete(key)
	return s.cachedVerifiedSession(ctx, identity)
}

// The local session, account status and Bearer claims are still checked for
// every request before reaching this bounded upstream verification lease.
func (s *Service) cachedVerifiedSession(ctx context.Context, identity oidcrp.Identity) (sessionStatus, error) {
	if identity.SubjectID == "" || identity.SessionID == "" || identity.SessionVersion == 0 {
		return sessionStatus{}, httpapi.Fail(401, "IPAC_SESSION_REVOKED", "统一登录会话已失效，请重新使用飞书登录。")
	}
	key := sessionStatusRequest{SubjectID: identity.SubjectID, SessionID: identity.SessionID, SessionVersion: identity.SessionVersion}
	state, err := s.sessionLease().Get(ctx, key, func(ctx context.Context) (sessionStatus, time.Time, error) {
		state, err := s.loadVerifiedSession(ctx, identity)
		return state, state.ExpiresAt, err
	})
	if err != nil {
		var api *httpapi.Error
		if errors.As(err, &api) {
			return sessionStatus{}, err
		}
		return sessionStatus{}, upstreamUnavailable()
	}
	return state, nil
}

func (s *Service) loadVerifiedSession(ctx context.Context, identity oidcrp.Identity) (sessionStatus, error) {
	if identity.SubjectID == "" || identity.SessionID == "" || identity.SessionVersion == 0 {
		return sessionStatus{}, httpapi.Fail(401, "IPAC_SESSION_REVOKED", "统一登录会话已失效，请重新使用飞书登录。")
	}
	state, err := s.status(ctx, sessionStatusRequest{SubjectID: identity.SubjectID, SessionID: identity.SessionID, SessionVersion: identity.SessionVersion})
	if err != nil {
		return sessionStatus{}, err
	}
	if !state.Active || state.SubjectID != identity.SubjectID || state.SessionID != identity.SessionID || state.CurrentSessionVersion.Uint64() != identity.SessionVersion || !time.Now().Before(state.ExpiresAt) {
		return sessionStatus{}, httpapi.Fail(401, "IPAC_SESSION_REVOKED", "统一登录会话已撤销或过期，请重新使用飞书登录。")
	}
	if state.AuthenticationProvider != "feishu" || len(state.AMR) != 1 || state.AMR[0] != "feishu" {
		return sessionStatus{}, httpapi.Fail(403, "FEISHU_IDENTITY_REQUIRED", "只接受已确认来源的统一飞书身份。")
	}
	return state, nil
}

func (s *Service) protocolLease() *ipaclease.Cache[bool, bool] {
	s.leaseMu.Lock()
	defer s.leaseMu.Unlock()
	if s.probeCache == nil {
		s.probeCache = ipaclease.New[bool, bool](ipaclease.Lifetime)
	}
	return s.probeCache
}

func (s *Service) cachedProtocolProbe(ctx context.Context) (bool, error) {
	return s.protocolLease().Get(ctx, true, func(ctx context.Context) (bool, time.Time, error) {
		// A healthy protocol probe must prove the exact inactive unknown-session
		// contract. It never creates a session; malformed/offline results become
		// errors, retained only for the cache's two-second failure suppression.
		probe := sessionStatusRequest{SubjectID: "00000000-0000-0000-0000-000000000000", SessionID: "00000000-0000-0000-0000-000000000000", SessionVersion: 1}
		state, err := s.status(ctx, probe)
		if err != nil || state.Active || state.AuthenticationProvider != "unknown" || len(state.AMR) != 0 || state.SubjectID != probe.SubjectID || state.SessionID != probe.SessionID || state.CurrentSessionVersion.Uint64() != 0 || !state.ExpiresAt.IsZero() {
			return false, time.Time{}, upstreamUnavailable()
		}
		return true, time.Time{}, nil
	})
}

func upstreamUnavailable() error {
	return httpapi.Retry(503, "IPAC_UNAVAILABLE", "统一认证服务暂时不可用，请稍后重试。")
}

func isSessionRevoked(err error) bool {
	var api *httpapi.Error
	return errors.As(err, &api) && (api.Status == 401 || api.Code == "FEISHU_IDENTITY_REQUIRED")
}
