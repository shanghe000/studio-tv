package http

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
)

func TestSSEConnectedHTTPDisconnectReleasesAccountSlotBeforeNextPoll(t *testing.T) {
	identity := streamIdentity()
	stream := testStream(func(_ context.Context, _ string, project string, after int64, _ int) (domain.EventPage, error) {
		return emptyStreamPage(project, after), nil
	})
	stream.maxActive, stream.maxUser = 1, 1
	stream.lifetime, stream.poll = 5*time.Second, 5*time.Second
	finished := make(chan error, 4)
	server := httptest.NewServer(httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
		r = httpapi.WithLiveAuthorization(r, httpapi.LiveAuthorization{Revalidate: func(context.Context) (httpapi.Identity, error) { return identity, nil }})
		err := stream.serve(w, r, identity, "project", 0, 100)
		finished <- err
		return err
	}))
	defer server.Close()
	// Each new HTTP connection must be admitted after the preceding browser
	// transport is canceled, even though the normal server poll is five seconds.
	for attempt := 0; attempt < 3; attempt++ {
		ctx, cancel := context.WithCancel(context.Background())
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		response, err := server.Client().Do(request)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		if response.StatusCode != 200 || response.Header.Get("Content-Type") != "text/event-stream; charset=utf-8" {
			cancel()
			response.Body.Close()
			t.Fatal("previous canceled page retained its account stream reservation", response.StatusCode)
		}
		cancel()
		response.Body.Close()
		select {
		case err := <-finished:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(time.Second):
			t.Fatal("connected HTTP cancellation waited for the next poll or lifetime")
		}
		stream.mu.Lock()
		active, accounts := stream.active, len(stream.users)
		stream.mu.Unlock()
		if active != 0 || accounts != 0 {
			t.Fatal("canceled connection kept a stream slot", active, accounts)
		}
	}
}
