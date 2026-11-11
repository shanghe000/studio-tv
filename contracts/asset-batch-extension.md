# Asset metadata batch extension — IMPLEMENTED

`POST /api/v2/assets/resolve-batch` reads the same public asset metadata as
`GET /api/v1/assets/{assetId}` in one authenticated request. It does not mutate
assets, import files, accept a caller-selected owner, or change list permissions.
The frozen v1.0.0 contract is unchanged. The independent machine schema is
[`asset-batch-extension.schema.json`](asset-batch-extension.schema.json).

The standard verified session and `tv.access` gate run once for the request.
Every asset separately passes the existing live project or team-publication
read authorization, deletion checks and `READY` requirement. Metadata is never
reused from a prior request. A batch does not grant authority to another asset
or to the storage owner's other projects.

Request, maximum 16 KiB, no query parameters or unknown fields:

```json
{"assetIds":["ast_one","ast_two","ast_one"]}
```

`assetIds` must be present as an array, with at most 100 supplied items before
deduplication. An explicitly empty array is valid. Each ID follows the existing
1–64-byte ASCII letter/digit/underscore/hyphen rules. Duplicate IDs are returned
once in first-occurrence order.

Success is the ordinary STUDIO envelope, status 200:

```json
{"code":0,"message":"OK","requestId":"trusted-request-id","data":{"assets":[]}}
```

Each returned asset has the existing GET asset shape, including metadata and
short-lived `previewUrl`, `downloadUrl`, and `urlsExpireAt`. URL signatures bind
the actual authenticated actor and session, regardless of storage owner.
Responses use `Cache-Control: no-store`; this is not an authorization cache.

The operation returns all requested unique assets or an error. No partial
metadata or signed URL is sent if any item fails. Malformed JSON/IDs, missing
array, unknown fields or query parameters return 400; unsupported content type
415; oversized body 413. Missing authentication returns 401 and denied tool
access 403. Asset access errors preserve the existing 401/403/404 nondisclosure
rules. Any non-READY asset returns 409 `ASSET_NOT_READY`. Missing/deleted or
revoked project/team references fail the complete batch.

Canvas clients must verify that the response ID set exactly equals the
requested unique set before applying a snapshot. A failed batch must not
advance the accepted canvas revision. Each later snapshot repeats the full
authorization and metadata check. A later revocation or deletion remains
enforced by the existing signed-media reader even after metadata was returned.
