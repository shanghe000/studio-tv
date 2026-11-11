package observability

import (
	"bufio"
	"io"
	"net"
	"net/http"
)

type responseRecorder struct {
	writer              http.ResponseWriter
	status              int
	bytes               int64
	committed, hijacked bool
	connection          net.Conn
}

func (r *responseRecorder) Header() http.Header         { return r.writer.Header() }
func (r *responseRecorder) Unwrap() http.ResponseWriter { return r.writer }
func (r *responseRecorder) WriteHeader(status int) {
	if r.committed || r.hijacked {
		return
	}
	if status >= 100 && status < 200 && status != http.StatusSwitchingProtocols {
		r.writer.WriteHeader(status)
		return
	}
	r.writer.WriteHeader(status)
	r.status = status
	r.committed = true
}
func (r *responseRecorder) Write(body []byte) (int, error) {
	if !r.committed && !r.hijacked {
		r.WriteHeader(http.StatusOK)
	}
	n, err := r.writer.Write(body)
	r.bytes += int64(n)
	return n, err
}
func (r *responseRecorder) ReadFrom(reader io.Reader) (int64, error) {
	if !r.committed && !r.hijacked {
		r.WriteHeader(http.StatusOK)
	}
	if optimized, ok := r.writer.(io.ReaderFrom); ok {
		n, err := optimized.ReadFrom(reader)
		r.bytes += n
		return n, err
	}
	return io.Copy(struct{ io.Writer }{r}, reader)
}

func (r *responseRecorder) FlushError() error {
	err := http.NewResponseController(r.writer).Flush()
	if err == nil && !r.committed && !r.hijacked {
		r.status = http.StatusOK
		r.committed = true
	}
	return err
}

type flushCapability struct{ recorder *responseRecorder }

func (f flushCapability) Flush() {
	_ = f.recorder.FlushError()
}

type hijackCapability struct{ recorder *responseRecorder }

func (h hijackCapability) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	connection, buffer, err := h.recorder.writer.(http.Hijacker).Hijack()
	if err == nil {
		h.recorder.hijacked = true
		h.recorder.connection = connection
		if h.recorder.status == 0 {
			h.recorder.status = http.StatusSwitchingProtocols
		}
	}
	return connection, buffer, err
}

type pushCapability struct{ recorder *responseRecorder }

func (p pushCapability) Push(target string, options *http.PushOptions) error {
	return p.recorder.writer.(http.Pusher).Push(target, options)
}

// Optional interfaces are advertised only when the underlying writer supports
// them. Unwrap also preserves ResponseController deadlines/full-duplex behavior.
func recordResponse(writer http.ResponseWriter) (*responseRecorder, http.ResponseWriter) {
	r := &responseRecorder{writer: writer}
	_, flush := writer.(http.Flusher)
	_, hijack := writer.(http.Hijacker)
	_, push := writer.(http.Pusher)
	f, h, p := flushCapability{r}, hijackCapability{r}, pushCapability{r}
	switch {
	case flush && hijack && push:
		return r, struct {
			*responseRecorder
			http.Flusher
			http.Hijacker
			http.Pusher
		}{r, f, h, p}
	case flush && hijack:
		return r, struct {
			*responseRecorder
			http.Flusher
			http.Hijacker
		}{r, f, h}
	case flush && push:
		return r, struct {
			*responseRecorder
			http.Flusher
			http.Pusher
		}{r, f, p}
	case hijack && push:
		return r, struct {
			*responseRecorder
			http.Hijacker
			http.Pusher
		}{r, h, p}
	case flush:
		return r, struct {
			*responseRecorder
			http.Flusher
		}{r, f}
	case hijack:
		return r, struct {
			*responseRecorder
			http.Hijacker
		}{r, h}
	case push:
		return r, struct {
			*responseRecorder
			http.Pusher
		}{r, p}
	default:
		return r, r
	}
}
