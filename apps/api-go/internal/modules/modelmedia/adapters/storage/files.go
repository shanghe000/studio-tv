package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"studiotv.local/service/api/internal/modules/modelmedia/application"
	"syscall"
)

type Files struct{ root string }

func New(root string) *Files { return &Files{root} }
func (s *Files) Read(ctx context.Context, a application.Asset) ([]byte, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if a.StorageKey == "" || filepath.Base(a.StorageKey) != a.StorageKey || a.StorageKey == "." || a.StorageKey == ".." {
		return nil, application.ErrNotFound
	}
	root, err := os.OpenRoot(s.root)
	if err != nil {
		return nil, application.ErrNotFound
	}
	defer root.Close()
	f, err := root.OpenFile(a.StorageKey, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, application.ErrNotFound
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != a.ByteSize || info.Size() > application.MediaLimit(a.MimeType) {
		return nil, application.ErrNotFound
	}
	data, err := io.ReadAll(io.LimitReader(f, application.MediaLimit(a.MimeType)+1))
	if err != nil {
		return nil, application.ErrNotFound
	}
	sum := sha256.Sum256(data)
	if int64(len(data)) != a.ByteSize || hex.EncodeToString(sum[:]) != a.SHA256 || !sameMediaType(http.DetectContentType(data), a.MimeType) {
		return nil, application.ErrNotFound
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return data, nil
}

func sameMediaType(detected, expected string) bool {
	return detected == expected || expected == "audio/wav" && detected == "audio/wave"
}
