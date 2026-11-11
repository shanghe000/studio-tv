package core

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image/jpeg"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"studiotv.local/service/api/internal/httpapi"
)

type videoPreviewOptions struct{ width, height, quality int }

// This is the native first-frame poster vocabulary, not a general transcoder.
// time is deliberately limited to the zero offset used by native Oo(). The
// source remains a seekable local file, including MP4 with its index at EOF.
func videoPreviewQuery(query url.Values) (videoPreviewOptions, error) {
	options := videoPreviewOptions{width: 512, height: 2560, quality: 72}
	invalid := func() (videoPreviewOptions, error) {
		return options, httpapi.Fail(400, "INVALID_VIDEO_PREVIEW", "视频封面参数无效。")
	}
	for key, allowed := range map[string]map[string]bool{
		"ci-process": {"snapshot": true}, "time": {"0": true}, "format": {"jpg": true},
		"minisize": {"0": true, "1": true}, "strip": {"0": true, "1": true},
	} {
		values, present := query[key]
		if !present && key != "ci-process" {
			continue
		}
		if len(values) != 1 || !allowed[values[0]] {
			return invalid()
		}
	}
	for _, option := range []struct {
		key string
		max int
		out *int
	}{{"width", 2560, &options.width}, {"height", 2560, &options.height}, {"quality", 100, &options.quality}} {
		if values, ok := query[option.key]; ok {
			if len(values) != 1 {
				return invalid()
			}
			n, err := strconv.Atoi(values[0])
			if err != nil || n < 1 || n > option.max || strconv.Itoa(n) != values[0] {
				return invalid()
			}
			*option.out = n
		}
	}
	if query.Has("previewWidth") {
		return invalid()
	}
	return options, nil
}

// serveAssetBytes verifies live authorization, READY state and the immutable
// file before this method is called, even when a poster is already cached.
func (s *Server) serveVideoPreview(w http.ResponseWriter, r *http.Request, a Asset, file *os.File) error {
	options, err := videoPreviewQuery(r.URL.Query())
	if err != nil {
		return err
	}
	input := map[string]string{"video/mp4": "mov", "video/quicktime": "mov", "video/webm": "matroska"}[a.MimeType]
	if a.Kind != "VIDEO" || input == "" {
		return httpapi.Fail(422, "VIDEO_PREVIEW_UNSUPPORTED", "此素材不支持视频封面。")
	}
	// Longform imports are bounded to 1 GiB. Duration does not increase the
	// work: decode one frame from a seekable local descriptor, not a file pipe.
	if a.ByteSize > 1<<30 || a.Width == nil || a.Height == nil || *a.Width < 1 || *a.Height < 1 || *a.Width > 8192 || *a.Height > 8192 || int64(*a.Width)*int64(*a.Height) > 24000000 {
		return httpapi.Fail(422, "VIDEO_PREVIEW_UNSUPPORTED", "视频尺寸超过封面处理范围。")
	}
	key := fmt.Sprintf("%s-%s-video-poster-v1-%dx%d-q%d", a.ID, a.Checksum, options.width, options.height, options.quality)
	data, slots := s.canvasPreviews.lookup(key)
	if data == nil {
		ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
		defer cancel()
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		case <-ctx.Done():
			if r.Context().Err() != nil {
				return r.Context().Err()
			}
			return httpapi.Retry(503, "VIDEO_PREVIEW_TIMEOUT", "视频封面暂未生成，请稍后重试。")
		}
		data, _ = s.canvasPreviews.lookup(key)
		if data == nil {
			// Restrict protocols/demuxers and allocations. Passing the already-open
			// descriptor retains seekability without reopening a user-selected path.
			args := []string{"-nostdin", "-v", "error", "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe", "-threads", "1", "-max_pixels", "24000000", "-f", input}
			if input == "mov" {
				args = append(args, "-enable_drefs", "0", "-use_absolute_path", "0")
			}
			args = append(args, "-i", "/dev/fd/3", "-map", "0:V:0", "-an", "-sn", "-dn", "-frames:v", "1", "-filter_threads", "1", "-vf", fmt.Sprintf("scale=w='min(iw,%d)':h='min(ih,%d)':force_original_aspect_ratio=decrease:flags=area,setsar=1", options.width, options.height), "-map_metadata", "-1", "-threads", "1", "-c:v", "mjpeg", "-q:v", strconv.Itoa(2+(100-options.quality)*29/99), "-f", "image2pipe", "pipe:1")
			cmd := exec.CommandContext(ctx, "ffmpeg", args...)
			cmd.ExtraFiles = []*os.File{file}
			cmd.WaitDelay = time.Second
			out := &boundedBuffer{limit: 2 << 20}
			cmd.Stdout = out
			if err = cmd.Run(); err != nil {
				if r.Context().Err() != nil {
					return r.Context().Err()
				}
				if ctx.Err() != nil {
					return httpapi.Retry(503, "VIDEO_PREVIEW_TIMEOUT", "视频封面暂未生成，请稍后重试。")
				}
				if errors.Is(err, exec.ErrNotFound) {
					return httpapi.Retry(503, "VIDEO_PREVIEW_UNAVAILABLE", "视频封面服务暂不可用。")
				}
				return httpapi.Fail(422, "VIDEO_PREVIEW_FAILED", "无法读取此视频的封面。")
			}
			shape, decodeErr := jpeg.DecodeConfig(bytes.NewReader(out.Bytes()))
			if decodeErr != nil || shape.Width < 1 || shape.Height < 1 || shape.Width > options.width || shape.Height > options.height {
				return httpapi.Fail(422, "VIDEO_PREVIEW_FAILED", "无法读取此视频的封面。")
			}
			data = out.Bytes()
			s.canvasPreviews.remember(key, data)
		}
	}
	etag := "\"" + key + "\""
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "private, no-cache, must-revalidate")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if assetETagMatches(strings.Join(r.Header.Values("If-None-Match"), ","), etag) {
		w.WriteHeader(http.StatusNotModified)
		return nil
	}
	// Byte ranges apply to original playback/download only. The small derived
	// representation is always returned as one complete JPEG, including posters.
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, err = w.Write(data)
	}
	return err
}
