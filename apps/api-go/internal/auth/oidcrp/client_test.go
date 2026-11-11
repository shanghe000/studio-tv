package oidcrp

import (
	"context"
	"net/url"
	"testing"
)

func TestBeginCreatesOIDCTransactionWithPKCE(t *testing.T) {
	f := newTestIssuer(t)
	client, err := New(context.Background(), Config{IssuerURL: f.server.URL, ClientID: "test-client", ClientSecret: "test-fixture-secret", RedirectURL: "http://localhost/callback", AllowInsecureHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	authorization, err := client.Begin("/projects/p1?tab=members")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(authorization.URL)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	if query.Get("state") != authorization.Transaction.State || query.Get("nonce") != authorization.Transaction.Nonce {
		t.Fatal("state or nonce was not included in authorization URL")
	}
	if query.Get("code_challenge_method") != "S256" || query.Get("code_challenge") == "" {
		t.Fatal("PKCE S256 challenge was not included")
	}
	if authorization.Transaction.PKCEVerifier == "" || authorization.Transaction.ReturnTo != "/projects/p1?tab=members" {
		t.Fatal("transaction did not preserve verifier or returnTo")
	}
}

func TestBeginRejectsExternalReturnURL(t *testing.T) {
	f := newTestIssuer(t)
	client, err := New(context.Background(), Config{IssuerURL: f.server.URL, ClientID: "test-client", ClientSecret: "test-fixture-secret", RedirectURL: "http://localhost/callback", AllowInsecureHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Begin("https://attacker.example"); err == nil {
		t.Fatal("expected external return URL to be rejected")
	}
}
