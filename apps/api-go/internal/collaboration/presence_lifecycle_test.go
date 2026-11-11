package collaboration

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPresenceStreamRotationReleasesCapacityWithoutExpiringPage(t *testing.T) {
	s, err := NewPresenceService(&pgxpool.Pool{})
	if err != nil {
		t.Fatal(err)
	}
	// A stream is only a transport subscription. Thirty-second rotation or a
	// reconnect must not revoke a still-present page's pending editing rights.
	p := s.projectLocked("project")
	p.members["page-old"] = presenceParticipant{PresenceMember: PresenceMember{ClientID: "page-old", UserID: "user", LastSeenAt: time.Now()}, session: "session"}
	for attempt := 0; attempt < 12; attempt++ {
		_, release, err := s.subscribeStream("project", "user")
		if err != nil {
			t.Fatal("normal rotation accumulated admission slots", err)
		}
		release()
		if s.activeStreams != 0 || len(s.userStreams) != 0 || len(p.watchers) != 0 {
			t.Fatal("closed stream retained a reservation", s.activeStreams, s.userStreams)
		}
		if _, ok := p.members["page-old"]; !ok {
			t.Fatal("transport closure incorrectly removed the live page")
		}
	}
	// Missing leave requests stay bounded by the existing heartbeat TTL; no
	// change to the lease expiry or stream quota is necessary for this cleanup.
	member := p.members["page-old"]
	member.LastSeenAt = time.Now().Add(-PresenceTTL - time.Second)
	p.members["page-old"] = member
	s.expireLocked(p, time.Now())
	if len(p.members) != 0 {
		t.Fatal("abandoned page survived the existing TTL")
	}
}

func TestPostgresCanvasPresenceLateLeaveIsIsolatedFromRefreshedAndOtherDevicePages(t *testing.T) {
	f := newPresenceFixture(t)
	if _, err := f.db.Exec(f.ctx, `UPDATE public.projects SET graph=jsonb_set(graph,'{nodes}',(graph->'nodes')||'[ {"id":"n3","type":"rh-image","position":{"x":0,"y":0},"data":{}} ]'::jsonb) WHERE id='presence_project'`); err != nil {
		t.Fatal(err)
	}
	otherDevice := f.owner
	otherDevice.SessionID = "another-verified-device-session"
	otherDevice.IPACSessionID = "another-verified-device-ipac-session"
	for _, page := range []struct {
		client, node string
		otherDevice  bool
	}{{"page-old", "n3", false}, {"page-refreshed", "n1", false}, {"page-other-device", "n2", true}} {
		identity := f.owner
		if page.otherDevice {
			identity = otherDevice
		}
		f.join(t, identity, page.client)
		if _, err := f.s.Acquire(f.ctx, identity, "presence_project", page.client, []string{page.node}); err != nil {
			t.Fatal(err)
		}
	}
	// Closing the old SSE transport, including normal stream rotation, must
	// preserve its node lease until a verified leave or natural expiry.
	_, disconnect, err := f.s.subscribeStream("presence_project", f.owner.UserID)
	if err != nil {
		t.Fatal(err)
	}
	disconnect()
	presenceStatus(t, f.check(f.owner, "page-refreshed", []string{"n3"}), 409)
	for replay := 0; replay < 2; replay++ {
		snapshot, err := f.s.Release(context.Background(), f.owner, "presence_project", "page-old", nil, true)
		if err != nil || len(snapshot.Members) != 2 || len(snapshot.Leases) != 2 {
			t.Fatal("late old-page leave removed another page", snapshot, err)
		}
		for _, member := range snapshot.Members {
			if member.ClientID == "page-old" {
				t.Fatal("verified leave retained its own stale participant")
			}
		}
		if err := f.check(f.owner, "page-refreshed", []string{"n1"}); err != nil {
			t.Fatal("late leave removed refreshed-page ownership", err)
		}
		if err := f.check(otherDevice, "page-other-device", []string{"n2"}); err != nil {
			t.Fatal("late leave removed another device's ownership", err)
		}
		presenceStatus(t, f.check(f.owner, "page-old", []string{"n1"}), 409)
		presenceStatus(t, f.check(f.owner, "page-old", []string{"n2"}), 409)
	}
}
