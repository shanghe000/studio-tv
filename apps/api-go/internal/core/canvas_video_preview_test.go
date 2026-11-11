package core

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/httpapi"
)

const nativePosterQuery = "ci-process=snapshot&time=0&format=jpg&width=240&quality=72&minisize=1"

func posterVideo(t *testing.T, dir string) (Asset, []byte) {
	t.Helper()
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("requires ffmpeg for a real video and JPEG decode")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	file := filepath.Join(dir, "poster_video")
	// No faststart: the two-minute MP4's index is at EOF. A pipe reader cannot
	// provide the random access the poster decoder needs for archived longform.
	cmd := exec.CommandContext(ctx, ffmpeg, "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=1", "-t", "120", "-threads", "1", "-c:v", "mpeg4", "-q:v", "12", "-f", "mp4", file)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("create real video: %v %s", err, output)
	}
	content, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.LastIndex(content, []byte("moov")) < bytes.Index(content, []byte("mdat")) {
		t.Fatal("fixture must exercise MP4 seeking to its end-of-file index")
	}
	w, h, duration := 640, 360, float64(120)
	return Asset{ID: "poster_video", OwnerID: "usr_a", ProjectID: nodeLeaseProject, Kind: "VIDEO", State: "READY", MimeType: "video/mp4", FileName: "longform.mp4", Width: &w, Height: &h, Duration: &duration, ByteSize: int64(len(content)), Checksum: fmt.Sprintf("%x", sha256.Sum256(content))}, content
}

func TestVideoPreviewNativeParametersSeekAndKeepOriginalBytes(t *testing.T) {
	dir := t.TempDir()
	a, original := posterVideo(t, dir)
	srv := Server{cfg: config.Config{StorageRoot: dir}}
	serve := func(method, path string, headers map[string]string) (*httptest.ResponseRecorder, error) {
		t.Helper()
		r := httptest.NewRequest(method, path, nil)
		for key, value := range headers {
			r.Header.Set(key, value)
		}
		w := httptest.NewRecorder()
		err := srv.serveAssetBytes(w, r, a)
		return w, err
	}
	path := "/storage/assets/poster_video"
	poster, err := serve("GET", path+"?"+nativePosterQuery, nil)
	if err != nil || poster.Code != 200 || poster.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("native poster: %v %d %s", err, poster.Code, poster.Header().Get("Content-Type"))
	}
	decoded, err := jpeg.Decode(bytes.NewReader(poster.Body.Bytes()))
	if err != nil || decoded.Bounds().Dx() != 240 || decoded.Bounds().Dy() != 135 {
		t.Fatalf("invalid or wrong-size actual JPEG: %v", err)
	}
	for _, query := range []string{"ci-process=snapshot", "ci-process=snapshot&time=0&format=jpg&quality=96", "ci-process=snapshot&time=0&format=jpg&width=720&height=100&quality=100&strip=1"} {
		w, err := serve("GET", canvasMediaRoot+"scope/poster_video?"+query, nil)
		if err != nil || w.Header().Get("Content-Type") != "image/jpeg" {
			t.Fatalf("native default or canvas poster failed: %v", err)
		}
		if _, err := jpeg.Decode(bytes.NewReader(w.Body.Bytes())); err != nil {
			t.Fatal(err)
		}
	}
	if w, err := serve("HEAD", path+"?"+nativePosterQuery, nil); err != nil || w.Code != 200 || w.Body.Len() != 0 || w.Header().Get("Content-Length") != strconv.Itoa(poster.Body.Len()) {
		t.Fatal("poster HEAD did not preserve image metadata", err)
	}
	if w, err := serve("GET", path+"?"+nativePosterQuery, map[string]string{"If-None-Match": "W/" + poster.Header().Get("ETag")}); err != nil || w.Code != 304 || w.Body.Len() != 0 {
		t.Fatal("poster revalidation failed", err)
	}
	if w, err := serve("GET", path, map[string]string{"If-None-Match": poster.Header().Get("ETag")}); err != nil || w.Code != 200 || w.Header().Get("Content-Type") != "video/mp4" || !bytes.Equal(w.Body.Bytes(), original) {
		t.Fatal("poster changed original playback/download", err)
	}
	if w, err := serve("GET", path, map[string]string{"Range": "bytes=7-31"}); err != nil || w.Code != 206 || !bytes.Equal(w.Body.Bytes(), original[7:32]) {
		t.Fatal("original byte ranges changed", err)
	}
	if w, err := serve("GET", path+"?"+nativePosterQuery, map[string]string{"Range": "bytes=0-7"}); err != nil || w.Code != 200 || !bytes.Equal(w.Body.Bytes(), poster.Body.Bytes()) || w.Header().Get("Content-Range") != "" {
		t.Fatal("poster accidentally returned a range of the source video", err)
	}
	// Cached frames must not need another decoder, but variants and changed
	// content must not reuse that cache. Failure must never return MP4 as JPEG.
	t.Setenv("PATH", t.TempDir())
	if w, err := serve("GET", path+"?"+nativePosterQuery, nil); err != nil || !bytes.Equal(w.Body.Bytes(), poster.Body.Bytes()) {
		t.Fatal("valid poster was not reused", err)
	}
	a.Checksum = strings.Repeat("a", 64)
	if w, err := serve("GET", path+"?"+nativePosterQuery, nil); err == nil || w.Body.Len() != 0 {
		t.Fatal("different source content reused cached frame or fake success")
	}
	a.Checksum = fmt.Sprintf("%x", sha256.Sum256(original))
	a.State = "REJECTED"
	if _, err := serve("GET", path+"?"+nativePosterQuery, map[string]string{"If-None-Match": "*"}); err == nil {
		t.Fatal("cache bypassed READY gate")
	}
	a.State = "READY"
	if err := os.Remove(filepath.Join(dir, a.ID)); err != nil {
		t.Fatal(err)
	}
	if _, err := serve("GET", path+"?"+nativePosterQuery, map[string]string{"If-None-Match": "*"}); err == nil {
		t.Fatal("cached poster bypassed missing source gate")
	}
}

func TestVideoPreviewRejectsInvalidParametersAndCorruptVideo(t *testing.T) {
	for _, query := range []string{
		"ci-process=other", "ci-process=snapshot&ci-process=snapshot", "ci-process=snapshot&time=1000", "ci-process=snapshot&format=gif",
		"ci-process=snapshot&width=2561", "ci-process=snapshot&width=0", "ci-process=snapshot&width=0240", "ci-process=snapshot&width=240&width=480",
		"ci-process=snapshot&height=-1", "ci-process=snapshot&quality=101", "ci-process=snapshot&quality=0", "ci-process=snapshot&minisize=2", "ci-process=snapshot&strip=2", "ci-process=snapshot&previewWidth=240",
	} {
		q, _ := url.ParseQuery(query)
		if _, err := videoPreviewQuery(q); err == nil {
			t.Fatalf("accepted unbounded/ambiguous poster query %s", query)
		}
	}
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("requires ffmpeg to reject actual malformed media")
	}
	dir := t.TempDir()
	content := []byte("this is not a movie")
	if err := os.WriteFile(filepath.Join(dir, "broken"), content, 0600); err != nil {
		t.Fatal(err)
	}
	w, h := 640, 360
	a := Asset{ID: "broken", Kind: "VIDEO", State: "READY", MimeType: "video/mp4", Width: &w, Height: &h, ByteSize: int64(len(content)), Checksum: "broken"}
	srv := Server{cfg: config.Config{StorageRoot: dir}}
	rec := httptest.NewRecorder()
	err := srv.serveAssetBytes(rec, httptest.NewRequest("GET", "/storage/assets/broken?"+nativePosterQuery, nil), a)
	var failure *httpapi.Error
	if !errors.As(err, &failure) || failure.Status != 422 || rec.Body.Len() != 0 || srv.canvasPreviews.bytes != 0 {
		t.Fatalf("corrupt media produced/cache a successful poster: %v", err)
	}
	// The same bounded decoder slots are shared with image previews. A canceled
	// queued request exits without starting a process or keeping a slot.
	_, slots := srv.canvasPreviews.lookup("empty")
	slots <- struct{}{}
	slots <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err = srv.serveAssetBytes(httptest.NewRecorder(), httptest.NewRequest("GET", "/storage/assets/broken?"+nativePosterQuery, nil).WithContext(ctx), a)
	if !errors.Is(err, context.Canceled) || len(slots) != 2 {
		t.Fatal("canceled queued poster did not release promptly", err)
	}
	<-slots
	<-slots
}

func TestPostgresVideoPreviewAuthorizationBeforeCachedFrame(t *testing.T) {
	f := newNodeLeaseWriteFixture(t)
	cfg := testConfig(t)
	a, original := posterVideo(t, cfg.StorageRoot)
	if _, err := f.db.Exec(f.ctx, `INSERT INTO assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state,width,height,storage_key)
 VALUES($1,'usr_a',$2,'longform.mp4','VIDEO','video/mp4',$3,$4,'READY',640,360,$1)`, a.ID, nodeLeaseProject, a.ByteSize, a.Checksum); err != nil {
		t.Fatal(err)
	}
	sessions := &integrationSessions{}
	auth := httpapi.AuthFunc(func(_ context.Context, r *http.Request) (httpapi.Identity, error) {
		if r.Header.Get("Authorization") == "Bearer editor" {
			who := integrationPrincipal("usr_b")
			who.SessionExpiresAt = time.Now().Add(time.Hour)
			return who, nil
		}
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "fixture")
	})
	router, err := NewWithAuthorization(cfg, f.db, auth, authorization.New(&integrationRuntime{}, "cli_test", sessions))
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path string, cookie *http.Cookie, headers map[string]string, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, nil)
		if cookie != nil {
			r.AddCookie(cookie)
		}
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s got %d want %d: %s", method, w.Code, want, w.Body.String())
		}
		return w
	}
	meta := request("GET", "/api/v1/assets/"+a.ID, nil, map[string]string{"Authorization": "Bearer editor"}, 200)
	var envelope struct {
		Data struct {
			DownloadURL string `json:"downloadUrl"`
		}
	}
	if err := json.Unmarshal(meta.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	media, err := url.Parse(envelope.Data.DownloadURL)
	if err != nil || media.Query().Get("token") == "" {
		t.Fatal("asset metadata did not issue a signed playback URL", err)
	}
	path := media.RequestURI()
	poster := request("GET", path+"&"+nativePosterQuery, nil, nil, 200)
	if _, err := jpeg.Decode(bytes.NewReader(poster.Body.Bytes())); err != nil {
		t.Fatal(err)
	}
	tag := poster.Header().Get("ETag")
	request("HEAD", path+"&"+nativePosterQuery, nil, map[string]string{"If-None-Match": tag}, 304)
	if w := request("GET", path, nil, map[string]string{"Range": "bytes=0-7"}, 206); !bytes.Equal(w.Body.Bytes(), original[:8]) {
		t.Fatal("signed original range changed")
	}
	request("GET", "/storage/assets/"+a.ID+"?token=invalid&"+nativePosterQuery, nil, map[string]string{"If-None-Match": tag}, 401)
	open := request("GET", "/api/v1/projects/"+nodeLeaseProject+"/snapshot", nil, map[string]string{"Authorization": "Bearer editor", canvasMediaHeader: "lazy-v1"}, 200)
	cookie := open.Result().Cookies()[0]
	canvas := canvasMediaRoot + open.Header().Get(canvasMediaHeader) + "/" + a.ID + "?" + nativePosterQuery
	request("GET", canvas, nil, map[string]string{"If-None-Match": tag}, 401)
	request("GET", canvas, cookie, map[string]string{"If-None-Match": tag}, 304)
	if _, err := f.db.Exec(f.ctx, `DELETE FROM collaboration.project_members WHERE project_id=$1 AND user_id='usr_b'`, nodeLeaseProject); err != nil {
		t.Fatal(err)
	}
	for _, via := range []struct {
		path   string
		cookie *http.Cookie
	}{{path + "&" + nativePosterQuery, nil}, {canvas, cookie}} {
		if w := request("GET", via.path, via.cookie, map[string]string{"If-None-Match": tag}, 404); w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("cached poster bypassed revoked project access")
		}
	}
	sessions.revoked.Store(true)
	request("HEAD", path+"&"+nativePosterQuery, nil, map[string]string{"If-None-Match": tag}, 401)
}
