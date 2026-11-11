package http

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/modules/modelmedia/application"
)

const exportPurpose = "studio/model-media-export/v1"
const exportReadPath = "/storage/model-media/export"

// ExportConfig supplies the already configured product origin and signing
// secret. A separate, domain-derived AEAD key keeps download leases opaque to
// providers: user, task grant and asset identities are never URL plaintext.
type ExportConfig struct {
	PublicOrigin  string
	SigningSecret string
	TTL           time.Duration
}

type mediaExport struct {
	origin string
	ttl    time.Duration
	aead   cipher.AEAD
	now    func() time.Time
}

type exportLease struct {
	Request   application.Request `json:"request"`
	IssuedAt  int64               `json:"issuedAt"`
	ExpiresAt int64               `json:"expiresAt"`
}

func newMediaExport(cfg ExportConfig) (*mediaExport, error) {
	origin, err := url.Parse(cfg.PublicOrigin)
	if err != nil || origin.Host == "" || origin.User != nil || origin.Path != "" || origin.ForceQuery || origin.RawQuery != "" || origin.Fragment != "" || strings.ContainsAny(cfg.PublicOrigin, "\x00\r\n") {
		return nil, errors.New("model media export requires a canonical public origin")
	}
	// Local development may use HTTP for the application, but such URLs cannot
	// become third-party download grants. Existing local features stay usable.
	if origin.Scheme == "http" {
		return nil, nil
	}
	if origin.Scheme != "https" || len(cfg.SigningSecret) < 32 {
		return nil, errors.New("model media export configuration is invalid")
	}
	if cfg.TTL == 0 {
		cfg.TTL = time.Hour
	}
	if cfg.TTL < time.Minute || cfg.TTL > time.Hour {
		return nil, errors.New("model media export lifetime is invalid")
	}
	kdf := hmac.New(sha256.New, []byte(cfg.SigningSecret))
	_, _ = kdf.Write([]byte(exportPurpose + "/aes-gcm-key"))
	block, err := aes.NewCipher(kdf.Sum(nil))
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &mediaExport{origin: cfg.PublicOrigin, ttl: cfg.TTL, aead: aead, now: time.Now}, nil
}

func (e *mediaExport) seal(req application.Request) (string, time.Time, error) {
	now := e.now().UTC()
	expires := now.Add(e.ttl)
	body, err := json.Marshal(exportLease{Request: req, IssuedAt: now.Unix(), ExpiresAt: expires.Unix()})
	if err != nil || len(body) > 8192 {
		return "", time.Time{}, application.ErrNotFound
	}
	nonce := make([]byte, e.aead.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return "", time.Time{}, err
	}
	sealed := e.aead.Seal(nonce, nonce, body, []byte(exportPurpose+"\x00"+e.origin))
	return base64.RawURLEncoding.EncodeToString(sealed), expires, nil
}

func (e *mediaExport) open(raw string) (application.Request, error) {
	var empty application.Request
	if len(raw) < 64 || len(raw) > 12000 {
		return empty, application.ErrNotFound
	}
	sealed, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(sealed) < e.aead.NonceSize()+e.aead.Overhead() {
		return empty, application.ErrNotFound
	}
	nonce := sealed[:e.aead.NonceSize()]
	plain, err := e.aead.Open(nil, nonce, sealed[e.aead.NonceSize():], []byte(exportPurpose+"\x00"+e.origin))
	if err != nil {
		return empty, application.ErrNotFound
	}
	var lease exportLease
	decoder := json.NewDecoder(bytes.NewReader(plain))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&lease) != nil || decoder.Decode(new(any)) != io.EOF {
		return empty, application.ErrNotFound
	}
	now := e.now().Unix()
	if lease.IssuedAt > now+2 || lease.ExpiresAt <= now || lease.ExpiresAt <= lease.IssuedAt || lease.ExpiresAt-lease.IssuedAt > int64(time.Hour/time.Second) {
		return empty, application.ErrNotFound
	}
	return lease.Request, nil
}

func registerMediaExport(r chi.Router, reader *application.Reader, cfg ExportConfig, authorized func(*http.Request) bool) error {
	exporter, err := newMediaExport(cfg)
	if err != nil {
		return err
	}
	headers := func(w http.ResponseWriter) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
	}
	r.Post("/internal/model-assets/export-media", func(w http.ResponseWriter, req *http.Request) {
		headers(w)
		if !authorized(req) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if exporter == nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		req.Body = http.MaxBytesReader(w, req.Body, 8192)
		decoder := json.NewDecoder(req.Body)
		decoder.DisallowUnknownFields()
		var input application.Request
		if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, asset, err := reader.ReadMedia(req.Context(), input, true)
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		token, expiry, err := exporter.seal(input)
		if err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"url":       exporter.origin + exportReadPath + "?token=" + url.QueryEscape(token),
			"expiresAt": expiry.Format(time.RFC3339), "mediaType": asset.MimeType,
			"sizeBytes": asset.ByteSize, "sha256": asset.SHA256,
			"width": asset.Width, "height": asset.Height, "durationMs": asset.DurationMs,
		})
	})
	read := func(w http.ResponseWriter, req *http.Request) {
		headers(w)
		if exporter == nil || len(req.URL.Query()) != 1 || len(req.URL.Query()["token"]) != 1 {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		input, err := exporter.open(req.URL.Query().Get("token"))
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		// Recheck task/actor grants, current project visibility, expiry, immutable
		// digest and file bytes on every GET/HEAD, even conditional/range reads.
		body, asset, err := reader.ReadMedia(req.Context(), input, true)
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", asset.MimeType)
		w.Header().Set("Content-Disposition", "inline")
		w.Header().Set("ETag", `"`+asset.SHA256+`"`)
		http.ServeContent(w, req, asset.ID, time.Time{}, bytes.NewReader(body))
	}
	r.Get(exportReadPath, read)
	r.Head(exportReadPath, read)
	return nil
}
