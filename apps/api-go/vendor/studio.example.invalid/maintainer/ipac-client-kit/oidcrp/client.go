// Package oidcrp implements the secure OpenID Connect relying-party flow for
// web applications using IPAC as their identity provider.
package oidcrp

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

const defaultTransactionTTL = 5 * time.Minute

type Config struct {
	IssuerURL                   string
	ClientID                    string
	ClientSecret                string
	RedirectURL                 string
	Scopes                      []string
	HTTPClient                  *http.Client
	TransactionTTL              time.Duration
	AllowInsecureHTTP           bool
	DisableUserInfoVerification bool
}

type Client struct {
	provider        *oidc.Provider
	verifier        *oidc.IDTokenVerifier
	oauth2Config    oauth2.Config
	httpClient      *http.Client
	transactionTTL  time.Duration
	disableUserInfo bool
	now             func() time.Time
}

// Transaction contains login secrets and must be stored server-side. It is
// single-use and should never be placed in a query string or browser storage.
type Transaction struct {
	State        string    `json:"state"`
	Nonce        string    `json:"nonce"`
	PKCEVerifier string    `json:"pkce_verifier"`
	ReturnTo     string    `json:"return_to"`
	CreatedAt    time.Time `json:"created_at"`
}

type Authorization struct {
	URL         string
	Transaction Transaction
}

type Callback struct {
	State            string
	Code             string
	Error            string
	ErrorDescription string
}

type Identity struct {
	SubjectID      string
	DisplayName    string
	AvatarURL      string
	SessionID      string
	SessionVersion uint64
	TokenExpiresAt time.Time
}

type Authentication struct {
	Identity Identity
	ReturnTo string
}

type AuthorizationError struct {
	Code        string
	Description string
}

func (e *AuthorizationError) Error() string {
	if e.Description == "" {
		return "OIDC authorization failed: " + e.Code
	}
	return "OIDC authorization failed: " + e.Code + ": " + e.Description
}

func New(ctx context.Context, config Config) (*Client, error) {
	issuerURL, err := validateAbsoluteURL("issuer URL", config.IssuerURL, config.AllowInsecureHTTP)
	if err != nil {
		return nil, err
	}
	redirectURL, err := validateAbsoluteURL("redirect URL", config.RedirectURL, config.AllowInsecureHTTP)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(config.ClientID) == "" {
		return nil, errors.New("OIDC client ID is required")
	}
	if config.ClientSecret == "" {
		return nil, errors.New("OIDC client secret is required")
	}
	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 5 * time.Second}
	}
	discoveryCtx := oidc.ClientContext(ctx, httpClient)
	provider, err := oidc.NewProvider(discoveryCtx, issuerURL.String())
	if err != nil {
		return nil, fmt.Errorf("discover IPAC OIDC provider: %w", err)
	}
	scopes := append([]string(nil), config.Scopes...)
	if !slices.Contains(scopes, oidc.ScopeOpenID) {
		scopes = append([]string{oidc.ScopeOpenID}, scopes...)
	}
	if !slices.Contains(scopes, "profile") {
		scopes = append(scopes, "profile")
	}
	transactionTTL := config.TransactionTTL
	if transactionTTL <= 0 {
		transactionTTL = defaultTransactionTTL
	}
	endpoint := provider.Endpoint()
	endpoint.AuthStyle = oauth2.AuthStyleInHeader
	return &Client{
		provider: provider,
		verifier: provider.Verifier(&oidc.Config{
			ClientID: config.ClientID, SupportedSigningAlgs: []string{oidc.RS256},
		}),
		oauth2Config: oauth2.Config{
			ClientID: config.ClientID, ClientSecret: config.ClientSecret,
			RedirectURL: redirectURL.String(), Endpoint: endpoint, Scopes: scopes,
		},
		httpClient: httpClient, transactionTTL: transactionTTL,
		disableUserInfo: config.DisableUserInfoVerification, now: time.Now,
	}, nil
}

// Begin creates a state, nonce, and PKCE S256 challenge and returns the IPAC
// authorization URL. returnTo must be a local absolute path such as /projects.
func (c *Client) Begin(returnTo string) (Authorization, error) {
	returnTo, err := validateReturnTo(returnTo)
	if err != nil {
		return Authorization{}, err
	}
	state, err := randomToken()
	if err != nil {
		return Authorization{}, fmt.Errorf("generate OIDC state: %w", err)
	}
	nonce, err := randomToken()
	if err != nil {
		return Authorization{}, fmt.Errorf("generate OIDC nonce: %w", err)
	}
	verifier := oauth2.GenerateVerifier()
	transaction := Transaction{
		State: state, Nonce: nonce, PKCEVerifier: verifier,
		ReturnTo: returnTo, CreatedAt: c.now().UTC(),
	}
	authorizationURL := c.oauth2Config.AuthCodeURL(
		state,
		oidc.Nonce(nonce),
		oauth2.S256ChallengeOption(verifier),
	)
	return Authorization{URL: authorizationURL, Transaction: transaction}, nil
}

// Exchange validates the callback correlation values, exchanges the code,
// verifies the RS256 ID token and nonce, and revalidates the subject through
// UserInfo. UserInfo verification can only be disabled explicitly.
func (c *Client) Exchange(ctx context.Context, callback Callback, transaction Transaction) (Authentication, error) {
	if err := c.validateTransaction(callback, transaction); err != nil {
		return Authentication{}, err
	}
	if callback.Error != "" {
		return Authentication{}, &AuthorizationError{Code: callback.Error, Description: callback.ErrorDescription}
	}
	if callback.Code == "" {
		return Authentication{}, errors.New("OIDC authorization code is required")
	}
	requestCtx := oidc.ClientContext(ctx, c.httpClient)
	token, err := c.oauth2Config.Exchange(requestCtx, callback.Code, oauth2.VerifierOption(transaction.PKCEVerifier))
	if err != nil {
		return Authentication{}, fmt.Errorf("exchange OIDC authorization code: %w", err)
	}
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return Authentication{}, errors.New("OIDC token response does not contain an ID token")
	}
	idToken, err := c.verifier.Verify(requestCtx, rawIDToken)
	if err != nil {
		return Authentication{}, fmt.Errorf("verify OIDC ID token: %w", err)
	}
	if !constantTimeEqual(idToken.Nonce, transaction.Nonce) {
		return Authentication{}, errors.New("OIDC nonce does not match the login transaction")
	}
	var claims struct {
		SessionID      string `json:"sid"`
		SessionVersion uint64 `json:"session_version"`
		Name           string `json:"name"`
		Picture        string `json:"picture"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return Authentication{}, fmt.Errorf("decode OIDC ID token claims: %w", err)
	}
	if idToken.Subject == "" || claims.SessionID == "" || claims.SessionVersion == 0 {
		return Authentication{}, errors.New("OIDC ID token is missing required subject, sid, or session_version claims")
	}
	identity := Identity{
		SubjectID: idToken.Subject, DisplayName: claims.Name, AvatarURL: claims.Picture,
		SessionID: claims.SessionID, SessionVersion: claims.SessionVersion, TokenExpiresAt: idToken.Expiry,
	}
	if !c.disableUserInfo {
		userInfo, err := c.provider.UserInfo(requestCtx, oauth2.StaticTokenSource(token))
		if err != nil {
			return Authentication{}, fmt.Errorf("verify OIDC UserInfo: %w", err)
		}
		if userInfo.Subject != identity.SubjectID {
			return Authentication{}, errors.New("OIDC UserInfo subject does not match the ID token")
		}
		var userClaims struct {
			Name           string `json:"name"`
			Picture        string `json:"picture"`
			SessionVersion uint64 `json:"session_version"`
		}
		if err := userInfo.Claims(&userClaims); err != nil {
			return Authentication{}, fmt.Errorf("decode OIDC UserInfo claims: %w", err)
		}
		if userClaims.SessionVersion != identity.SessionVersion {
			return Authentication{}, errors.New("OIDC UserInfo session_version does not match the ID token")
		}
		identity.DisplayName = userClaims.Name
		identity.AvatarURL = userClaims.Picture
	}
	return Authentication{Identity: identity, ReturnTo: transaction.ReturnTo}, nil
}

func (c *Client) validateTransaction(callback Callback, transaction Transaction) error {
	if transaction.State == "" || transaction.Nonce == "" || transaction.PKCEVerifier == "" || transaction.CreatedAt.IsZero() {
		return errors.New("OIDC login transaction is incomplete")
	}
	if !constantTimeEqual(callback.State, transaction.State) {
		return errors.New("OIDC state does not match the login transaction")
	}
	now := c.now()
	if transaction.CreatedAt.After(now.Add(time.Minute)) || now.Sub(transaction.CreatedAt) > c.transactionTTL {
		return errors.New("OIDC login transaction has expired")
	}
	return nil
}

func validateAbsoluteURL(name, raw string, allowInsecure bool) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", name, err)
	}
	if parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return nil, fmt.Errorf("%s must be an absolute URL without credentials or fragment", name)
	}
	if parsed.Scheme != "https" && !(allowInsecure && parsed.Scheme == "http") {
		return nil, fmt.Errorf("%s must use HTTPS; enable insecure HTTP only for local development", name)
	}
	return parsed, nil
}

func validateReturnTo(raw string) (string, error) {
	if raw == "" {
		return "/", nil
	}
	if strings.Contains(raw, `\`) || !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") {
		return "", errors.New("returnTo must be a local absolute path")
	}
	parsed, err := url.ParseRequestURI(raw)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || parsed.Fragment != "" {
		return "", errors.New("returnTo must be a local absolute path")
	}
	return raw, nil
}

func randomToken() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func constantTimeEqual(left, right string) bool {
	if len(left) != len(right) || len(left) == 0 {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}
