package http

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/png"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/modules/modelmedia/adapters/storage"
	"studiotv.local/service/api/internal/modules/modelmedia/application"
)

func TestExportLeaseRequiresGrantAndRechecksVisibilityForRangeAndConditionalReads(t *testing.T) {
	root := t.TempDir()
	var content bytes.Buffer
	_ = png.Encode(&content, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	sum := sha256.Sum256(content.Bytes())
	digest := hex.EncodeToString(sum[:])
	_ = os.WriteFile(filepath.Join(root, "asset"), content.Bytes(), 0600)
	secret := filepath.Join(t.TempDir(), "token")
	token := strings.Repeat("m", 40)
	_ = os.WriteFile(secret, []byte(token), 0600)
	g := &grants{a: application.Asset{ID: "asset", StorageKey: "asset", MimeType: "image/png", SHA256: digest, ByteSize: int64(content.Len())}}
	r := chi.NewRouter()
	if err := Register(r, application.New(g, storage.New(root)), secret, ExportConfig{PublicOrigin: "https://media.example.test", SigningSecret: strings.Repeat("s", 40)}); err != nil {
		t.Fatal(err)
	}
	input := application.Request{SubjectRef: "owner", SourceRef: "asset", SourceVersion: "sha256:" + digest, SHA256: digest, ReadGrantRef: "grant"}
	export := func(request application.Request, auth string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(request)
		req := httptest.NewRequest("POST", "/internal/model-assets/export-media", bytes.NewReader(body))
		req.Header.Set("Authorization", auth)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w
	}
	if w := export(input, "Bearer browser-session"); w.Code != 401 || g.calls != 0 {
		t.Fatal("browser session admitted to private export")
	}
	foreign := input
	foreign.SubjectRef = "foreign"
	if w := export(foreign, "Bearer "+token); w.Code != 404 {
		t.Fatal("foreign actor exported a grant")
	}
	w := export(input, "Bearer "+token)
	var lease struct {
		URL       string `json:"url"`
		ExpiresAt string `json:"expiresAt"`
		SHA256    string `json:"sha256"`
		MediaType string `json:"mediaType"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &lease) != nil || lease.SHA256 != digest || lease.MediaType != "image/png" {
		t.Fatal("valid immutable asset did not export")
	}
	u, err := url.Parse(lease.URL)
	if err != nil || u.Scheme != "https" || u.Host != "media.example.test" || u.Path != exportReadPath {
		t.Fatal("export left the configured HTTPS origin")
	}
	expires, err := time.Parse(time.RFC3339, lease.ExpiresAt)
	if err != nil || time.Until(expires) < 59*time.Minute || time.Until(expires) > time.Hour {
		t.Fatal("download lease was not bounded to one hour")
	}
	sealed, _ := base64.RawURLEncoding.DecodeString(u.Query().Get("token"))
	if bytes.Contains(sealed, []byte("owner")) || bytes.Contains(sealed, []byte("readGrantRef")) {
		t.Fatal("internal identity leaked as URL plaintext")
	}
	get := func(method, path string, headers map[string]string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		out := httptest.NewRecorder()
		r.ServeHTTP(out, req)
		return out
	}
	if out := get("GET", u.RequestURI(), nil); out.Code != 200 || !bytes.Equal(out.Body.Bytes(), content.Bytes()) || out.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("valid grant did not return exact original bytes")
	}
	if out := get("GET", u.RequestURI(), map[string]string{"Range": "bytes=0-3"}); out.Code != 206 || !bytes.Equal(out.Body.Bytes(), content.Bytes()[:4]) {
		t.Fatal("provider range download failed")
	}
	if out := get("HEAD", u.RequestURI(), nil); out.Code != 200 || out.Body.Len() != 0 || out.Header().Get("Content-Length") == "" {
		t.Fatal("provider HEAD download failed")
	}
	g.a.ID = "revoked"
	if out := get("GET", u.RequestURI(), map[string]string{"If-None-Match": "*"}); out.Code != 404 || out.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("conditional read bypassed revoked visibility")
	}
	g.a.ID = "asset"
	_ = os.WriteFile(filepath.Join(root, "asset"), []byte("tampered"), 0600)
	if out := get("GET", u.RequestURI(), nil); out.Code != 404 {
		t.Fatal("changed asset content retained download authority")
	}
}

func TestOpaqueExportLeaseBindsOriginKeyExpiryAndPurpose(t *testing.T) {
	cfg := ExportConfig{PublicOrigin: "https://media.example.test", SigningSecret: strings.Repeat("s", 40), TTL: time.Minute}
	exporter, err := newMediaExport(cfg)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	exporter.now = func() time.Time { return now }
	input := application.Request{SubjectRef: "user", SourceRef: "asset", SourceVersion: "sha256:x", SHA256: "x", ReadGrantRef: "task-grant"}
	token, _, err := exporter.seal(input)
	if err != nil {
		t.Fatal(err)
	}
	second, _, _ := exporter.seal(input)
	if second == token {
		t.Fatal("download leases reused a nonce")
	}
	if got, err := exporter.open(token); err != nil || got != input {
		t.Fatal("matching lease did not round trip")
	}
	for _, other := range []ExportConfig{{PublicOrigin: "https://other.example.test", SigningSecret: cfg.SigningSecret}, {PublicOrigin: cfg.PublicOrigin, SigningSecret: strings.Repeat("k", 40)}} {
		wrong, _ := newMediaExport(other)
		if _, err := wrong.open(token); err == nil {
			t.Fatal("another origin/key accepted the lease")
		}
	}
	raw, _ := base64.RawURLEncoding.DecodeString(token)
	raw[len(raw)-1] ^= 1
	if _, err := exporter.open(base64.RawURLEncoding.EncodeToString(raw)); err == nil {
		t.Fatal("tampered ciphertext was accepted")
	}
	exporter.now = func() time.Time { return now.Add(time.Minute) }
	if _, err := exporter.open(token); err == nil {
		t.Fatal("expired lease retained authority")
	}
	local, err := newMediaExport(ExportConfig{PublicOrigin: "http://localhost:18880"})
	if err != nil || local != nil {
		t.Fatal("local HTTP accidentally became an external media export")
	}
	for _, origin := range []string{"https://media.example.test?", "https://media.example.test?x=1", "https://media.example.test/download", "https://user@media.example.test"} {
		if _, err := newMediaExport(ExportConfig{PublicOrigin: origin, SigningSecret: cfg.SigningSecret}); err == nil {
			t.Fatal("noncanonical origin admitted to signed URL construction")
		}
	}
}
