package http

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"github.com/go-chi/chi/v5"
	"io"
	"net/http"
	"os"
	"studiotv.local/service/api/internal/modules/modelmedia/application"
	"strconv"
	"strings"
)

func Register(r chi.Router, s *application.Reader, tokenFile string, exports ...ExportConfig) error {
	if len(exports) > 1 {
		return errors.New("one model media export configuration is permitted")
	}
	var token string
	if tokenFile != "" {
		f, err := os.Open(tokenFile)
		if err != nil {
			return errors.New("model media service secret unavailable")
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil || !info.Mode().IsRegular() || info.Size() > 8192 {
			return errors.New("invalid model media service secret")
		}
		raw, err := io.ReadAll(io.LimitReader(f, 8193))
		if err != nil {
			return errors.New("model media service secret unavailable")
		}
		token = strings.TrimRight(string(raw), "\r\n")
		if len(token) < 32 || strings.ContainsAny(token, " \t\r\n") {
			return errors.New("invalid model media service secret")
		}
	}
	expected := sha256.Sum256([]byte("Bearer " + token))
	handler := func(multimodal bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			if token == "" {
				w.WriteHeader(503)
				return
			}
			given := sha256.Sum256([]byte(r.Header.Get("Authorization")))
			if len(r.Header.Values("Authorization")) != 1 || subtle.ConstantTimeCompare(given[:], expected[:]) != 1 {
				w.WriteHeader(401)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 8192)
			dec := json.NewDecoder(r.Body)
			dec.DisallowUnknownFields()
			var req application.Request
			if dec.Decode(&req) != nil || dec.Decode(new(any)) != io.EOF {
				w.WriteHeader(404)
				return
			}
			body, asset, err := s.ReadMedia(r.Context(), req, multimodal)
			if err != nil {
				var size *application.SizeError
				if errors.As(err, &size) {
					w.Header().Set("X-Media-Rejection-Code", "MEDIA_SIZE")
					w.Header().Set("X-Media-Byte-Size", strconv.FormatInt(size.Actual, 10))
					w.Header().Set("X-Media-Max-Bytes", strconv.FormatInt(size.Maximum, 10))
				}
				if errors.Is(err, application.ErrNotFound) {
					w.WriteHeader(404)
				} else {
					w.WriteHeader(503)
				}
				return
			}
			w.Header().Set("Content-Type", asset.MimeType)
			if asset.Width != nil {
				w.Header().Set("X-Media-Width", strconv.Itoa(*asset.Width))
			}
			if asset.Height != nil {
				w.Header().Set("X-Media-Height", strconv.Itoa(*asset.Height))
			}
			if asset.DurationMs != nil {
				w.Header().Set("X-Media-Duration-Ms", strconv.FormatInt(*asset.DurationMs, 10))
			}
			w.WriteHeader(200)
			_, _ = w.Write(body)
		}
	}
	r.Post("/internal/model-assets/read", handler(false))
	r.Post("/internal/model-assets/read-media", handler(true))
	if len(exports) == 1 {
		if err := registerMediaExport(r, s, exports[0], func(r *http.Request) bool {
			given := sha256.Sum256([]byte(r.Header.Get("Authorization")))
			return token != "" && len(r.Header.Values("Authorization")) == 1 && subtle.ConstantTimeCompare(given[:], expected[:]) == 1
		}); err != nil {
			return err
		}
	}
	return nil
}
