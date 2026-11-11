package core

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	execpg "studiotv.local/service/api/internal/modules/execution/adapters/postgres"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	execdomain "studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/modules/media/adapters/chromium"
	"studiotv.local/service/api/internal/modules/media/adapters/ffmpeg"
	mediaHTTP "studiotv.local/service/api/internal/modules/media/adapters/http"
	"studiotv.local/service/api/internal/modules/media/adapters/studiopg"
	media "studiotv.local/service/api/internal/modules/media/application"
	mediadomain "studiotv.local/service/api/internal/modules/media/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"studiotv.local/service/api/internal/testdb"
	"strings"
	"testing"
	"time"
)

func productTestDB(t *testing.T) (*pgxpool.Pool, context.Context, string, string, string, config.Config) {
	t.Helper()
	pool := testdb.New(t).Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	if err := database.Migrate(ctx, pool); err != nil {
		t.Fatal("media migration failed", err)
	}
	lock, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(2106768132243)`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { lock.Exec(context.Background(), `SELECT pg_advisory_unlock(2106768132243)`); lock.Release() })
	a, b := "usr_"+uuid.NewString(), "usr_"+uuid.NewString()
	p := "prj_" + uuid.NewString()
	_, err = pool.Exec(ctx, `INSERT INTO users(id,email,display_name) VALUES($1,$1||'@example.test','A'),($2,$2||'@example.test','B')`, a, b)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO projects(id,owner_id,name) VALUES($1,$2,'media fixture')`, p, a); err != nil {
		t.Fatal(err)
	}
	probe := os.Getenv("TEST_FFPROBE_PATH")
	if probe == "" {
		probe = "ffprobe"
	}
	cfg := config.Config{StorageRoot: t.TempDir(), MaxUploadBytes: 16 << 20, FFprobePath: probe, PublicBaseURL: "http://localhost", SigningSecret: "test-only-product-asset-secret-32-bytes", Issuer: "test", Audience: "test"}
	return pool, ctx, a, b, p, cfg
}
func pngBody(t *testing.T) []byte {
	t.Helper()
	i := image.NewNRGBA(image.Rect(0, 0, 160, 96))
	for y := 0; y < 96; y++ {
		for x := 0; x < 160; x++ {
			i.SetNRGBA(x, y, color.NRGBA{R: uint8(x), G: uint8(y), B: 120, A: 255})
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, i); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func testArtifact(body []byte, typ, kind string) gateway.Artifact {
	hash := sha256.Sum256(body)
	return gateway.Artifact{Ref: "test-fixture", Kind: &kind, MediaType: typ, SizeBytes: int64(len(body)), SHA256: hex.EncodeToString(hash[:]), TestMode: true, FixtureLabel: "MOCK unit fixture"}
}
func requireFFTools(t *testing.T) (string, string) {
	t.Helper()
	ff := os.Getenv("TEST_FFMPEG_PATH")
	if ff == "" {
		ff = "ffmpeg"
	}
	probe := os.Getenv("TEST_FFPROBE_PATH")
	if probe == "" {
		probe = "ffprobe"
	}
	for _, p := range []string{ff, probe} {
		if _, err := exec.LookPath(p); err != nil {
			t.Skip("actual FFmpeg/FFprobe unavailable")
		}
	}
	return ff, probe
}
func TestProductAssetImporterPostgresIntegrityAndOwnership(t *testing.T) {
	_, _ = requireFFTools(t)
	pool, ctx, a, b, p, cfg := productTestDB(t)
	store, e := NewProductAssetStore(cfg, pool)
	if e != nil {
		t.Fatal(e)
	}
	body := pngBody(t)
	art := testArtifact(body, "image/png", "IMAGE")
	asset, e := store.Import(ctx, a, p, "stable-image", art, body)
	if e != nil || asset.Width == nil || *asset.Width != 160 || asset.Version != "sha256:"+art.SHA256 {
		t.Fatal("actual import metadata", asset, e)
	}
	ownedRead, e := store.Read(ctx, a, []string{asset.ID})
	if e != nil || len(ownedRead) != 1 || !ownedRead[0].TestMode || ownedRead[0].FixtureLabel != "MOCK unit fixture" {
		t.Fatal("mock source provenance lost", e)
	}
	again, e := store.Import(ctx, a, p, "stable-image", art, body)
	if e != nil || again.ID != asset.ID {
		t.Fatal("idempotent import", e)
	}
	other := art
	other.SHA256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if _, e = store.Import(ctx, a, p, "invalid-checksum", other, body); e == nil {
		t.Fatal("bad checksum admitted")
	}
	other = art
	other.SizeBytes++
	if _, e = store.Import(ctx, a, p, "invalid-size", other, body); e == nil {
		t.Fatal("bad size admitted")
	}
	if _, e = store.Read(ctx, b, []string{asset.ID}); e == nil {
		t.Fatal("foreign asset visible")
	}
	if _, e = store.Import(ctx, b, p, "foreign", art, body); e == nil {
		t.Fatal("foreign project admitted")
	}
	vault, e := store.EnsureVault(ctx, a, "ASSET_VAULT")
	if e != nil {
		t.Fatal(e)
	}
	againVault, e := store.EnsureVault(ctx, a, "ASSET_VAULT")
	if e != nil || againVault != vault {
		t.Fatal("vault retry", e)
	}
	var kind string
	if e = pool.QueryRow(ctx, `SELECT internal_kind FROM projects WHERE id=$1 AND owner_id=$2`, vault, a).Scan(&kind); e != nil || kind != "ASSET_VAULT" {
		t.Fatal("vault metadata", e)
	}
	path := filepath.Join(cfg.StorageRoot, asset.ID)
	os.Chmod(path, 0640)
	body[0] ^= 1
	if e = os.WriteFile(path, body, 0640); e != nil {
		t.Fatal(e)
	}
	if _, e = store.Read(ctx, a, []string{asset.ID}); e == nil {
		t.Fatal("corrupt owned file admitted")
	}
}
func validTestGLB() []byte {
	raw := []byte(`{"asset":{"version":"2.0"},"scene":0,"scenes":[{}]}`)
	for len(raw)%4 != 0 {
		raw = append(raw, ' ')
	}
	body := make([]byte, 20+len(raw))
	copy(body, "glTF")
	binary.LittleEndian.PutUint32(body[4:8], 2)
	binary.LittleEndian.PutUint32(body[8:12], uint32(len(body)))
	binary.LittleEndian.PutUint32(body[12:16], uint32(len(raw)))
	binary.LittleEndian.PutUint32(body[16:20], 0x4e4f534a)
	copy(body[20:], raw)
	return body
}
func TestProductFileValidationAndJSONPointer(t *testing.T) {
	valid := validTestGLB()
	if e := validateProductFile("model/gltf-binary", valid); e != nil {
		t.Fatal(e)
	}
	for _, raw := range [][]byte{[]byte("garbage"), valid[:len(valid)-1]} {
		if e := validateProductFile("model/gltf-binary", raw); e == nil {
			t.Fatal("invalid GLB admitted")
		}
	}
	if e := validateProductFile("model/gltf+json", []byte(`{"asset":{"version":"2.0"},"buffers":[{"uri":"https://localhost/secret"}]}`)); e == nil {
		t.Fatal("external GLTF admitted")
	}
	content := []byte(`{"a/b":{"~key":["/project/assets/fixture.png"]}}`)
	value, e := jsonPointer(content, "/a~1b/~0key/0")
	if e != nil || value != "/project/assets/fixture.png" {
		t.Fatal("RFC6901 lookup", value, e)
	}
	for _, p := range []string{"/a~2b", "/a~1b/~0key/-1", "/a~1b/~0key/00", "/a~1b/~0key/1", "/a~1b/~0key", ""} {
		if _, e := jsonPointer(content, p); e == nil {
			t.Fatal("invalid pointer accepted", p)
		}
	}
}
func TestProductFileUploadIdempotencyPostgres(t *testing.T) {
	pool, ctx, a, b, p, cfg := productTestDB(t)
	store, _ := NewProductAssetStore(cfg, pool)
	router := chi.NewRouter()
	uid := a
	store.RegisterProductAssetRoutes(router, func(_ string, h httpapi.Handler) http.HandlerFunc {
		return httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			return h(w, httpapi.WithIdentity(r, httpapi.Identity{UserID: uid, SessionID: "test-session"}))
		})
	})
	key := uuid.NewString()
	post := func(body []byte, name string) *httptest.ResponseRecorder {
		var payload bytes.Buffer
		form := multipart.NewWriter(&payload)
		part, _ := form.CreateFormFile("file", name)
		part.Write(body)
		form.WriteField("projectId", p)
		form.Close()
		req := httptest.NewRequest("POST", "/api/v2/file-assets", &payload)
		req.Header.Set("Content-Type", form.FormDataContentType())
		req.Header.Set("Idempotency-Key", key)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	body := validTestGLB()
	first := post(body, "model.glb")
	if first.Code != 201 {
		t.Fatal("FILE upload", first.Code, first.Body.String())
	}
	if again := post(body, "model.glb"); again.Code != 200 {
		t.Fatal("FILE upload retry", again.Code, again.Body.String())
	}
	if changed := post(body, "different.glb"); changed.Code != 409 {
		t.Fatal("FILE upload metadata conflict", changed.Code, changed.Body.String())
	}
	uid = b
	if foreign := post(body, "model.glb"); foreign.Code != 404 {
		t.Fatal("foreign project upload", foreign.Code)
	}
	var count int
	if e := pool.QueryRow(ctx, `SELECT count(*) FROM assets WHERE owner_id=$1`, a).Scan(&count); e != nil || count != 1 {
		t.Fatal("idempotency created extra assets", count, e)
	}
	uid = a
	for _, format := range []struct {
		name, typ string
		body      []byte
	}{{"triangle.obj", "model/obj", []byte("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n")}, {"triangle.fbx", "application/x-fbx", productBinaryFBXTriangle()}} {
		key = uuid.NewString()
		w := post(format.body, format.name)
		if w.Code != 201 {
			t.Fatal("actual 3D format upload", format.name, w.Code, w.Body.String())
		}
		var checksum, typ, id string
		if e := pool.QueryRow(ctx, "SELECT id,checksum_sha256,mime_type FROM public.assets WHERE owner_id=$1 AND file_name=$2", a, format.name).Scan(&id, &checksum, &typ); e != nil {
			t.Fatal(e)
		}
		digest := sha256.Sum256(format.body)
		if checksum != hex.EncodeToString(digest[:]) || typ != format.typ {
			t.Fatal("3D upload hash/MIME incorrect", format.name)
		}
		actual, e := store.Read(ctx, a, []string{id})
		if e != nil || len(actual) != 1 || actual[0].Kind != "FILE" {
			t.Fatal("3D uploaded owned bytes unavailable", e)
		}
	}
}

type blockingMediaEngine struct{ started chan struct{} }

func (e blockingMediaEngine) Execute(ctx context.Context, _ mediadomain.Spec, _ []media.InputAsset) (media.Result, error) {
	close(e.started)
	<-ctx.Done()
	return media.Result{}, ctx.Err()
}
func TestMediaTaskPersistentExecutionAndCancellationPostgres(t *testing.T) {
	ff, probe := requireFFTools(t)
	pool, ctx, a, b, p, cfg := productTestDB(t)
	cfg.FFprobePath = probe
	assets, _ := NewProductAssetStore(cfg, pool)
	input := filepath.Join(t.TempDir(), "fixture.mp4")
	cmd := exec.CommandContext(ctx, ff, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=24", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", input)
	if e := cmd.Run(); e != nil {
		t.Fatal("actual video fixture", e)
	}
	body, _ := os.ReadFile(input)
	art := testArtifact(body, "video/mp4", "VIDEO")
	art.TestMode = false
	art.FixtureLabel = ""
	source, e := assets.Import(ctx, a, p, "media-source", art, body)
	if e != nil {
		t.Fatal(e)
	}
	store, _ := execpg.New(pool)
	engine, _ := ffmpeg.New(ff, probe, cfg.MaxUploadBytes)
	service, _ := media.New(store, assets, assets, engine)
	raw := json.RawMessage(`{"version":1,"inputs":[{"id":"v","assetId":"` + source.ID + `"}],"tracks":[{"type":"video","clips":[{"input":"v","rotate":"90"}]}],"output":{"container":"mp4"}}`)
	command := media.Command{ProjectID: p, NodeID: "node", Operation: "ROTATE", Spec: raw}
	key := uuid.NewString()
	task, e := service.Submit(ctx, a, key, command)
	if e != nil {
		t.Fatal("media submit", e)
	}
	again, e := service.Submit(ctx, a, key, command)
	if e != nil || again.ID != task.ID {
		t.Fatal("media retry", e)
	}
	command.Operation = "MIRROR"
	if _, e = service.Submit(ctx, a, key, command); !errors.Is(e, execdomain.ErrConflict) {
		t.Fatal("different same key", e)
	}
	if _, e = service.Get(ctx, b, task.ID); !errors.Is(e, execdomain.ErrNotFound) {
		t.Fatal("foreign task visible", e)
	}
	lease := uuid.NewString()
	claimed, ok, e := store.Claim(ctx, lease)
	if e != nil || !ok || claimed.ID != task.ID {
		t.Fatal("media claim", e)
	}
	restart, _ := media.New(store, assets, assets, engine)
	if ok, e = restart.Process(ctx, claimed, lease); e != nil || !ok {
		t.Fatal("persistent real media execution", e)
	}
	saved, e := store.Get(ctx, a, task.ID)
	if e != nil || saved.State != "SUCCEEDED" || saved.TestMode || len(saved.Plans[0].Outputs) != 1 || saved.Plans[0].Outputs[0].AssetID == nil {
		t.Fatal("real output did not persist", saved.State, e)
	}
	history, e := store.History(ctx, a, execution.HistoryQuery{ProjectID: p, NodeID: "node", Page: 1, Size: 100})
	if e != nil || history.Total != 1 {
		t.Fatal("real media history missing", history, e)
	}
	command.Operation = "ROTATE"
	cancelTask, e := service.Submit(ctx, a, uuid.NewString(), command)
	if e != nil {
		t.Fatal(e)
	}
	lease = uuid.NewString()
	claimed, ok, e = store.Claim(ctx, lease)
	if e != nil || !ok || claimed.ID != cancelTask.ID {
		t.Fatal(e)
	}
	started := make(chan struct{})
	blocked, _ := media.New(store, assets, assets, blockingMediaEngine{started})
	finished := make(chan error, 1)
	go func() { _, e := blocked.Process(ctx, claimed, lease); finished <- e }()
	<-started
	if _, e = service.Cancel(ctx, a, cancelTask.ID); e != nil {
		t.Fatal(e)
	}
	select {
	case e = <-finished:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancellation did not stop process")
	}
	saved, e = store.Get(ctx, a, cancelTask.ID)
	if e != nil || saved.State != "CANCELED" || len(saved.Plans[0].Outputs) != 0 {
		t.Fatal("canceled task changed terminal state", e)
	}
	art.TestMode = true
	art.FixtureLabel = "MOCK unit fixture"
	mockSource, e := assets.Import(ctx, a, p, "media-mock-source", art, body)
	if e != nil {
		t.Fatal(e)
	}
	mockRaw := bytes.ReplaceAll(raw, []byte(source.ID), []byte(mockSource.ID))
	command.Spec = mockRaw
	mockTask, e := service.Submit(ctx, a, uuid.NewString(), command)
	if e != nil || !mockTask.TestMode {
		t.Fatal("mock source task marker missing", e)
	}
	lease = uuid.NewString()
	claimed, ok, e = store.Claim(ctx, lease)
	if e != nil || !ok || claimed.ID != mockTask.ID {
		t.Fatal("mock derivative claim", e)
	}
	if ok, e = service.Process(ctx, claimed, lease); e != nil || !ok {
		t.Fatal("actual mock derivative processing", e)
	}
	saved, e = store.Get(ctx, a, mockTask.ID)
	if e != nil || saved.State != "SUCCEEDED" || !saved.Plans[0].Outputs[0].TestMode {
		t.Fatal("mock derivative marker lost", e)
	}
	derived, e := assets.Read(ctx, a, []string{*saved.Plans[0].Outputs[0].AssetID})
	if e != nil || !derived[0].TestMode {
		t.Fatal("mock derivative asset marker lost", e)
	}
}

func TestStudioPersistentRenderSnapshotAndSignedPreviewPostgres(t *testing.T) {
	ff, probe := requireFFTools(t)
	chrome := os.Getenv("TEST_CHROMIUM_PATH")
	if chrome == "" {
		chrome = "chromium"
	}
	if _, e := exec.LookPath(chrome); e != nil {
		t.Skip("actual Chromium unavailable")
	}
	pool, ctx, a, b, _, cfg := productTestDB(t)
	cfg.FFprobePath = probe
	assets, _ := NewProductAssetStore(cfg, pool)
	store, _ := execpg.New(pool)
	repo, _ := studiopg.New(pool, store)
	renderer, e := chromium.New(chrome, ff, probe, cfg.MaxUploadBytes, os.Getenv("TEST_CHROMIUM_SANDBOX_MODE"))
	if e != nil {
		t.Fatal(e)
	}
	studio, _ := media.NewStudio(store, repo, renderer, assets)
	id := "hf_" + uuid.NewString()
	html := []byte(`<html><body style="margin:0"><main data-composition-id="scene" data-duration="0.25" data-width="160" data-height="96" style="width:160px;height:96px;background:#265c84">Actual saved project</main></body></html>`)
	if _, e = pool.Exec(ctx, `INSERT INTO resources.studio_projects(id,owner_id,title)VALUES($1,$2,'authored studio')`, id, a); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, `INSERT INTO resources.studio_files(project_id,owner_id,path,content,mime_type,revision) VALUES($1,$2,'index.html',$3,'text/html',1)`, id, a, html); e != nil {
		t.Fatal(e)
	}
	command := mediadomain.RenderCommand{FPS: 24, Quality: "draft", Format: "mp4"}
	key := uuid.NewString()
	task, e := studio.Submit(ctx, a, id, key, 1, command)
	if e != nil || task.ProjectID == nil {
		t.Fatal("studio create with private vault", e)
	}
	again, e := studio.Submit(ctx, a, id, key, 1, command)
	if e != nil || again.ID != task.ID {
		t.Fatal("studio idempotency", e)
	}
	if _, e = studio.Get(ctx, b, task.ID); !errors.Is(e, execdomain.ErrNotFound) {
		t.Fatal("foreign render visible", e)
	}
	if _, e = studio.Submit(ctx, b, id, uuid.NewString(), 1, command); !errors.Is(e, execdomain.ErrNotFound) {
		t.Fatal("foreign root render admitted", e)
	}
	if _, e = studio.Submit(ctx, a, id, uuid.NewString(), 2, command); e == nil {
		t.Fatal("stale root revision accepted")
	}
	if _, e = pool.Exec(ctx, `UPDATE resources.studio_files SET content=$3,revision=2 WHERE project_id=$1 AND owner_id=$2`, id, a, []byte("changed after accept")); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, `UPDATE resources.studio_projects SET revision=2 WHERE id=$1 AND owner_id=$2`, id, a); e != nil {
		t.Fatal(e)
	}
	lease := uuid.NewString()
	claimed, ok, e := store.Claim(ctx, lease)
	if e != nil || !ok || claimed.ID != task.ID {
		t.Fatal("studio claim", e)
	}
	restart, _ := media.NewStudio(store, repo, renderer, assets)
	if ok, e = restart.Process(ctx, claimed, lease); e != nil || !ok {
		t.Fatal("actual immutable snapshot render", e)
	}
	saved, e := studio.Get(ctx, a, task.ID)
	if e != nil || saved.State != "SUCCEEDED" || saved.TestMode || saved.Plans[0].Outputs[0].AssetID == nil {
		t.Fatal("studio output missing", saved.State, e)
	}
	file, e := studio.File(ctx, a, id, task.ID+".mp4")
	if e != nil || len(file.Content) == 0 || file.DurationMs < 240 {
		t.Fatal("real persisted render bytes", e)
	}
	out := filepath.Join(t.TempDir(), "render.mp4")
	os.WriteFile(out, file.Content, 0600)
	if e = exec.CommandContext(ctx, ff, "-v", "error", "-i", out, "-f", "null", "-").Run(); e != nil {
		t.Fatal("persisted render decode", e)
	}
	router := chi.NewRouter()
	revoked := false
	protect := func(_ string, h httpapi.Handler) http.HandlerFunc {
		return httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			return h(w, httpapi.WithIdentity(r, httpapi.Identity{UserID: a, SessionID: "studio-session"}))
		})
	}
	mediaHTTP.RegisterStudioRoutes(router, router, studio, repo, cfg, protect, func(r *http.Request, owner, session string) (*http.Request, error) {
		if revoked || owner != a || session != "studio-session" {
			return r, httpapi.Fail(401, "UNAUTHENTICATED", "session revoked")
		}
		return httpapi.WithIdentity(r, httpapi.Identity{UserID: a, SessionID: "studio-session"}), nil
	})
	req := httptest.NewRequest("POST", "/api/v2/studio/projects/"+id+"/preview-session", bytes.NewBufferString(`{"path":"index.html","composition":false}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", uuid.NewString())
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 201 {
		t.Fatal("preview grant", w.Code, w.Body.String())
	}
	var envelope struct {
		Data struct {
			URL string `json:"url"`
		} `json:"data"`
	}
	json.Unmarshal(w.Body.Bytes(), &envelope)
	previewURL, e := url.Parse(envelope.Data.URL)
	if e != nil {
		t.Fatal(e)
	}
	w = httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", previewURL.RequestURI(), nil))
	base, _ := url.Parse(cfg.PublicBaseURL)
	expectedBody := "changed after accept" + mediaHTTP.PreviewBridge("index.html", base.Scheme+"://"+base.Host)
	csp := w.Header().Get("Content-Security-Policy")
	// Main HTML deliberately carries the authoritative bridge now. Preserve
	// the exact latest saved prefix and exact appended bridge, while checking
	// that the sandbox remains opaque and the grant still binds revision2.
	if w.Code != 200 || w.Body.String() != expectedBody || !strings.Contains(csp, "sandbox allow-scripts") || strings.Contains(csp, "allow-same-origin") || w.Header().Get("ETag") != `"2"` || w.Header().Get("Referrer-Policy") != "no-referrer" || w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatal("preview did not serve actual latest authorized bytes", w.Code)
	}
	revoked = true
	w = httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", previewURL.RequestURI(), nil))
	if w.Code != 401 {
		t.Fatal("revoked preview survived", w.Code)
	}
	if e = studio.Delete(ctx, a, task.ID, saved.Revision); e != nil {
		t.Fatal(e)
	}
	if _, e = studio.File(ctx, a, id, task.ID+".mp4"); e == nil {
		t.Fatal("deleted render file still visible")
	}
}

func TestCatalogMaterializationBoundLocalBytesPostgres(t *testing.T) {
	ff, _ := requireFFTools(t)
	pool, ctx, a, _, p, cfg := productTestDB(t)
	cfg.CatalogRoot = t.TempDir()
	mediaDirectory := filepath.Join(cfg.CatalogRoot, "project", "assets")
	os.MkdirAll(mediaDirectory, 0750)
	body := pngBody(t)
	os.WriteFile(filepath.Join(mediaDirectory, "local.png"), body, 0640)
	version := "test_catalog_" + uuid.NewString()
	resource := "catalog_" + uuid.NewString()
	if _, e := pool.Exec(ctx, `INSERT INTO resources.catalog_imports(version,source_hash,source_name,row_count)VALUES($1,$2,'actual local test bytes',1)`, version, hex.EncodeToString(make([]byte, 32))); e != nil {
		t.Fatal(e)
	}
	if _, e := pool.Exec(ctx, `INSERT INTO resources.items(id,family,scope,name,content,source_version) VALUES($1,'CHARACTER','SYSTEM','Local fixture',$2,$3)`, resource, []byte(`{"images":["/project/assets/local.png"]}`), version); e != nil {
		t.Fatal(e)
	}
	if _, e := pool.Exec(ctx, `INSERT INTO resources.catalog_media(id,path,source_version)VALUES($1,'/project/assets/local.png',$2)`, "local_"+uuid.NewString(), version); e != nil {
		t.Fatal(e)
	}
	assets, _ := NewProductAssetStore(cfg, pool)
	router := chi.NewRouter()
	assets.RegisterProductAssetRoutes(router, func(_ string, h httpapi.Handler) http.HandlerFunc {
		return httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			return h(w, httpapi.WithIdentity(r, httpapi.Identity{UserID: a, SessionID: "catalog-session"}))
		})
	})
	key := uuid.NewString()
	submit := func(pointer string, revision int) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(map[string]any{"projectId": p, "family": "CHARACTER", "resourceId": resource, "revision": revision, "path": pointer})
		req := httptest.NewRequest("POST", "/api/v2/catalog/media/materialize", bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	if w := submit("/images/0", 1); w.Code != 201 {
		t.Fatal("actual catalog materialize", w.Code, w.Body.String())
	}
	if w := submit("/images/0", 1); w.Code != 201 {
		t.Fatal("catalog retry", w.Code, w.Body.String())
	}
	if w := submit("/images/1", 1); w.Code != 400 {
		t.Fatal("missing catalog path", w.Code)
	}
	if w := submit("/images/0", 2); w.Code != 404 {
		t.Fatal("unregistered catalog version", w.Code)
	}
	if e := os.Remove(filepath.Join(mediaDirectory, "local.png")); e != nil {
		t.Fatal(e)
	}
	if w := submit("/images/0", 1); w.Code != 404 {
		t.Fatal("missing local bytes fabricated", w.Code)
	}

	// STUDIO's independent content-addressed cache is accepted only as registered
	// catalog media, then materialized into the existing owned asset pipeline.
	encode := exec.CommandContext(ctx, ff, "-v", "error", "-i", "pipe:0", "-frames:v", "1", "-c:v", "libwebp", "-f", "webp", "pipe:1")
	encode.Stdin = bytes.NewReader(body)
	webp, e := encode.Output()
	if e != nil {
		t.Fatal("actual character WebP fixture", e)
	}
	digest := sha256.Sum256(webp)
	studioPath := "/studio-character-media/" + hex.EncodeToString(digest[:]) + ".webp"
	studioDirectory := filepath.Join(cfg.CatalogRoot, "studio-character-media")
	if e := os.MkdirAll(studioDirectory, 0750); e != nil {
		t.Fatal(e)
	}
	studioFile := filepath.Join(studioDirectory, filepath.Base(studioPath))
	if e := os.WriteFile(studioFile, webp, 0640); e != nil {
		t.Fatal(e)
	}
	content, _ := json.Marshal(map[string]any{"images": []string{studioPath}})
	if _, e := pool.Exec(ctx, `UPDATE resources.items SET content=$2,revision=2 WHERE id=$1`, resource, content); e != nil {
		t.Fatal(e)
	}
	if _, e := pool.Exec(ctx, `INSERT INTO resources.catalog_media(id,path,source_version)VALUES($1,$2,$3)`, "studio_"+uuid.NewString(), studioPath, version); e != nil {
		t.Fatal(e)
	}
	key = uuid.NewString()
	if w := submit("/images/0", 2); w.Code != 201 {
		t.Fatal("actual independent character materialize", w.Code, w.Body.String())
	}
	if e := os.WriteFile(studioFile, []byte("modified cached bytes"), 0640); e != nil {
		t.Fatal(e)
	}
	if w := submit("/images/0", 2); w.Code != 503 {
		t.Fatal("modified cache bytes accepted", w.Code, w.Body.String())
	}
}
func TestPLYAndLegacySPZValidateActualRecordLengths(t *testing.T) {
	ply := []byte("ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 1 2\n")
	if e := validateProductFile("application/x-ply", ply); e != nil {
		t.Fatal(e)
	}
	for _, bad := range [][]byte{ply[:len(ply)-3], bytes.ReplaceAll(ply, []byte("0 1 2"), []byte("NaN 1 2"))} {
		if e := validateProductFile("application/x-ply", bad); e == nil {
			t.Fatal("invalid PLY admitted")
		}
	}
	header := make([]byte, 35)
	copy(header, "NGSP")
	binary.LittleEndian.PutUint32(header[4:8], 2)
	binary.LittleEndian.PutUint32(header[8:12], 1)
	header[13] = 12
	var zipped bytes.Buffer
	writer := gzip.NewWriter(&zipped)
	writer.Write(header)
	writer.Close()
	if e := validateProductFile("application/x-spz", zipped.Bytes()); e != nil {
		t.Fatal("valid legacy SPZ", e)
	}
	zipped.Reset()
	writer = gzip.NewWriter(&zipped)
	writer.Write(header[:16])
	writer.Close()
	if e := validateProductFile("application/x-spz", zipped.Bytes()); e == nil {
		t.Fatal("truncated SPZ admitted")
	}
}

func TestStudioEditsPersistentOwnedHTMLAndReceiptsPostgres(t *testing.T) {
	pool, ctx, a, b, _, _ := productTestDB(t)
	store, _ := execpg.New(pool)
	repo, _ := studiopg.New(pool, store)
	id := "hf_" + uuid.NewString()
	if _, e := pool.Exec(ctx, "INSERT INTO resources.studio_projects(id,owner_id,title) VALUES($1,$2,'editable authored file')", id, a); e != nil {
		t.Fatal(e)
	}
	if _, e := pool.Exec(ctx, "INSERT INTO resources.studio_files(project_id,owner_id,path,content,mime_type,revision) VALUES($1,$2,'compositions/a.html',$3,'text/html',1)", id, a, []byte(`<html><body><p id="caption">Old</p></body></html>`)); e != nil {
		t.Fatal(e)
	}
	text := "Saved real edit"
	cmd := mediadomain.EditCommand{Target: mediadomain.ElementTarget{ID: "caption"}, Operations: []mediadomain.EditOperation{{Type: "text", Value: &text}}}
	key := uuid.NewString()
	result, e := repo.EditFile(ctx, a, id, "compositions/a.html", key, 1, cmd)
	if e != nil || result.Revision != 2 || !strings.Contains(result.Content, "Saved real edit") {
		t.Fatal("persisted authored edit", e)
	}
	again, e := repo.EditFile(ctx, a, id, "compositions/a.html", key, 1, cmd)
	if e != nil || again != result {
		t.Fatal("edit retry lost receipt", e)
	}
	changed := "Different"
	cmd.Operations[0].Value = &changed
	if _, e = repo.EditFile(ctx, a, id, "compositions/a.html", key, 1, cmd); e == nil {
		t.Fatal("changed edit reused receipt")
	}
	if _, e = repo.EditFile(ctx, a, id, "compositions/a.html", uuid.NewString(), 1, cmd); e == nil {
		t.Fatal("stale edit admitted")
	}
	if _, e = repo.EditFile(ctx, b, id, "compositions/a.html", uuid.NewString(), 2, cmd); !errors.Is(e, execdomain.ErrNotFound) {
		t.Fatal("foreign authored edit admitted", e)
	}
	var raw []byte
	var events int
	if e = pool.QueryRow(ctx, "SELECT content FROM resources.studio_files WHERE project_id=$1 AND owner_id=$2", id, a).Scan(&raw); e != nil || !strings.Contains(string(raw), "Saved real edit") {
		t.Fatal("real edited bytes missing", e)
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM resources.studio_events WHERE project_id=$1 AND owner_id=$2", id, a).Scan(&events); e != nil || events != 1 {
		t.Fatal("retry duplicated edit event", events, e)
	}
}

func TestOBJAndFBXValidateGeometryAndRejectUnrelatedPayload(t *testing.T) {
	obj := []byte("# owned triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n")
	if e := validateProductFile("model/obj", obj); e != nil {
		t.Fatal("actual OBJ triangle", e)
	}
	for _, bad := range [][]byte{bytes.ReplaceAll(obj, []byte("f 1 2 3"), []byte("f 1 2 99")), bytes.ReplaceAll(obj, []byte("v 0 0 0"), []byte("v NaN 0 0")), append(append([]byte(nil), obj...), []byte("mtllib https://private.invalid/x.mtl\n")...)} {
		if e := validateProductFile("model/obj", bad); e == nil {
			t.Fatal("invalid/external OBJ admitted")
		}
	}
	ascii := []byte("; FBX 7.4.0 project file\nFBXHeaderExtension: {\n FBXVersion: 7400\n}\nObjects: {\n Geometry: 1, \"Geometry::Triangle\", \"Mesh\" {\n Vertices: *9 {\n a: 0,0,0,1,0,0,0,1,0\n }\n PolygonVertexIndex: *3 {\n a: 0,1,-3\n }\n }\n}\n")
	if e := validateProductFile("application/x-fbx", ascii); e != nil {
		t.Fatal("actual ASCII FBX triangle", e)
	}
	for _, bad := range [][]byte{ascii[:len(ascii)-3], bytes.ReplaceAll(ascii, []byte("0,1,-3"), []byte("0,1,-99")), append(append([]byte(nil), ascii...), []byte("<script>evil()</script>\n")...)} {
		if e := validateProductFile("application/x-fbx", bad); e == nil {
			t.Fatal("malformed ASCII FBX admitted")
		}
	}
	binaryFBX := productBinaryFBXTriangle()
	if e := validateProductFile("application/x-fbx", binaryFBX); e != nil {
		t.Fatal("actual binary FBX node/array/footer", e)
	}
	if e := validateProductFile("application/x-fbx", binaryFBX[:len(binaryFBX)-1]); e == nil {
		t.Fatal("truncated binary FBX admitted")
	}
}

func productBinaryFBXTriangle() []byte {
	var out bytes.Buffer
	out.WriteString("Kaydara FBX Binary  \x00\x1a\x00")
	binary.Write(&out, binary.LittleEndian, uint32(7400))
	var node func(string, [][]byte, func())
	node = func(name string, properties [][]byte, children func()) {
		start := out.Len()
		out.Write(make([]byte, 13))
		out.WriteString(name)
		size := 0
		for _, p := range properties {
			out.Write(p)
			size += len(p)
		}
		if children != nil {
			children()
			out.Write(make([]byte, 13))
		}
		raw := out.Bytes()
		binary.LittleEndian.PutUint32(raw[start:start+4], uint32(out.Len()))
		binary.LittleEndian.PutUint32(raw[start+4:start+8], uint32(len(properties)))
		binary.LittleEndian.PutUint32(raw[start+8:start+12], uint32(size))
		raw[start+12] = byte(len(name))
	}
	array := func(kind byte, values any, count int) []byte {
		var p bytes.Buffer
		p.WriteByte(kind)
		binary.Write(&p, binary.LittleEndian, uint32(count))
		binary.Write(&p, binary.LittleEndian, uint32(0))
		var data bytes.Buffer
		binary.Write(&data, binary.LittleEndian, values)
		binary.Write(&p, binary.LittleEndian, uint32(data.Len()))
		p.Write(data.Bytes())
		return p.Bytes()
	}
	text := func(value string) []byte {
		var p bytes.Buffer
		p.WriteByte('S')
		binary.Write(&p, binary.LittleEndian, uint32(len(value)))
		p.WriteString(value)
		return p.Bytes()
	}
	integer := func(value int64) []byte {
		var p bytes.Buffer
		p.WriteByte('L')
		binary.Write(&p, binary.LittleEndian, value)
		return p.Bytes()
	}
	node("Objects", nil, func() {
		node("Geometry", [][]byte{integer(1), text("Geometry::Triangle"), text("Mesh")}, func() {
			node("Vertices", [][]byte{array('d', []float64{0, 0, 0, 1, 0, 0, 0, 1, 0}, 9)}, nil)
			node("PolygonVertexIndex", [][]byte{array('i', []int32{0, 1, -3}, 3)}, nil)
		})
		node("Model", [][]byte{integer(2), text("Model::Triangle"), text("Mesh")}, nil)
	})
	node("Connections", nil, func() {
		node("C", [][]byte{text("OO"), integer(1), integer(2)}, nil)
		node("C", [][]byte{text("OO"), integer(2), integer(0)}, nil)
	})
	out.Write(make([]byte, 13))
	out.Write([]byte{0xfa, 0xbc, 0xab, 9, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e})
	out.Write(make([]byte, 4))
	pad := 16 - out.Len()%16
	out.Write(make([]byte, pad))
	binary.Write(&out, binary.LittleEndian, uint32(7400))
	out.Write(make([]byte, 120))
	out.Write([]byte{0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b})
	return out.Bytes()
}
