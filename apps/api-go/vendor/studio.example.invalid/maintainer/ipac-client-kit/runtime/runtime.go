// Package runtime provides IPAC's runtime authorization client.
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"studio.example.invalid/maintainer/ipac-client-kit/internal/httpclient"
)

var ErrStaleSession = errors.New("IPAC session version is stale")

// StaleSessionError means IPAC has invalidated the login session. Applications
// should remove their local session and ask the user to sign in again.
type StaleSessionError struct {
	Presented uint64
	Current   uint64
}

func (e *StaleSessionError) Error() string {
	return fmt.Sprintf("%v: presented=%d current=%d", ErrStaleSession, e.Presented, e.Current)
}

func (e *StaleSessionError) Is(target error) bool { return target == ErrStaleSession }

type Scope struct {
	ProjectID     string
	EnvironmentID string
}

type CheckRequest struct {
	SubjectID      string
	SessionVersion uint64
	CapabilityCode string
	Scope          Scope
}

// Uint64String 兼容两种 JSON 形态：protojson 的字符串 uint64（如 "1"）
// 与标准 encoding/json 的数字（如 1）。IPAC 的 kratos/protojson 输出
// uint64 字段为字符串，SDK 侧必须两者都接受。
type Uint64String uint64

// UnmarshalJSON 同时接受 "123" 与 123 两种编码。
func (u *Uint64String) UnmarshalJSON(data []byte) error {
	if len(data) > 0 && data[0] == '"' {
		var text string
		if err := json.Unmarshal(data, &text); err != nil {
			return err
		}
		value, err := strconv.ParseUint(text, 10, 64)
		if err != nil {
			return err
		}
		*u = Uint64String(value)
		return nil
	}
	var value uint64
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*u = Uint64String(value)
	return nil
}

// Uint64 返回基础 uint64 值。
func (u Uint64String) Uint64() uint64 { return uint64(u) }

type Decision struct {
	Allowed               bool   `json:"allowed"`
	Reason                string `json:"reason"`
	SubjectStatus         string `json:"subject_status"`
	ApplicationStatus     string `json:"application_status"`
	CurrentSessionVersion Uint64String `json:"current_session_version"`
	PermissionRevision    Uint64String `json:"permission_revision"`
	CacheTTLSeconds       int32  `json:"cache_ttl_seconds"`
}

type EffectiveScopesRequest struct {
	SubjectID       string
	SessionVersion  uint64
	CapabilityCodes []string
}

type EffectiveScope struct {
	ProjectID       string   `json:"project_id"`
	ProjectCode     string   `json:"project_code"`
	ProjectName     string   `json:"project_name"`
	EnvironmentID   string   `json:"environment_id"`
	EnvironmentCode string   `json:"environment_code"`
	EnvironmentName string   `json:"environment_name"`
	RiskLevel       string   `json:"risk_level"`
	CapabilityCodes []string `json:"capability_codes"`
}

type EffectiveScopes struct {
	SubjectDisplayName    string           `json:"subject_display_name"`
	SubjectStatus         string           `json:"subject_status"`
	ApplicationStatus     string           `json:"application_status"`
	CurrentSessionVersion Uint64String           `json:"current_session_version"`
	PermissionRevision    Uint64String           `json:"permission_revision"`
	CacheTTLSeconds       int32            `json:"cache_ttl_seconds"`
	Scopes                []EffectiveScope `json:"scopes"`
}

// Client is transport-neutral so a future gRPC adapter can be added without
// changing application middleware.
type Client interface {
	Check(context.Context, CheckRequest) (Decision, error)
	EffectiveScopes(context.Context, EffectiveScopesRequest) (EffectiveScopes, error)
}

type HTTPConfig struct {
	BaseURL           string
	ApplicationID     string
	ApplicationSecret string
	HTTPClient        *http.Client
	RequestTimeout    time.Duration
	AllowInsecureHTTP bool
}

type HTTPClient struct{ client *httpclient.Client }

func NewHTTPClient(config HTTPConfig) (*HTTPClient, error) {
	client, err := httpclient.New(httpclient.Config{
		BaseURL: config.BaseURL, ClientID: config.ApplicationID,
		ClientSecret: config.ApplicationSecret, HTTPClient: config.HTTPClient,
		RequestTimeout: config.RequestTimeout, AllowInsecureHTTP: config.AllowInsecureHTTP,
	})
	if err != nil {
		return nil, err
	}
	return &HTTPClient{client: client}, nil
}

func (c *HTTPClient) Check(ctx context.Context, request CheckRequest) (Decision, error) {
	if err := validateCheck(request); err != nil {
		return Decision{}, err
	}
	payload := struct {
		SubjectID      string `json:"subject_id"`
		SessionVersion uint64 `json:"session_version"`
		CapabilityCode string `json:"capability_code"`
		ProjectID      string `json:"project_id"`
		EnvironmentID  string `json:"environment_id"`
	}{request.SubjectID, request.SessionVersion, request.CapabilityCode, request.Scope.ProjectID, request.Scope.EnvironmentID}
	var decision Decision
	if err := c.client.DoJSON(ctx, "check authorization", http.MethodPost, "/api/v1/authorization/check", payload, &decision); err != nil {
		return Decision{}, err
	}
	if decision.CurrentSessionVersion.Uint64() != request.SessionVersion {
		return decision, &StaleSessionError{Presented: request.SessionVersion, Current: decision.CurrentSessionVersion.Uint64()}
	}
	return decision, nil
}

func (c *HTTPClient) EffectiveScopes(ctx context.Context, request EffectiveScopesRequest) (EffectiveScopes, error) {
	if strings.TrimSpace(request.SubjectID) == "" {
		return EffectiveScopes{}, errors.New("subject ID is required")
	}
	if request.SessionVersion == 0 {
		return EffectiveScopes{}, errors.New("session version must be greater than zero")
	}
	if len(request.CapabilityCodes) == 0 || len(request.CapabilityCodes) > 20 {
		return EffectiveScopes{}, errors.New("between 1 and 20 capability codes are required")
	}
	for _, code := range request.CapabilityCodes {
		if strings.TrimSpace(code) == "" {
			return EffectiveScopes{}, errors.New("capability code cannot be empty")
		}
	}
	payload := struct {
		SubjectID       string   `json:"subject_id"`
		SessionVersion  uint64   `json:"session_version"`
		CapabilityCodes []string `json:"capability_codes"`
	}{request.SubjectID, request.SessionVersion, request.CapabilityCodes}
	var result EffectiveScopes
	if err := c.client.DoJSON(ctx, "list effective scopes", http.MethodPost, "/api/v1/authorization/effective-scopes", payload, &result); err != nil {
		return EffectiveScopes{}, err
	}
	if result.CurrentSessionVersion.Uint64() != request.SessionVersion {
		return result, &StaleSessionError{Presented: request.SessionVersion, Current: result.CurrentSessionVersion.Uint64()}
	}
	return result, nil
}

func validateCheck(request CheckRequest) error {
	if strings.TrimSpace(request.SubjectID) == "" {
		return errors.New("subject ID is required")
	}
	if request.SessionVersion == 0 {
		return errors.New("session version must be greater than zero")
	}
	if strings.TrimSpace(request.CapabilityCode) == "" {
		return errors.New("capability code is required")
	}
	if strings.TrimSpace(request.Scope.ProjectID) == "" || strings.TrimSpace(request.Scope.EnvironmentID) == "" {
		return errors.New("project ID and environment ID are required")
	}
	return nil
}
