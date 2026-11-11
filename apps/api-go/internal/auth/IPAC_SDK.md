# IPAC authentication integration source

- Official module: `studio.example.invalid/maintainer/ipac-client-kit v0.1.0`.
- Upstream Git commit: `d40afd3dea2e971cf09e7ac141df276998278c16`.
- Module checksum: `h1:/6nTsN04vMJFA2AuT5+Dz7o0I+x49HjycFejee6IJrw=`.
- The official OIDC client implements discovery, RS256 validation, issuer/audience/expiry, state, nonce, PKCE S256 and UserInfo subject/version verification. `oidcrp/client.go` only aliases the pinned SDK; it contains no fork of its implementation.
- All Go dependencies are vendored for builds with `-mod=vendor`. There is no filesystem `replace` directive or private-module download during the Docker build.

Studio retains its existing PostgreSQL login transaction, identity association, local session and refresh-token rotation. It does not use the SDK's in-memory store. Only exact issuer + subject associations are accepted; existing password accounts and their projects are not merged by email/name.

## Absolute login lifetime

A new verified Feishu login creates a local session with an absolute expiry of the earlier of login time plus 168 hours and IPAC's verified session expiry. IPAC must issue STUDIO's genuine Feishu session with its matching seven-day policy; STUDIO never extends or manufactures an upstream session. Existing shorter sessions retain their original deadline. Refresh-token rotation preserves that deadline and persists a newly observed shorter upstream expiry. The HttpOnly refresh cookie uses the actual remaining lifetime and absolute expiry.

The frozen v1 Session response remains unchanged: access JWTs last 15 minutes and `expiresIn` is 900. A still-valid access JWT cannot outlive its local or verified upstream session: ordinary API authentication, signed-media session resolution and refresh all enforce the session deadline. Login persistence does not grant `tv.access`; the independent authorization checks and their maximum five-minute lease remain unchanged.

Two same-browser tabs can send the same refresh cookie before the winning rotation reaches their shared cookie jar. An already consumed refresh token is refused with retryable HTTP 401 `REFRESH_RACE_RETRY` and `Retry-After: 1` for strictly less than five seconds after its database-recorded consumption, only while the linked local session/account is otherwise valid. This refusal returns no token, does not replace/delete cookies and does not revoke the session. Origin and CSRF checks remain mandatory. The window never slides; a later replay revokes the whole session family as before. The client may wait briefly and retry once with the shared winning cookie, without treating this specific refusal as a fresh-login requirement.

## Upstream session status extension

The official SDK v0.1.0 has no long-lived sid/provenance status call. `session_status.go` implements IPAC's explicit extension, separately from the SDK's OIDC and runtime protocols:

```text
POST {IPAC_BASE_URL}/oidc/session-status
Authorization: Basic (IPAC_APP_ID, IPAC_APP_SECRET)
Content-Type: application/json
```

Request fields: `subject_id`, `session_id`, `session_version` from the verified OIDC result or the persisted local session. Response fields: `active`, `auth_provider`, `amr`, `subject_id`, `session_id`, `current_session_version`, `expires_at` (RFC3339 or null for an inactive unknown session).

Authentication accepts only an active, unexpired, matching subject/sid/version with `auth_provider=feishu` and `amr=[feishu]`. The source is the upstream persisted session, not a hard-coded legacy ID-token amr claim. The old `IPAC_FEISHU_SOURCE_CLAIM` and `IPAC_FEISHU_SUBJECT_ALLOWLIST` settings are ignored and cannot bypass this check.

Login and refresh force a live check and seed a verified in-memory lease keyed by the complete subject/sid/version. Ordinary API and signed-media session resolution reuse that lease for at most five minutes, bounded earlier by the verified upstream session expiry. Each request still verifies the local session, its expiry/revocation, and the user's disabled status in PostgreSQL. An upstream revocation/source change is observed on the next live check, with a maximum five-minute window; a confirmed rejection revokes the local session immediately. A failed uncached check returns retryable 503, does not reuse an expired positive lease, and does not revoke a healthy local session. Concurrent checks for the same identity coalesce; failures are suppressed for at most two seconds. No automatic upstream retries or credential-bearing redirects occur.

The public auth configuration uses an authenticated unknown-session probe to ensure this extension is actually deployed, without creating a session. Only the exact valid inactive unknown-session protocol is cached as healthy, for five minutes. Offline or malformed probes are retained as failures for at most two seconds.

RBAC remains separate: a valid identity does not imply business permission. `AuthenticateSession` exposes a trusted issuer/subject/sid/version to the official SDK runtime checks in the authorization package.
