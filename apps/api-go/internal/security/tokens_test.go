package security

import (
	"github.com/golang-jwt/jwt/v5"
	"studiotv.local/service/api/internal/config"
	"testing"
	"time"
)

func TestStorageTokenPurposeIssuerExpiry(t *testing.T) {
	cfg := config.Config{SigningSecret: "unit-test-only-signing-secret-32-bytes", Issuer: "rhtv-service", Audience: "rhtv-web"}
	manager := New(cfg)
	raw, e := manager.Sign(map[string]any{"sub": "usr_a", "aid": "ast_a"}, "asset-read", time.Minute)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = manager.Verify(raw, "asset-read"); e != nil {
		t.Fatal(e)
	}
	if _, e = manager.Verify(raw, "access"); e == nil {
		t.Fatal("wrong purpose accepted")
	}
	other := New(config.Config{SigningSecret: cfg.SigningSecret, Issuer: cfg.Issuer, Audience: "other"})
	if _, e = other.Verify(raw, "asset-read"); e == nil {
		t.Fatal("wrong audience accepted")
	}
	expired, _ := manager.Sign(nil, "asset-read", -time.Minute)
	if _, e = manager.Verify(expired, "asset-read"); e == nil {
		t.Fatal("expired accepted")
	}
	for _, raw := range []string{"demo-token", "rhtv-preview", "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c3JfZGVtbyJ9."} {
		if _, e = manager.Verify(raw, "access"); e == nil {
			t.Fatal("invalid accepted")
		}
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS384, jwt.MapClaims{"iss": cfg.Issuer, "aud": cfg.Audience, "exp": time.Now().Add(time.Minute).Unix(), "purpose": "access"})
	wrong, _ := token.SignedString([]byte(cfg.SigningSecret))
	if _, e = manager.Verify(wrong, "access"); e == nil {
		t.Fatal("non-HS256 accepted")
	}
}

func TestRevocationProofIgnoresOnlyAccessExpiration(t *testing.T) {
	cfg := config.Config{SigningSecret: "unit-test-only-signing-secret-32-bytes", Issuer: "rhtv-service", Audience: "rhtv-web"}
	tokens := New(cfg)
	base := jwt.MapClaims{"sub": "usr_old_tab", "sid": "ses_old_tab", "purpose": "access", "iss": cfg.Issuer, "aud": cfg.Audience, "iat": time.Now().Add(-30 * time.Minute).Unix(), "exp": time.Now().Add(-15 * time.Minute).Unix()}
	cases := []struct {
		name  string
		field string
		value any
		valid bool
	}{
		{name: "expired local access remains a revocation proof", valid: true},
		{name: "missing expiration", field: "exp"},
		{name: "invalid expiration", field: "exp", value: "not-a-date"},
		{name: "missing issued at", field: "iat"},
		{name: "future issued at", field: "iat", value: time.Now().Add(time.Hour).Unix()},
		{name: "future not before", field: "nbf", value: time.Now().Add(time.Hour).Unix()},
		{name: "wrong issuer", field: "iss", value: "different-issuer"},
		{name: "wrong audience", field: "aud", value: "different-audience"},
		{name: "csrf is not a revocation proof", field: "purpose", value: "csrf"},
		{name: "media is not a revocation proof", field: "purpose", value: "asset-read"},
		{name: "missing subject", field: "sub"},
		{name: "missing session", field: "sid"},
		{name: "non string subject", field: "sub", value: 123},
		{name: "non string session", field: "sid", value: 123},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			claims := jwt.MapClaims{}
			for key, value := range base {
				claims[key] = value
			}
			if tc.field != "" {
				if tc.value == nil {
					delete(claims, tc.field)
				} else {
					claims[tc.field] = tc.value
				}
			}
			raw, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(tokens.key)
			if err != nil {
				t.Fatal(err)
			}
			proof, err := tokens.VerifyForRevocation(raw)
			if tc.valid {
				if err != nil || proof["sub"] != "usr_old_tab" || proof["sid"] != "ses_old_tab" {
					t.Fatal("expired access could not identify its revocation target", err)
				}
			} else if err == nil {
				t.Fatal("invalid proof was accepted")
			}
			if _, err := tokens.Verify(raw, "access"); err == nil {
				t.Fatal("expired or invalid proof also granted ordinary access")
			}
		})
	}
	for _, method := range []jwt.SigningMethod{jwt.SigningMethodHS384, jwt.SigningMethodNone} {
		token := jwt.NewWithClaims(method, base)
		key := any(tokens.key)
		if method == jwt.SigningMethodNone {
			key = jwt.UnsafeAllowNoneSignatureType
		}
		raw, err := token.SignedString(key)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tokens.VerifyForRevocation(raw); err == nil {
			t.Fatal("non-HS256 revocation proof was accepted")
		}
	}
}
