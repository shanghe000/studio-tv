package http

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"image"
	"image/png"
	"net/http/httptest"
	"os"
	"path/filepath"
	"studiotv.local/service/api/internal/modules/modelmedia/adapters/storage"
	"studiotv.local/service/api/internal/modules/modelmedia/application"
	"strings"
	"testing"
)

type grants struct {
	a     application.Asset
	calls int
}

func (g *grants) Resolve(_ context.Context, r application.Request) (application.Asset, error) {
	g.calls++
	if r.SubjectRef != "owner" || r.ReadGrantRef != "grant" || r.SourceRef != g.a.ID {
		return application.Asset{}, application.ErrNotFound
	}
	return g.a, nil
}
func TestInternalMediaUsesIndependentGrantAndVerifiedBytes(t *testing.T) {
	root := t.TempDir()
	var b bytes.Buffer
	_ = png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 1, 1)))
	sum := sha256.Sum256(b.Bytes())
	digest := hex.EncodeToString(sum[:])
	_ = os.WriteFile(filepath.Join(root, "asset"), b.Bytes(), 0600)
	secret := filepath.Join(t.TempDir(), "token")
	token := strings.Repeat("m", 40)
	_ = os.WriteFile(secret, []byte(token), 0600)
	g := &grants{a: application.Asset{ID: "asset", StorageKey: "asset", MimeType: "image/png", SHA256: digest, ByteSize: int64(b.Len())}}
	r := chi.NewRouter()
	if err := Register(r, application.New(g, storage.New(root)), secret); err != nil {
		t.Fatal(err)
	}
	request := application.Request{SubjectRef: "owner", SourceRef: "asset", SourceVersion: "sha256:" + digest, SHA256: digest, ReadGrantRef: "grant"}
	send := func(req application.Request, auth string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(req)
		w := httptest.NewRecorder()
		h := httptest.NewRequest("POST", "/internal/model-assets/read", bytes.NewReader(body))
		h.Header.Set("Authorization", auth)
		r.ServeHTTP(w, h)
		return w
	}
	if w := send(request, "Bearer browser-session"); w.Code != 401 || g.calls != 0 {
		t.Fatal("browser token admitted")
	}
	w := send(request, "Bearer "+token)
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), b.Bytes()) || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("valid image not served")
	}
	foreign := request
	foreign.SubjectRef = "other"
	if send(foreign, "Bearer "+token).Code != 404 {
		t.Fatal("foreign owner admitted")
	}
	stale := request
	stale.SourceVersion = "sha256:stale"
	if send(stale, "Bearer "+token).Code != 404 {
		t.Fatal("stale version admitted")
	}
	_ = os.WriteFile(filepath.Join(root, "asset"), []byte("tampered"), 0600)
	if send(request, "Bearer "+token).Code != 404 {
		t.Fatal("mutated bytes admitted")
	}
	_ = os.Remove(filepath.Join(root, "asset"))
	outside := filepath.Join(t.TempDir(), "secret")
	_ = os.WriteFile(outside, b.Bytes(), 0600)
	_ = os.Symlink(outside, filepath.Join(root, "asset"))
	if send(request, "Bearer "+token).Code != 404 {
		t.Fatal("symlink admitted")
	}
}

func TestOversizedMediaDiagnosticRequiresAuthorizedImmutableGrant(t *testing.T) {
	secret := filepath.Join(t.TempDir(), "token")
	token, digest := strings.Repeat("m", 40), strings.Repeat("a", 64)
	if err := os.WriteFile(secret, []byte(token), 0600); err != nil {
		t.Fatal(err)
	}
	g := &grants{a: application.Asset{ID: "asset", StorageKey: "asset", MimeType: "image/png", SHA256: digest, ByteSize: 12474445}}
	r := chi.NewRouter()
	if err := Register(r, application.New(g, storage.New(t.TempDir())), secret); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		subject, auth string
		status        int
		diagnostic    bool
	}{
		{"owner", "Bearer " + token, 404, true}, {"other", "Bearer " + token, 404, false}, {"owner", "Bearer browser", 401, false},
	} {
		body, _ := json.Marshal(application.Request{SubjectRef: row.subject, SourceRef: "asset", SourceVersion: "sha256:" + digest, SHA256: digest, ReadGrantRef: "grant"})
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/internal/model-assets/read-media", bytes.NewReader(body))
		req.Header.Set("Authorization", row.auth)
		r.ServeHTTP(w, req)
		if w.Code != row.status || (w.Header().Get("X-Media-Rejection-Code") == "MEDIA_SIZE") != row.diagnostic {
			t.Fatal("size diagnostic escaped authorization", w.Code, w.Header())
		}
		if row.diagnostic && (w.Header().Get("X-Media-Byte-Size") != "12474445" || w.Header().Get("X-Media-Max-Bytes") != "10485760") {
			t.Fatal("exact safe size facts lost", w.Header())
		}
	}
}
