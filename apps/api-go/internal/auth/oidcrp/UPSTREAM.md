# Official IPAC OIDC SDK alias

`client.go` preserves Studio's application import path with type aliases and
one constructor forwarding to the official module
`studio.example.invalid/maintainer/ipac-client-kit/oidcrp` at fixed version `v0.1.0`
(upstream commit `d40afd3dea2e971cf09e7ac141df276998278c16`). It does not contain a
copied or modified OIDC implementation or a `VerifiedClaims` extension.

The module and all of its build dependencies are pinned in `go.mod`/`go.sum`
and committed under `apps/api-go/vendor`. Builds use `-mod=vendor`, with no
filesystem `replace` or access to a developer checkout. The tests here exercise
the official SDK against a test-only OIDC issuer.

See [IPAC_SDK.md](../IPAC_SDK.md) for the module checksum, shared PostgreSQL
session storage, runtime/manifest integration, and the separately implemented
IPAC SessionStatus extension used to verify real authentication provenance and
live upstream session validity.
