package core

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"time"

	"studiotv.local/service/api/internal/httpapi"
)

const previewCacheBytes = 32 << 20

type cachedPreview struct {
	key   string
	image []byte
}
type canvasPreviewCache struct {
	mu    sync.Mutex
	items []cachedPreview
	bytes int
	slots chan struct{}
}

func (c *canvasPreviewCache) lookup(key string) ([]byte, chan struct{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.slots == nil {
		c.slots = make(chan struct{}, 2)
	}
	for i, v := range c.items {
		if v.key == key {
			copy(c.items[i:], c.items[i+1:])
			c.items[len(c.items)-1] = v
			return v.image, c.slots
		}
	}
	return nil, c.slots
}
func (c *canvasPreviewCache) remember(key string, b []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, v := range c.items {
		if v.key == key {
			return
		}
	}
	for len(c.items) > 0 && (c.bytes+len(b) > previewCacheBytes || len(c.items) >= 128) {
		c.bytes -= len(c.items[0].image)
		c.items[0] = cachedPreview{}
		c.items = c.items[1:]
	}
	c.items = append(c.items, cachedPreview{key, b})
	c.bytes += len(b)
}

// Animated PNG must keep all its frames. Inspect only headers, without
// decoding pixel data or advancing the original file's read cursor.
func staticCanvasPNG(file *os.File) bool {
	var header [8]byte
	if _, err := file.ReadAt(header[:], 0); err != nil || !bytes.Equal(header[:], []byte("\x89PNG\r\n\x1a\n")) {
		return false
	}
	offset := int64(8)
	for i := 0; i < 128; i++ {
		if _, err := file.ReadAt(header[:], offset); err != nil {
			return false
		}
		switch string(header[4:]) {
		case "acTL", "iCCP", "eXIf":
			return false
		case "IDAT":
			return true
		}
		offset += int64(binary.BigEndian.Uint32(header[:4])) + 12
	}
	return false
}

// The caller has already verified the user's grant, READY state and backing
// file before entering this path (including conditional requests).
func (s *Server) serveCanvasPreview(w http.ResponseWriter, r *http.Request, a Asset, file *os.File) (bool, error) {
	values := r.URL.Query()["previewWidth"]
	if len(values) != 1 {
		return false, httpapi.Fail(400, "INVALID_PREVIEW_WIDTH", "预览宽度无效。")
	}
	width, err := strconv.Atoi(values[0])
	switch width {
	case 256, 384, 512, 720, 1440, 2560:
	default:
		return false, httpapi.Fail(400, "INVALID_PREVIEW_WIDTH", "预览宽度无效。")
	}
	if err != nil || strconv.Itoa(width) != values[0] {
		return false, httpapi.Fail(400, "INVALID_PREVIEW_WIDTH", "预览宽度无效。")
	}
	if a.Kind != "IMAGE" || (a.MimeType != "image/png" && a.MimeType != "image/jpeg") || a.Width == nil || a.Height == nil || *a.Width <= width || *a.Height <= 0 || a.ByteSize > 40<<20 || int64(*a.Width)*int64(*a.Height) > 24000000 {
		return false, nil
	}
	if a.MimeType == "image/png" && !staticCanvasPNG(file) {
		return false, nil
	}
	key := a.ID + "-" + a.Checksum + "-preview-v1-" + values[0]
	data, slots := s.canvasPreviews.lookup(key)
	if data == nil {
		ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
		defer cancel()
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		case <-ctx.Done():
			return false, r.Context().Err()
		}
		data, _ = s.canvasPreviews.lookup(key)
		if data == nil {
			// Bounded subprocess concurrency/memory surface. Refuse unsupported or
			// oversized derivatives and serve the normal immutable bytes on failure.
			input := "png_pipe"
			if a.MimeType == "image/jpeg" {
				input = "jpeg_pipe"
			}
			cmd := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "pipe", "-max_pixels", "24000000", "-threads", "1", "-f", input, "-i", "pipe:0", "-frames:v", "1", "-filter_threads", "1", "-vf", fmt.Sprintf("scale=w='min(iw,%d)':h='min(ih,2560)':force_original_aspect_ratio=decrease:flags=area", width), "-map_metadata", "-1", "-threads", "1", "-c:v", "libwebp", "-quality", "85", "-compression_level", "3", "-f", "webp", "pipe:1")
			cmd.Stdin = io.NewSectionReader(file, 0, a.ByteSize)
			out := &boundedBuffer{limit: 2 << 20}
			cmd.Stdout = out
			if err := cmd.Run(); err != nil || out.Len() == 0 || int64(out.Len()) >= a.ByteSize {
				return false, r.Context().Err()
			}
			data = out.Bytes()
			s.canvasPreviews.remember(key, data)
		}
	}
	etag := "\"" + key + "\""
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "private, no-cache, must-revalidate")
	if assetETagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return true, nil
	}
	w.Header().Set("Content-Type", "image/webp")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, err = w.Write(data)
	}
	return true, err
}
