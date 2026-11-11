package observability

// File logging uses the same engines and daily-link/90-day retention convention
// as g004_biz's framework/v3/log. The slog boundary preserves existing callers
// and redaction; private game-server config/uctx globals are not imported.
import (
	"encoding/json"
	"errors"
	rotatelogs "github.com/lestrrat-go/file-rotatelogs"
	"github.com/sirupsen/logrus"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type frameworkFiles struct {
	inner, event *logrus.Logger
	writers      []*rotatelogs.RotateLogs
	once         sync.Once
}

func newFrameworkFiles(dir string) (*frameworkFiles, error) {
	if !filepath.IsAbs(dir) {
		return nil, errors.New("log directory must be absolute")
	}
	if err := os.MkdirAll(dir, 0750); err != nil {
		return nil, errors.New("cannot create log directory")
	}
	f := &frameworkFiles{}
	for _, name := range []string{"api.log", "generation.log"} {
		path := filepath.Join(dir, name)
		w, err := rotatelogs.New(path+".%Y%m%d", rotatelogs.WithLinkName(path), rotatelogs.WithMaxAge(90*24*time.Hour), rotatelogs.WithRotationTime(24*time.Hour))
		if err != nil {
			f.Close()
			return nil, errors.New("cannot initialize rotating logs")
		}
		// Fail startup on an unwritable mount, rather than silently losing logs.
		if _, err = w.Write(nil); err != nil {
			w.Close()
			f.Close()
			return nil, errors.New("cannot write rotating logs")
		}
		l := logrus.New()
		l.SetOutput(w)
		l.SetLevel(logrus.DebugLevel)
		l.SetFormatter(&logrus.JSONFormatter{TimestampFormat: time.RFC3339Nano})
		f.writers = append(f.writers, w)
		if f.inner == nil {
			f.inner = l
		} else {
			f.event = l
		}
	}
	return f, nil
}
func (f *frameworkFiles) Write(p []byte) (int, error) {
	var record map[string]any
	if json.Unmarshal(p, &record) != nil {
		return 0, errors.New("invalid structured log record")
	}
	msg, _ := record["msg"].(string)
	level, _ := record["level"].(string)
	delete(record, "msg")
	delete(record, "level")
	delete(record, "time")
	lv, err := logrus.ParseLevel(strings.ToLower(level))
	if err != nil {
		lv = logrus.InfoLevel
	}
	f.inner.WithFields(logrus.Fields(record)).Log(lv, msg)
	if strings.HasPrefix(msg, "generation ") {
		f.event.WithFields(logrus.Fields(record)).Log(lv, msg)
	}
	return len(p), nil
}
func (f *frameworkFiles) Close() error {
	var err error
	f.once.Do(func() {
		for _, w := range f.writers {
			err = errors.Join(err, w.Close())
		}
	})
	return err
}

var _ io.WriteCloser = (*frameworkFiles)(nil)
