package config

import (
	"errors"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	DatabaseURL               string
	Host                      string
	Port                      int
	SigningSecret             string
	Issuer                    string
	Audience                  string
	PublicBaseURL             string
	StorageRoot               string
	CatalogRoot               string
	ChromiumSandboxMode       string
	AllowedOrigins            []string
	SecureCookies             bool
	AllowLocalHTTP            bool
	AllowPrivateHTTP          bool
	ContractPath              string
	MaxUploadBytes            int64
	FFprobePath               string
	Edition                   string
	Features                  map[string]bool
	ModelRealExecutionEnabled bool
	ModelMediaTokenFile       string
	AgentEnabled              bool
	AgentProfileValidated     bool
	AgentSocketPath           string
	LogDirectory              string
	LogLevel                  string
	Environment               string
	AlertWebhookURL           string
	MetricsEnabled            bool
	MetricsAddress            string
}

func FromEnv() (Config, error) { return From(os.Getenv) }
func From(get func(string) string) (Config, error) {
	fallback := func(key, value string) string {
		if v := get(key); v != "" {
			return v
		}
		return value
	}
	c := Config{DatabaseURL: get("DATABASE_URL"), Host: fallback("HOST", "127.0.0.1"), SigningSecret: get("AUTH_SIGNING_SECRET"),
		Issuer: fallback("AUTH_ISSUER", "rhtv-service"), Audience: fallback("AUTH_AUDIENCE", "rhtv-web"), PublicBaseURL: strings.TrimRight(fallback("PUBLIC_BASE_URL", "https://localhost"), "/"),
		AllowLocalHTTP: get("ALLOW_LOCAL_HTTP") == "true", AllowPrivateHTTP: get("ALLOW_PRIVATE_HTTP") == "true", Edition: fallback("RHTV_EDITION", "internal"), FFprobePath: fallback("FFPROBE_PATH", "ffprobe")}
	if err := loadObservability(&c, get); err != nil {
		return c, err
	}
	if c.DatabaseURL == "" {
		return c, errors.New("DATABASE_URL is required")
	}
	if len([]byte(c.SigningSecret)) < 32 {
		return c, errors.New("AUTH_SIGNING_SECRET requires at least 32 bytes")
	}
	if c.Edition != "internal" && c.Edition != "external" {
		return c, errors.New("RHTV_EDITION must be internal or external")
	}
	u, err := url.Parse(c.PublicBaseURL)
	if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return c, errors.New("PUBLIC_BASE_URL must be an origin")
	}
	loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	address, addressErr := netip.ParseAddr(u.Hostname())
	privateIPv4 := addressErr == nil && address.Is4() && address.IsPrivate()
	allowedHTTP := (loopback && c.AllowLocalHTTP) || (c.Edition == "internal" && privateIPv4 && c.AllowPrivateHTTP)
	if u.Scheme != "https" && !(u.Scheme == "http" && allowedHTTP) {
		return c, errors.New("PUBLIC_BASE_URL must be HTTPS; HTTP requires an explicit loopback or internal private IPv4 override")
	}
	if raw := get("MODEL_REAL_EXECUTION_ENABLED"); raw != "" {
		if raw != "true" && raw != "false" {
			return c, errors.New("MODEL_REAL_EXECUTION_ENABLED must be true or false")
		}
		c.ModelRealExecutionEnabled = raw == "true"
	}
	c.ModelMediaTokenFile = get("MODEL_MEDIA_SERVICE_TOKEN_FILE")
	for name, dst := range map[string]*bool{"STUDIO_CODEX_AGENT_ENABLED": &c.AgentEnabled, "STUDIO_CODEX_AGENT_PROFILE_VALIDATED": &c.AgentProfileValidated} {
		if raw := get(name); raw != "" {
			if raw != "true" && raw != "false" {
				return c, errors.New(name + " must be true or false")
			}
			*dst = raw == "true"
		}
	}
	c.AgentSocketPath = get("STUDIO_CODEX_AGENT_SOCKET")
	if c.AgentEnabled && (!c.ModelRealExecutionEnabled || !c.AgentProfileValidated || !filepath.IsAbs(c.AgentSocketPath)) {
		return c, errors.New("Agent requires real execution policy, verified tools-only profile and absolute launcher socket")
	}
	c.SecureCookies = u.Scheme == "https"
	c.Features = map[string]bool{}
	for key, env := range map[string]string{"community": "FEATURE_COMMUNITY", "billing": "FEATURE_BILLING", "publicSharing": "FEATURE_PUBLIC_SHARING", "marketing": "FEATURE_MARKETING", "externalLinks": "FEATURE_EXTERNAL_LINKS"} {
		v := c.Edition == "external"
		if raw := get(env); raw != "" {
			if raw != "true" && raw != "false" {
				return c, errors.New(env + " must be true or false")
			}
			v = raw == "true"
		}
		// Internal use has no customer billing, even when an old deployment overrides the flag.
		if c.Edition == "internal" && key == "billing" {
			v = false
		}
		c.Features[key] = v
	}
	c.Port, err = strconv.Atoi(fallback("PORT", "3000"))
	if err != nil || c.Port < 1 || c.Port > 65535 {
		return c, errors.New("invalid PORT")
	}
	c.MaxUploadBytes, err = strconv.ParseInt(fallback("MAX_UPLOAD_BYTES", "536870912"), 10, 64)
	if err != nil || c.MaxUploadBytes < 1 || c.MaxUploadBytes > 536870912 {
		return c, errors.New("MAX_UPLOAD_BYTES must be 1..536870912")
	}
	c.StorageRoot, err = filepath.Abs(fallback("STORAGE_ROOT", "./var/assets"))
	if err != nil {
		return c, err
	}
	c.ChromiumSandboxMode = fallback("CHROMIUM_SANDBOX_MODE", "sandbox")
	if c.ChromiumSandboxMode != "sandbox" && c.ChromiumSandboxMode != "container" {
		return c, errors.New("CHROMIUM_SANDBOX_MODE must be sandbox or container")
	}
	c.CatalogRoot, err = filepath.Abs(fallback("PRODUCT_CATALOG_ROOT", "../web/public"))
	if err != nil {
		return c, err
	}
	c.ContractPath, err = filepath.Abs(fallback("CONTRACT_PATH", "../../contracts/openapi.json"))
	if err != nil {
		return c, err
	}
	for _, origin := range strings.Split(fallback("ALLOWED_ORIGINS", c.PublicBaseURL), ",") {
		parsed, e := url.Parse(strings.TrimSpace(origin))
		if e != nil || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
			return c, errors.New("invalid ALLOWED_ORIGINS")
		}
		c.AllowedOrigins = append(c.AllowedOrigins, parsed.Scheme+"://"+parsed.Host)
	}
	return c, nil
}
