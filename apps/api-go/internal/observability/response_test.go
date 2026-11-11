package observability

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestSSEFlushIsImmediateAndCommittedPanicAbortsStream(t *testing.T) {
	for _, panics := range []bool{false, true} {
		t.Run(map[bool]string{false: "normal-stream", true: "panic-after-flush"}[panics], func(t *testing.T) {
			endpoint, notification, calls := fakeWebhook(t)
			o, output := testObserver(t, Config{WebhookURL: endpoint})
			release := make(chan struct{})
			defer func() {
				select {
				case <-release:
				default:
					close(release)
				}
			}()
			router := chi.NewRouter()
			router.Use(o.Middleware)
			router.Get("/events/{taskID}", func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, "data: first\n\n")
				if err := http.NewResponseController(w).Flush(); err != nil {
					panic(err)
				}
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
				if panics {
					panic("PRIVATE_SSE_PANIC")
				}
				_, _ = io.WriteString(w, "data: second\n\n")
			})
			server := httptest.NewServer(router)
			t.Cleanup(server.Close)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			request, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/events/PRIVATE_TASK", nil)
			response, err := server.Client().Do(request)
			if err != nil {
				t.Fatal("flushed headers did not reach client", err)
			}
			defer response.Body.Close()
			reader := bufio.NewReader(response.Body)
			first, err := reader.ReadString('\n')
			if err != nil || first != "data: first\n" {
				t.Fatal("SSE event buffered until handler completion")
			}
			separator, err := reader.ReadString('\n')
			if err != nil || separator != "\n" {
				t.Fatal("SSE frame was changed")
			}
			close(release)
			remainder, readErr := io.ReadAll(reader)
			waitFor(t, func() bool { return len(requestLogs(t, output)) == 1 })
			closeObserver(t, o)
			if response.StatusCode != 200 {
				t.Fatal("committed status was falsified")
			}
			if panics {
				if !errors.Is(readErr, io.ErrUnexpectedEOF) || len(remainder) != 0 {
					t.Fatal("truncated SSE looked complete or had appended JSON", readErr, string(remainder))
				}
				if calls.Load() != 1 || !strings.Contains(notification.String(), "PANIC_RECOVERED") {
					t.Fatal("stream panic was not notified")
				}
			} else if readErr != nil || string(remainder) != "data: second\n\n" || calls.Load() != 0 {
				t.Fatal("normal SSE was changed", readErr)
			}
			if strings.Contains(output.String(), "PRIVATE") || strings.Contains(notification.String(), "PRIVATE") {
				t.Fatal("SSE panic/path leaked")
			}
			row := requestLogs(t, output)[0]
			if row["route"] != "/events/{taskID}" || row["panic"] != panics || row["status"] != float64(200) {
				t.Fatal("SSE request metadata incorrect")
			}
		})
	}
}

type minimalWriter struct {
	header   http.Header
	statuses []int
	body     bytes.Buffer
	deadline time.Time
}

func (w *minimalWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}
func (w *minimalWriter) WriteHeader(status int)                    { w.statuses = append(w.statuses, status) }
func (w *minimalWriter) Write(body []byte) (int, error)            { return w.body.Write(body) }
func (w *minimalWriter) SetWriteDeadline(deadline time.Time) error { w.deadline = deadline; return nil }

func TestRecorderPreservesOptionalInterfacesAndResponseController(t *testing.T) {
	base := &minimalWriter{}
	_, writer := recordResponse(base)
	if _, ok := writer.(http.Flusher); ok {
		t.Fatal("unsupported flush capability was advertised")
	}
	if _, ok := writer.(http.Hijacker); ok {
		t.Fatal("unsupported hijack capability was advertised")
	}
	if _, ok := writer.(http.Pusher); ok {
		t.Fatal("unsupported push capability was advertised")
	}
	if err := http.NewResponseController(writer).Flush(); !errors.Is(err, http.ErrNotSupported) {
		t.Fatal("unsupported flush semantics changed")
	}
	deadline := time.Now().Add(time.Minute)
	if err := http.NewResponseController(writer).SetWriteDeadline(deadline); err != nil || !base.deadline.Equal(deadline) {
		t.Fatal("ResponseController could not unwrap deadlines")
	}

	capable := &capableWriter{minimalWriter: &minimalWriter{}}
	recorder, writer := recordResponse(capable)
	if _, ok := writer.(http.Flusher); !ok {
		t.Fatal("Flusher lost")
	}
	if _, ok := writer.(http.Hijacker); !ok {
		t.Fatal("Hijacker lost")
	}
	if _, ok := writer.(http.Pusher); !ok {
		t.Fatal("Pusher lost")
	}
	if err := http.NewResponseController(writer).Flush(); err != nil || capable.flushes != 1 || !recorder.committed || recorder.status != 200 {
		t.Fatal("flush status/forwarding incorrect")
	}
	if err := writer.(http.Pusher).Push("/asset", nil); err != nil || capable.pushed != "/asset" {
		t.Fatal("Push not forwarded")
	}
}

type capableWriter struct {
	*minimalWriter
	flushes    int
	pushed     string
	connection net.Conn
}

func (w *capableWriter) Flush()                                        { w.flushes++ }
func (w *capableWriter) Push(target string, _ *http.PushOptions) error { w.pushed = target; return nil }
func (w *capableWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return w.connection, bufio.NewReadWriter(bufio.NewReader(w.connection), bufio.NewWriter(w.connection)), nil
}

func TestPanicClosesHijackedConnectionWithoutLeakingValue(t *testing.T) {
	endpoint, notification, calls := fakeWebhook(t)
	o, output := testObserver(t, Config{WebhookURL: endpoint})
	connection, peer := net.Pipe()
	defer connection.Close()
	defer peer.Close()
	writer := &capableWriter{minimalWriter: &minimalWriter{}, connection: connection}
	handler := o.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, _, err := w.(http.Hijacker).Hijack(); err != nil {
			t.Fatal(err)
		}
		panic("PRIVATE_HIJACK_PANIC")
	}))
	handler.ServeHTTP(writer, httptest.NewRequest("GET", "/socket", nil))
	_ = peer.SetReadDeadline(time.Now().Add(time.Second))
	if n, err := peer.Read(make([]byte, 1)); n != 0 || !errors.Is(err, io.EOF) {
		t.Fatal("panicked hijacked connection stayed open")
	}
	closeObserver(t, o)
	rows := requestLogs(t, output)
	if calls.Load() != 1 || rows[0]["status"] != float64(101) || rows[0]["panic"] != true || writer.body.Len() != 0 {
		t.Fatal("hijacked panic metadata/response incorrect")
	}
	if strings.Contains(output.String(), "PRIVATE") || strings.Contains(notification.String(), "PRIVATE") {
		t.Fatal("hijacked panic value leaked")
	}
}

type readerFromWriter struct {
	*minimalWriter
	readerFromCalls int
}

func (w *readerFromWriter) ReadFrom(r io.Reader) (int64, error) {
	w.readerFromCalls++
	return w.body.ReadFrom(r)
}

type onlyReader struct{ io.Reader }

func TestRecorderCountsInformationalFinalAndReaderFromBytes(t *testing.T) {
	base := &minimalWriter{}
	recorder, writer := recordResponse(base)
	writer.WriteHeader(103)
	writer.WriteHeader(102)
	writer.WriteHeader(201)
	writer.WriteHeader(500)
	n, err := io.Copy(writer, onlyReader{strings.NewReader("payload")})
	if err != nil || n != 7 || recorder.bytes != 7 || recorder.status != 201 || len(base.statuses) != 3 || base.statuses[0] != 103 || base.statuses[2] != 201 {
		t.Fatal("informational/final status or byte count incorrect")
	}
	optimized := &readerFromWriter{minimalWriter: &minimalWriter{}}
	recorder, writer = recordResponse(optimized)
	if n, err := io.Copy(writer, onlyReader{strings.NewReader("bytes")}); err != nil || n != 5 || recorder.bytes != 5 || recorder.status != 200 || optimized.readerFromCalls != 1 {
		t.Fatal("optimized ReaderFrom bypassed accounting")
	}
}
