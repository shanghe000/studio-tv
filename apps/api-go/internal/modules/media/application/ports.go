package application

import (
	"context"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/media/domain"
)

type InputAsset struct {
	execution.Asset
	Path         string
	ByteSize     int64
	TestMode     bool
	FixtureLabel string
}
type InputPort interface {
	Read(context.Context, string, []string) ([]InputAsset, error)
}
type Result struct {
	Content  []byte
	MimeType string
	Kind     string
}
type Engine interface {
	Execute(context.Context, domain.Spec, []InputAsset) (Result, error)
}
type URLPort interface {
	URL(context.Context, string, string, string) (string, error)
}
