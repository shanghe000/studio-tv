package core

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"studiotv.local/service/api/internal/config"
	"testing"
	"time"
)

func TestCanvasDisplayDerivativeKeepsSourceAndCanonicalDimensions(t *testing.T) {
	ffmpeg, e := exec.LookPath("ffmpeg")
	if e != nil {
		t.Skip("requires ffmpeg")
	}
	src := image.NewNRGBA(image.Rect(0, 0, 1024, 512))
	for i := range src.Pix {
		src.Pix[i] = byte(i*91 + i/407)
		if i%4 == 3 {
			src.Pix[i] = 255
		}
	}
	var original bytes.Buffer
	if e := png.Encode(&original, src); e != nil {
		t.Fatal(e)
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "image")
	if e := os.WriteFile(file, original.Bytes(), 0600); e != nil {
		t.Fatal(e)
	}
	w, h := 1024, 512
	a := Asset{ID: "image", Kind: "IMAGE", State: "READY", MimeType: "image/png", Width: &w, Height: &h, ByteSize: int64(original.Len()), Checksum: fmt.Sprintf("%x", sha256.Sum256(original.Bytes()))}
	srv := Server{cfg: config.Config{StorageRoot: dir}}
	serve := func(path, tag string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest("GET", path, nil)
		if tag != "" {
			req.Header.Set("If-None-Match", tag)
		}
		out := httptest.NewRecorder()
		if e := srv.serveAssetBytes(out, req, a); e != nil {
			t.Fatal(e)
		}
		return out
	}
	path := canvasMediaRoot + "scope/image"
	preview := serve(path+"?previewWidth=256", "")
	if preview.Code != 200 || preview.Header().Get("Content-Type") != "image/webp" || preview.Body.Len() >= original.Len() {
		t.Fatalf("preview %d %s %d/%d", preview.Code, preview.Header().Get("Content-Type"), preview.Body.Len(), original.Len())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ffmpeg, "-v", "error", "-i", "pipe:0", "-frames:v", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1")
	cmd.Stdin = bytes.NewReader(preview.Body.Bytes())
	decoded, e := cmd.Output()
	if e != nil {
		t.Fatal(e)
	}
	size, e := png.DecodeConfig(bytes.NewReader(decoded))
	if e != nil || size.Width != 256 || size.Height != 128 {
		t.Fatalf("preview dimensions %#v %v", size, e)
	}
	if originalView := serve(path, preview.Header().Get("ETag")); originalView.Code != 200 || !bytes.Equal(originalView.Body.Bytes(), original.Bytes()) {
		t.Fatal("source/downloading changed")
	}
	if serve(path+"?previewWidth=256", preview.Header().Get("ETag")).Code != http.StatusNotModified {
		t.Fatal("variant failed to revalidate")
	}
	a.State = "REJECTED"
	rec := httptest.NewRecorder()
	if e := srv.serveAssetBytes(rec, httptest.NewRequest("GET", path+"?previewWidth=256", nil), a); e == nil {
		t.Fatal("cached image bypassed ready gate")
	}
}
func TestCanvasDisplaySkipsAnimatedPNG(t *testing.T) {
	f, e := os.CreateTemp(t.TempDir(), "animated.png")
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	header := []byte("\x89PNG\r\n\x1a\n")
	chunk := make([]byte, 20)
	binary.BigEndian.PutUint32(chunk, 8)
	copy(chunk[4:], "acTL")
	if _, e := f.Write(append(header, chunk...)); e != nil {
		t.Fatal(e)
	}
	if staticCanvasPNG(f) {
		t.Fatal("animation reduced to a single still")
	}
}
