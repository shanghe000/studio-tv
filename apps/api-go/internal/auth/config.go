package auth

import (
	"errors"
	"net/url"
	"os"
	"strings"

	coreconfig "studiotv.local/service/api/internal/config"
)

// Config is deliberately independent from runtime/capability authorization.
type Config struct {
	IssuerURL         string
	BaseURL           string
	ClientID          string
	ClientSecret      string
	RedirectURI       string
	AllowInsecureHTTP bool
}

func LoadConfig(core coreconfig.Config) (Config, error) { return configFrom(core, os.Getenv) }

func configFrom(core coreconfig.Config, get func(string) string) (Config, error) {
	c := Config{
		IssuerURL: strings.TrimRight(strings.TrimSpace(get("IPAC_ISSUER_URL")), "/"),
		ClientID:  strings.TrimSpace(get("IPAC_APP_ID")), ClientSecret: get("IPAC_APP_SECRET"),
		RedirectURI:       core.PublicBaseURL + "/api/v1/auth/feishu/callback",
		BaseURL:           strings.TrimRight(strings.TrimSpace(get("IPAC_BASE_URL")), "/"),
		AllowInsecureHTTP: get("IPAC_ALLOW_INSECURE_HTTP") == "true",
	}
	if c.AllowInsecureHTTP && !core.AllowLocalHTTP {
		return c, errors.New("IPAC_ALLOW_INSECURE_HTTP is permitted only in explicitly enabled local development")
	}
	if value := strings.TrimSpace(get("IPAC_REDIRECT_URI")); value != "" {
		if value != c.RedirectURI {
			return c, errors.New("IPAC_REDIRECT_URI must exactly match PUBLIC_BASE_URL plus /api/v1/auth/feishu/callback")
		}
	}
	if c.IssuerURL != "" {
		u, err := url.Parse(c.IssuerURL)
		if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return c, errors.New("IPAC_ISSUER_URL must be an absolute issuer origin")
		}
		if u.Scheme != "https" && !(c.AllowInsecureHTTP && core.AllowLocalHTTP && u.Scheme == "http") {
			return c, errors.New("IPAC_ISSUER_URL requires HTTPS; local development requires explicit IPAC_ALLOW_INSECURE_HTTP")
		}
	}
	if c.BaseURL == "" {
		c.BaseURL = c.IssuerURL
	}
	if c.BaseURL != "" {
		u, err := url.Parse(c.BaseURL)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return c, errors.New("IPAC_BASE_URL must be an absolute URL without credentials, query or fragment")
		}
		if u.Scheme != "https" && !(c.AllowInsecureHTTP && core.AllowLocalHTTP && u.Scheme == "http") {
			return c, errors.New("IPAC_BASE_URL requires HTTPS; local development requires explicit IPAC_ALLOW_INSECURE_HTTP")
		}
	}
	return c, nil
}

func (c Config) unavailableReason() string {
	if c.IssuerURL == "" || c.BaseURL == "" || c.ClientID == "" || c.ClientSecret == "" {
		return "IPAC_NOT_CONFIGURED"
	}
	return ""
}
