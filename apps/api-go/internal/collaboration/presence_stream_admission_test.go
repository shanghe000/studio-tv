package collaboration

import (
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/httpapi"
)

func TestPresenceStreamAdmissionReservesHTTPWriteCapacityAndRecovers(t *testing.T) {
	s, err := NewPresenceService(&pgxpool.Pool{})
	if err != nil {
		t.Fatal(err)
	}
	subscribe := func(project, user string) func() {
		t.Helper()
		_, release, err := s.subscribeStream(project, user)
		if err != nil {
			t.Fatal("available account stream rejected", err)
		}
		var once sync.Once
		close := func() { once.Do(release) }
		t.Cleanup(close)
		return close
	}
	a1 := subscribe("project-a", "user-a")
	a2 := subscribe("project-b", "user-a")
	// Content streams have their own two-per-account budget. Presence must
	// leave room for writes rather than occupy four additional browser slots.
	_, _, err = s.subscribeStream("project-c", "user-a")
	var api *httpapi.Error
	if !errors.As(err, &api) || api.Status != 429 || api.Code != "PRESENCE_STREAM_LIMIT" {
		t.Fatal("third account presence stream did not use bounded fallback", err)
	}
	b1 := subscribe("project-a", "user-b")
	b2 := subscribe("project-b", "user-b")
	if s.activeStreams != 4 || s.userStreams["user-a"] != 2 || s.userStreams["user-b"] != 2 {
		t.Fatal("stream rejection leaked admission or crossed account boundaries", s.activeStreams, s.userStreams)
	}
	a1()
	a3 := subscribe("project-c", "user-a")
	if s.activeStreams != 4 || s.userStreams["user-a"] != 2 {
		t.Fatal("released account slot was not reusable", s.activeStreams, s.userStreams)
	}
	for _, close := range []func(){a2, a3, b1, b2} {
		close()
	}
	if s.activeStreams != 0 || len(s.userStreams) != 0 || len(s.projects) != 0 {
		t.Fatal("completed streams retained admission slots or empty projects", s.activeStreams, s.userStreams, len(s.projects))
	}
}

func TestPresenceStreamAdmissionKeepsGlobalLimit(t *testing.T) {
	s, err := NewPresenceService(&pgxpool.Pool{})
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 128; index++ {
		_, release, err := s.subscribeStream("project", fmt.Sprintf("user-%d", index))
		if err != nil {
			t.Fatal("global budget reduced unexpectedly", index, err)
		}
		t.Cleanup(release)
	}
	_, _, err = s.subscribeStream("project", "user-overflow")
	var api *httpapi.Error
	if !errors.As(err, &api) || api.Status != 429 || api.Code != "PRESENCE_STREAM_LIMIT" || s.activeStreams != 128 {
		t.Fatal("global stream limit changed or rejection leaked a slot", s.activeStreams, err)
	}
}
