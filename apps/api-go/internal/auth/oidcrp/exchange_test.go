package oidcrp

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// This issuer is test-only: production has no mock authentication path.
type testIssuer struct {
	server         *httptest.Server
	key            *rsa.PrivateKey
	transaction    Transaction
	mutate         func(jwt.MapClaims)
	userSubject    string
	userVersion    uint64
	wrongSignature bool
}

func newTestIssuer(t *testing.T) *testIssuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &testIssuer{key: key, userSubject: "person-test", userVersion: 1}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(w).Encode(map[string]any{"issuer": f.server.URL, "authorization_endpoint": f.server.URL + "/oauth2/authorize", "token_endpoint": f.server.URL + "/oauth2/token", "jwks_uri": f.server.URL + "/oauth2/jwks", "userinfo_endpoint": f.server.URL + "/oidc/userinfo", "id_token_signing_alg_values_supported": []string{"RS256"}})
		case "/oauth2/jwks":
			_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "test-key", "n": base64.RawURLEncoding.EncodeToString(f.key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(f.key.E)).Bytes())}}})
		case "/oauth2/token":
			if r.ParseForm() != nil {
				w.WriteHeader(400)
				return
			}
			client, secret, ok := r.BasicAuth()
			if !ok || client != "test-client" || secret != "test-fixture-secret" || r.Form.Get("code") != "valid-code" || r.Form.Get("code_verifier") != f.transaction.PKCEVerifier {
				w.WriteHeader(400)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "invalid_grant"})
				return
			}
			claims := jwt.MapClaims{"iss": f.server.URL, "aud": "test-client", "sub": "person-test", "iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix(), "nonce": f.transaction.Nonce, "sid": "ipac-test-session", "session_version": uint64(1), "amr": []string{"feishu"}, "auth_provider": "feishu"}
			if f.mutate != nil {
				f.mutate(claims)
			}
			signingKey := f.key
			if f.wrongSignature {
				signingKey, _ = rsa.GenerateKey(rand.Reader, 2048)
			}
			token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
			token.Header["kid"] = "test-key"
			raw, err := token.SignedString(signingKey)
			if err != nil {
				t.Error(err)
				w.WriteHeader(500)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "test-userinfo-token", "token_type": "Bearer", "expires_in": 60, "id_token": raw})
		case "/oidc/userinfo":
			if r.Header.Get("Authorization") != "Bearer test-userinfo-token" {
				w.WriteHeader(401)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"sub": f.userSubject, "name": "测试用户", "session_version": f.userVersion})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func TestOfficialSDKExchangeVerifiesIdentityAndReturnPath(t *testing.T) {
	f := newTestIssuer(t)
	client, err := New(context.Background(), Config{IssuerURL: f.server.URL, ClientID: "test-client", ClientSecret: "test-fixture-secret", RedirectURL: "http://localhost/api/v1/auth/feishu/callback", AllowInsecureHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	login, err := client.Begin("/projects/?a=1")
	if err != nil {
		t.Fatal(err)
	}
	f.transaction = login.Transaction
	u, _ := url.Parse(login.URL)
	if u.Query().Get("code_challenge_method") != "S256" {
		t.Fatal("PKCE method missing")
	}
	auth, err := client.Exchange(context.Background(), Callback{State: login.Transaction.State, Code: "valid-code"}, login.Transaction)
	if err != nil {
		t.Fatal(err)
	}
	if auth.Identity.SubjectID != "person-test" || auth.Identity.SessionID != "ipac-test-session" || auth.Identity.SessionVersion != 1 || auth.ReturnTo != "/projects/?a=1" {
		t.Fatal("verified identity or return path lost")
	}
}

func TestExchangeRejectsInvalidProofs(t *testing.T) {
	cases := []struct {
		name   string
		change func(*testIssuer, *Transaction, *Callback)
	}{
		{"state", func(f *testIssuer, tx *Transaction, cb *Callback) { cb.State = "wrong" }},
		{"nonce", func(f *testIssuer, tx *Transaction, cb *Callback) {
			f.mutate = func(c jwt.MapClaims) { c["nonce"] = "wrong" }
		}},
		{"issuer", func(f *testIssuer, tx *Transaction, cb *Callback) {
			f.mutate = func(c jwt.MapClaims) { c["iss"] = "https://attacker.invalid" }
		}},
		{"audience", func(f *testIssuer, tx *Transaction, cb *Callback) {
			f.mutate = func(c jwt.MapClaims) { c["aud"] = "another-client" }
		}},
		{"expired", func(f *testIssuer, tx *Transaction, cb *Callback) {
			f.mutate = func(c jwt.MapClaims) { c["exp"] = time.Now().Add(-time.Hour).Unix() }
		}},
		{"signature", func(f *testIssuer, tx *Transaction, cb *Callback) { f.wrongSignature = true }},
		{"userinfo_subject", func(f *testIssuer, tx *Transaction, cb *Callback) { f.userSubject = "another-person" }},
		{"userinfo_version", func(f *testIssuer, tx *Transaction, cb *Callback) { f.userVersion = 2 }},
		{"pkce", func(f *testIssuer, tx *Transaction, cb *Callback) { tx.PKCEVerifier = "wrong" }},
		{"transaction_expiry", func(f *testIssuer, tx *Transaction, cb *Callback) { tx.CreatedAt = time.Now().Add(-time.Hour) }},
		{"missing_session", func(f *testIssuer, tx *Transaction, cb *Callback) {
			f.mutate = func(c jwt.MapClaims) { delete(c, "sid") }
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newTestIssuer(t)
			client, err := New(context.Background(), Config{IssuerURL: f.server.URL, ClientID: "test-client", ClientSecret: "test-fixture-secret", RedirectURL: "http://localhost/callback", AllowInsecureHTTP: true})
			if err != nil {
				t.Fatal(err)
			}
			login, err := client.Begin("/projects/")
			if err != nil {
				t.Fatal(err)
			}
			f.transaction = login.Transaction
			tx := login.Transaction
			cb := Callback{State: tx.State, Code: "valid-code"}
			tc.change(f, &tx, &cb)
			if _, err := client.Exchange(context.Background(), cb, tx); err == nil {
				t.Fatal("untrusted login proof accepted")
			}
		})
	}
}
