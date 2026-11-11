// Package oidcrp keeps the application import stable while delegating OIDC to
// the pinned, vendored official IPAC client-kit. Login transactions remain in
// Studio's shared PostgreSQL store rather than the SDK's in-memory store.
package oidcrp

import (
	"context"

	ipacoidc "studio.example.invalid/maintainer/ipac-client-kit/oidcrp"
)

type Config = ipacoidc.Config
type Client = ipacoidc.Client
type Transaction = ipacoidc.Transaction
type Authorization = ipacoidc.Authorization
type Callback = ipacoidc.Callback
type Identity = ipacoidc.Identity
type Authentication = ipacoidc.Authentication
type AuthorizationError = ipacoidc.AuthorizationError

func New(ctx context.Context, config Config) (*Client, error) {
	return ipacoidc.New(ctx, config)
}
