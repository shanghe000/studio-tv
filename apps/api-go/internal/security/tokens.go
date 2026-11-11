package security

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"github.com/golang-jwt/jwt/v5"
	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/httpapi"
	"time"
)

type Tokens struct {
	key              []byte
	issuer, audience string
}

func New(cfg config.Config) *Tokens {
	return &Tokens{key: []byte(cfg.SigningSecret), issuer: cfg.Issuer, audience: cfg.Audience}
}
func (t *Tokens) Sign(claims map[string]any, purpose string, lifetime time.Duration) (string, error) {
	c := jwt.MapClaims{}
	for k, v := range claims {
		c[k] = v
	}
	now := time.Now()
	c["purpose"] = purpose
	c["iss"] = t.issuer
	c["aud"] = t.audience
	c["iat"] = now.Unix()
	c["exp"] = now.Add(lifetime).Unix()
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, c)
	token.Header["typ"] = "JWT"
	return token.SignedString(t.key)
}
func (t *Tokens) Verify(raw, purpose string) (jwt.MapClaims, error) {
	c := jwt.MapClaims{}
	token, err := jwt.ParseWithClaims(raw, c, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("algorithm forbidden")
		}
		return t.key, nil
	}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer(t.issuer), jwt.WithAudience(t.audience), jwt.WithExpirationRequired(), jwt.WithIssuedAt())
	if err != nil || !token.Valid || c["purpose"] != purpose {
		return nil, httpapi.Fail(401, "UNAUTHENTICATED", "登录状态无效或已过期。")
	}
	return c, nil
}

// VerifyForRevocation verifies a local access proof only to revoke its session.
// Expiration cannot prevent a tab from ending its old session after another
// tab replaces the shared refresh cookie. This proof grants no access and must
// never be used by authentication, authorization, refresh, or media handlers.
func (t *Tokens) VerifyForRevocation(raw string) (jwt.MapClaims, error) {
	var claims revocationClaims
	token, err := jwt.ParseWithClaims(raw, &claims, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("algorithm forbidden")
		}
		return t.key, nil
	}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer(t.issuer), jwt.WithAudience(t.audience), jwt.WithExpirationRequired(), jwt.WithIssuedAt())
	if err != nil || !token.Valid || claims.Purpose != "access" || claims.Subject == "" || claims.SessionID == "" || claims.IssuedAt == nil {
		return nil, httpapi.Fail(401, "UNAUTHENTICATED", "退出凭据无效。")
	}
	return jwt.MapClaims{"sub": claims.Subject, "sid": claims.SessionID}, nil
}

type revocationClaims struct {
	jwt.RegisteredClaims
	SessionID string `json:"sid"`
	Purpose   string `json:"purpose"`
}

func (c revocationClaims) GetExpirationTime() (*jwt.NumericDate, error) {
	expires, err := c.RegisteredClaims.GetExpirationTime()
	if err != nil || expires == nil {
		return expires, err
	}
	if expires.Before(time.Now()) {
		// Keep required, well-typed exp validation while ignoring only its age.
		// All other registered-claim and signature checks still use real time.
		return jwt.NewNumericDate(time.Now().Add(time.Minute)), nil
	}
	return expires, nil
}

func Digest(raw string) string { s := sha256.Sum256([]byte(raw)); return hex.EncodeToString(s[:]) }
