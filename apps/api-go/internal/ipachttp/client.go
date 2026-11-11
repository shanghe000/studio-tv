// Package ipachttp bounds outbound IPAC requests without caching identity or
// permission decisions. Session status, runtime authorization and OIDC clients
// share the same process-wide budget for upstream credential verification.
package ipachttp

import (
	"io"
	"net/http"
	"sync"
	"time"
)

var sharedTransport = &boundedTransport{
	base:  http.DefaultTransport,
	slots: make(chan struct{}, 2),
}

// NewClient preserves the caller's timeout and redirect policy while sharing
// at most two in-flight IPAC requests across clients. Existing request contexts
// include time spent waiting; every admitted request still reaches IPAC.
func NewClient(timeout time.Duration) *http.Client {
	return &http.Client{Transport: sharedTransport, Timeout: timeout}
}

type boundedTransport struct {
	base  http.RoundTripper
	slots chan struct{}
}

func (t *boundedTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	ctx := request.Context()
	if err := ctx.Err(); err != nil {
		closeRequestBody(request)
		return nil, err
	}
	select {
	case t.slots <- struct{}{}:
	case <-ctx.Done():
		closeRequestBody(request)
		return nil, ctx.Err()
	}
	release := func() { <-t.slots }
	if err := ctx.Err(); err != nil {
		release()
		closeRequestBody(request)
		return nil, err
	}
	response, err := t.base.RoundTrip(request)
	if err != nil || response == nil || response.Body == nil || response.Body == http.NoBody {
		release()
		return response, err
	}
	// Headers alone do not finish a request. Keep the permit until the response
	// has been consumed or closed, including error and redirect responses.
	response.Body = &boundedBody{ReadCloser: response.Body, release: release}
	return response, nil
}

func closeRequestBody(request *http.Request) {
	if request.Body != nil {
		_ = request.Body.Close()
	}
}

type boundedBody struct {
	io.ReadCloser
	once    sync.Once
	release func()
}

func (b *boundedBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err == io.EOF {
		b.once.Do(b.release)
	}
	return n, err
}

func (b *boundedBody) Close() error {
	err := b.ReadCloser.Close()
	b.once.Do(b.release)
	return err
}
