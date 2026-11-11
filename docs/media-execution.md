# STUDIO media and asset seam (implementation complete; current full integration rerun pending)

2026-10-07 状态核对：后续真实工具/数据库验证见 [iteration-03-result](iteration-03-result.md)，本页的早期 rerun pending 不是最新测试结论。FFmpeg后端实现不代表视频工具栏完成：本次定位 MEDIA 异步提交后的节点回填缺口，以及全部音轨按钮仍走模型目录，详见 [统一台账](canvas-node-status.md#视频现有异步闭环缺口p0)。

Only this lane: modules/media, core/product_assets.go and tests, migration009_media.sql, media-extension/docs, runtime dependencies. Router finalized separately: 68 PASS/0 test skips; explicit MOCK only.

## Composition

```
assets,err := core.NewProductAssetStore(cfg,pool)
engine,err := ffmpeg.New("ffmpeg",cfg.FFprobePath,cfg.MaxUploadBytes)
mediaService,err := mediaapplication.New(executionStore,assets,assets,engine)
studioRepo,err := studiopg.New(pool,executionStore)
renderer,err := chromium.New("chromium","ffmpeg",cfg.FFprobePath,cfg.MaxUploadBytes, sandboxMode)
studio,err := mediaapplication.NewStudio(executionStore,studioRepo,renderer,assets)
executionService.WithProcessor(mediaService.WithStudio(studio))
mediaHTTP.RegisterRoutes(businessRouter,mediaService,protect)
mediaHTTP.RegisterStudioRoutes(publicRouter,businessRouter,studio,studioRepo,cfg,protect,resources.AuthorizeSignedRequest)
assets.RegisterProductAssetRoutes(businessRouter,protect)
resourcesapplication.NewWithMedia(resourcesStore,assets)
```

Every protected registration uses `protect("tv.access",handler)`. `sandboxMode=""|"sandbox"` retains Chromium OS sandbox; explicit `"container"` requires `/.dockerenv` and adds --no-sandbox to the separate renderer process. Root composition owns environment/config injection. Default cannot silently switch modes. Debian runtime includes FFmpeg/FFprobe, Chromium/chromium-sandbox/fonts, Zstd. Test stage alone includes compiler for -race. PRODUCT_CATALOG_ROOT=/app/catalog; actual bundled project/assets copied to that exact directory.

## Asset importer and files

`Import(ctx,owner,projectID,logicalID,artifact,body)` verifies size/hash/MIME/kind and actual FFprobe dimensions/duration for IMAGE/VIDEO/AUDIO. FILE parsers validate GLB2/embedded glTF2, OBJ finite vertices/face indices, FBX7000..7700 binary nodes/arrays/footer and canonical ASCII mesh arrays, ASCII/binary PLY records, SPZ1..3 gzip streams and SPZ4 Zstd TOC/data sizes, SPLAT32-byte points, UTF8 Markdown. No external GLTF URI. Stable ast_+48hex logicalId digest; owner/project/hash/source provenance mismatch409; atomically linked immutable owned file and READY row. Returned `Version="sha256:"+checksum`. All actual model/mock marker fields persist in assets.provenance. Real authored sources produce testMode=false; any explicit MOCK source keeps testMode=true on the MEDIA task/plan/output/imported derivative, with fixture label stating real FFmpeg transformed a MOCK source.

`Read(ctx,owner,ids)` returns only owned READY actual regular files after size/hash check. `EnsureVault(ctx,owner,"ASSET_VAULT"|"STUDIO_ASSETS")` creates stable private storage root with internal_kind, invisible in normal projects. `URL(ctx,owner,session,id)` signs existing core asset-read URL, no browser authority input.

POST /api/v2/file-assets: multipart exactly file+projectId, UUID Idempotency-Key. Extensions glb/gltf/obj/fbx/ply/spz/splat/md/markdown; actual parser, not filename alone. PF201/200 Asset includes provenance/testMode plus signed read URLs. GET /file-assets/{id}: only own FILE. Existing frozen v1 image/video/audio upload unchanged.

POST /catalog/media/materialize: `{projectId?,family,resourceId,revision,path}` UUID; path RFC6901 into EXACT persisted SYSTEM resource content/version. Only resources.catalog_media registered /project/assets path, bounded real local file under cfg.CatalogRoot, no symlink escape or network. Missing file/catalog404. Response `{asset:<real READY Asset>}`. Missing projectId uses ASSET_VAULT. Alternate resource /catalog/media/import implemented via ProductAssetStore.ImportCatalogMedia(resources.MediaImport); repository supplies its authorized persisted trusted SourcePath, same bounds and actual importer. Request hash binds idempotency, no arbitrary browser URL.

## Real non-model media

POST /media-jobs `{projectId,nodeId?,operation?|operateType?,bizType?:CANVAS,executor?:FFMPEG,spec}` UUID. `spec` version1; inputs `[{id,assetId}]` only; tracks video/audio; split/compress native aliases normalize to video; ordered clips `{input,trim:{startMs,endMs?},crop:{x,y,width,height},speed,reverse,rotate:"0|90|180|270",mirror:"horizontal|vertical"}`. Missing version/output supported native defaults. Output mp4/webm/mov/wav, fps<=60, even dimensions<=3840x2160, matching codecs, crf18..40, maxBytes<=configured bound, preset enum actually applied: H264 exact veryfast/fast/medium, VP9 cpu-used8/4/2; defaultfast. WAV rejects video-only fields. Reverse buffers normalized output frames/audio only; a conservative <=256MiB decoded buffer estimate rejects oversized clips before FFmpeg. Image loops have finite source duration. No input URL or shell interpolation. Crop/speed/reverse/rotate/mirror/trim/compose/concat/audio extraction/compression execute actual FFmpeg. Video concat normalizes audio including actual silence for silent clips; combined audio can override video track.

MEDIA jobs reuse execution.tasks/events/history and root worker leasing. Persistent QUEUED→RUNNING→SUCCEEDED/FAILED, canceled single terminal. Processor polls cancellation200ms and kills real subprocess. Bounded output checked by actual duration as well as size, so successful -fs truncation never claims completion. GET /media-jobs/{id} exposes taskId/jobId/id/state/revision/status (SUCCEEDED→SUCCESS), outputs real assetId/url/dimensions/durationMs, first outputUrl/videoUrl. POST cancel body{}.

## Actual Studio

POST /studio/projects/{id}/render `{fps:24|30|60,quality:draft|standard|high,format:mp4|webm|mov,resolution?:1080p|4k,composition?:ownedHTMLPath}` UUID + strong HF-root If-Match →202 `{jobId}`. Authorized PG project/files freeze into private execution plan at same revision, max100files/32MiB. Independent HF project outputs use STUDIO_ASSETS vault and TargetID remains HF root. Worker restart reuses original authored bytes; saved actual output checkpoint verified by SHA resumes without regenerating different browser content.

A separate Chromium process/private profile/CDP loads only per-job loopback workspace server. DNS excludes loopback and blocks external destinations; Fetch/CSP block foreign HTTP/file/workers, errors/missing external scripts fail task. The renderer opens command.composition as the actual owned saved HTML path (defaultindex.html), checks it exists in the immutable bundle, and reads that document’s actual `[data-composition-id]` duration/dimensions or GSAP `window.__timelines[id]`, CSS animations and workspace media are sought for real PNG frames, then FFmpeg encodes actual MP4/WebM/MOV. Duration<=120s, frames<=7200, dims<=3840x2160, bounded workspace/output. Saved media-tag audio/video tracks are actually mixed from local bytes using start/trim/rate/volume; no synthetic audio except explicit silent video normalization. Full movie duration/decoder checked. External CDN dependencies require user bundled files; no remote fetching.

GET /studio/renders/{id}: actual durable state, QUEUED/RUNNING/SUCCEEDED/FAILED/CANCELLED, progress0 before complete/100 completed, ETag. No timer fake progress. GET /studio/projects/{id}/renders `{renders:[...]}` actual history up to1000, explicit413 above bound. DELETE /studio/renders/{id} task If-Match: cancel then hide actual file/history, stale412. GET /studio/projects/{id}/renders/file/{filename}: owned completed actual PG bytes, integrity hash/MIME/ranges. Importer also persists own VIDEO asset.

POST /studio/projects/{id}/preview-session `{path,composition}` UUID → `{url,expiresIn:300}`. URL /api/v2/studio/preview/{projectId}/{grant}/{path}; JWT purpose studio-preview binds owner/session/root/revision, live IPAC tv.access and session rechecked on EVERY file. Sandboxed opaque-origin authored HTML; relative files inherit same bounded grant. Every authored HTML preview, main or subcomposition, gets the real message bridge. Native state{frame,isPlaying}, timeline{durationInFrames,clips:[track,tagName/kind,assetUrl]}, stage-size and seek{frame} use30fps. Authoritative ready is sent only after actual load/fonts/media metadata + valid composition duration/dimensions. Parent probe replays ready. Parent-only edit RPC inspects/selects/mutates real DOM and emits pointer selection descriptors; authenticated server file-mutations/edit persists parsed HTML with root revision/receipt/event in one transaction. Exact frontend integration seam is .local/iteration-03/media-bridge-seam.md. JWT path segment must be redacted by root HTTP/nginx access logging. Public preview error logging sanitized locally. No login Bearer in URL, no fake file/render/preview.

## Validation evidence

Actual deployment-host isolated PG17+FFmpeg+Chromium run20261005T203153-5d14120f988a passed: Router68PASS/0FAIL/0testSKIP; STUDIO scoped media/asset/Studio14PASS/0FAIL/0testSKIP under-race. Actual movie decoding, immutable authored snapshot, owning user boundaries, cancellation, idempotent file/hash import, catalog bytes, signed preview/revocation and deletion all passed. Exact-resource cleanup_errors=[]; no published ports, external providers or production data.

After that immutable proof, source gained MOCK derivative propagation assertions, applied preset/reverse bounds, native frame/edit bridge and readiness, owned subcomposition path rendering, persisted HTML editing, and OBJ/FBX validators/uploads. Local compile/unit/vet/diff-check pass. New actual-tool and PostgreSQL assertions are present; root’s next unrestricted isolated full suite must verify this final snapshot. Passing the earlier14-test snapshot does not prove later edits or native browser UI interaction. All PG tests require explicit TEST_DATABASE_URL and disposable testdb, shared test lock2106768132243. No Git commit or deployment.

Unrestricted actual run211350-ec17fa1355f6: Router68PASS, PF380PASS/1FAIL, zero test skips; new media/Chromium/edit/3D assertions passed. The sole outdated preview equality test was corrected to verify exact saved prefix+authoritative bridge and stronger opaque-sandbox/cache/revision headers. Binary FBX Geometry ID/name/Mesh validation and real-header fixture were tightened afterward. Final unrestricted rerun verifies both final edits.
