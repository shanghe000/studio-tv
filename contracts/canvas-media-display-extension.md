# Canvas display media (IMPLEMENTED)

A same-origin client can opt into on-demand preview bytes by sending
`X-STUDIO-Canvas-Media: lazy-v1` on an authenticated project snapshot GET.
An authorized server returns the ordinary snapshot, a 32-hex-character
non-secret scope in the same header, and a host-only, HttpOnly, SameSite=Strict
cookie scoped to `/storage/canvas-media/{scope}/` (Secure on HTTPS).
The grant is bound to the project, user and login and expires no later than the
session (maximum seven days). Each user/project/session has its own path.

GET/HEAD `/storage/canvas-media/{scope}/{assetId}` serve bytes only after
rechecking that login, product permission, current project read access,
asset ownership, deletion, readiness, and file integrity. For an older asset
from another project, the current graph or cover must reference it and the
ordinary asset read ACL must also pass. Range and conditional requests go
through the same checks. A URL on its own confers no access. Same-site sibling
origins cannot embed the endpoint. Browsers keep no unvalidated cached bytes.

The graph and operation receipts continue to store asset IDs, never display
addresses or credentials. Current clients can still open an older server via
its authenticated metadata path. Download/export and generation keep their
own existing per-asset validation; opening a graph does not need those checks.

On large canvases the native media window starts at 200 nodes with at least
100 image nodes. Images near the viewport may use the optional
`previewWidth` query (256, 384, 512, 720, 1440, or 2560 pixels). The native
renderer chooses a tier from the displayed width, zoom and display density,
and uses a smaller image for the prefetch margin. Eligible PNG/JPEG stills
can return a smaller WebP. Source bytes are used when an asset is already
small, unsupported, animated PNG, too costly to decode, or the derivative
would be larger. Variants undergo the same access and file checks as originals
and have separate ETags. The API limits encoding concurrency and its private
in-memory byte cache. Selecting, expanding, downloading, or running with the
asset continues to use the original. Preview URLs and dimensions are display
state and do not enter saved node geometry, asset references or generated inputs.

## Video history posters (IMPLEMENTED)

Both authenticated display URLs above and signed `/storage/assets/{assetId}`
URLs accept the native first-frame query `ci-process=snapshot&time=0&format=jpg`.
Optional integer width/height are bounded to 1–2560 pixels, quality to 1–100,
and minisize/strip to 0 or 1. Defaults are width 512, height 2560 and quality 72.
History cards request width 240/quality 72; expanded previews request width
640/quality 76. Duplicate/invalid supported parameters, nonzero times and mixed
`previewWidth` requests return 400 `INVALID_VIDEO_PREVIEW`.

Eligible READY MP4/QuickTime/WebM assets return a real JPEG first frame with
preserved aspect ratio. Authorization and source-file integrity are checked
on every request, including cached variants and conditional responses. Each
variant has its own ETag; HEAD returns its metadata and Range is ignored only
for this small image representation. The decoder uses a seekable local source,
a six-second deadline, and the bounded shared preview slots/cache. Unsupported
or corrupt media returns an explicit 422; unavailable/timed-out decoding returns
503. Failure never substitutes the original video as a successful image.

URLs without this query retain original video bytes and Range playback. History
preview, reuse and download keep those original URLs. A failed poster is shown
locally as “视频封面暂不可用” without exposing the internal result ID or opening
a global error notice.
