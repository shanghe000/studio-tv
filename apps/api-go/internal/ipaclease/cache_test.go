package ipaclease

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *testClock) now() time.Time          { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *testClock) advance(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

func fixture[K comparable, V any](ttl time.Duration) (*Cache[K, V], *testClock) {
	c := New[K, V](ttl)
	clock := &testClock{t: time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC)}
	c.now = clock.now
	return c, clock
}

type outcome struct {
	value string
	err   error
}

func receive(t *testing.T, results <-chan outcome) outcome {
	t.Helper()
	select {
	case result := <-results:
		return result
	case <-time.After(5 * time.Second):
		t.Fatal("lease waiter did not finish")
		return outcome{}
	}
}

func waitInflight(t *testing.T, c *Cache[string, string], expected int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		c.mu.Lock()
		actual := c.inflight
		c.mu.Unlock()
		if actual == expected {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("in-flight loaders = %d, want %d", actual, expected)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestConcurrentWaitersShareOneVerifiedLease(t *testing.T) {
	c, _ := fixture[string, string](Lifetime)
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	load := func(context.Context) (string, time.Time, error) {
		if calls.Add(1) == 1 {
			close(started)
		}
		<-release
		return "verified", time.Time{}, nil
	}
	results := make(chan outcome, 32)
	for i := 0; i < cap(results); i++ {
		go func() { value, err := c.Get(context.Background(), "same", load); results <- outcome{value, err} }()
	}
	<-started
	close(release)
	for i := 0; i < cap(results); i++ {
		result := receive(t, results)
		if result.value != "verified" || result.err != nil {
			t.Fatalf("shared result = %+v", result)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("loader calls = %d, want 1", calls.Load())
	}
}

func TestCanceledWaiterDoesNotCancelSharedLoader(t *testing.T) {
	c, _ := fixture[string, string](Lifetime)
	type contextKey struct{}
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), contextKey{}, "request-value"))
	started, release := make(chan context.Context, 1), make(chan struct{})
	var calls atomic.Int32
	load := func(ctx context.Context) (string, time.Time, error) {
		calls.Add(1)
		started <- ctx
		<-release
		return "verified", time.Time{}, nil
	}
	first, second := make(chan outcome, 1), make(chan outcome, 1)
	go func() { value, err := c.Get(ctx, "same", load); first <- outcome{value, err} }()
	loaderContext := <-started
	go func() { value, err := c.Get(context.Background(), "same", load); second <- outcome{value, err} }()
	cancel()
	if result := receive(t, first); result.value != "" || !errors.Is(result.err, context.Canceled) {
		t.Fatalf("canceled result = %+v", result)
	}
	if loaderContext.Err() != nil || loaderContext.Value(contextKey{}) != "request-value" {
		t.Fatal("loader lost the detached request context")
	}
	deadline, ok := loaderContext.Deadline()
	if !ok || time.Until(deadline) > loadTimeout || time.Until(deadline) < 2*time.Second {
		t.Fatal("loader does not have the bounded upstream deadline")
	}
	close(release)
	if result := receive(t, second); result.value != "verified" || result.err != nil {
		t.Fatalf("other waiter result = %+v", result)
	}
	if calls.Load() != 1 {
		t.Fatalf("loader calls = %d", calls.Load())
	}
}

func TestAlreadyCanceledCallerStartsNoWork(t *testing.T) {
	c := New[string, string](Lifetime)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	value, err := c.Get(ctx, "key", func(context.Context) (string, time.Time, error) {
		t.Error("canceled caller started upstream work")
		return "grant", time.Time{}, nil
	})
	if value != "" || !errors.Is(err, context.Canceled) {
		t.Fatalf("result = %q, %v", value, err)
	}
}

func TestExpiredLeaseReloadsAndFailureNeverReturnsOldGrant(t *testing.T) {
	c, clock := fixture[string, string](Lifetime)
	upstreamFailure := errors.New("IPAC unavailable")
	var calls int
	load := func(context.Context) (string, time.Time, error) {
		calls++
		if calls == 2 {
			return "unverified", time.Time{}, upstreamFailure
		}
		return "verified", time.Time{}, nil
	}
	if value, err := c.Get(context.Background(), "key", load); value != "verified" || err != nil {
		t.Fatalf("initial result = %q, %v", value, err)
	}
	clock.advance(Lifetime - time.Nanosecond)
	if _, err := c.Get(context.Background(), "key", load); err != nil || calls != 1 {
		t.Fatal("lease was not reused before expiry")
	}
	clock.advance(time.Nanosecond)
	if value, err := c.Get(context.Background(), "key", load); value != "" || !errors.Is(err, upstreamFailure) {
		t.Fatalf("expired failure returned = %q, %v", value, err)
	}
	clock.advance(errorLifetime - time.Nanosecond)
	if value, err := c.Get(context.Background(), "key", load); value != "" || !errors.Is(err, upstreamFailure) || calls != 2 {
		t.Fatal("outage was not suppressed for exactly its short lifetime")
	}
	clock.advance(time.Nanosecond)
	if value, err := c.Get(context.Background(), "key", load); value != "verified" || err != nil || calls != 3 {
		t.Fatalf("recovery result = %q, %v; calls %d", value, err, calls)
	}
}

func TestHardExpiryBoundsLeaseAndRejectsLateVerification(t *testing.T) {
	for _, bound := range []time.Duration{time.Minute, 10 * time.Minute} {
		t.Run(bound.String(), func(t *testing.T) {
			c, clock := fixture[string, string](Lifetime)
			var calls int
			load := func(context.Context) (string, time.Time, error) {
				calls++
				return "verified", clock.now().Add(bound), nil
			}
			if _, err := c.Get(context.Background(), "key", load); err != nil {
				t.Fatal(err)
			}
			expected := bound
			if expected > Lifetime {
				expected = Lifetime
			}
			clock.advance(expected)
			if _, err := c.Get(context.Background(), "key", load); err != nil || calls != 2 {
				t.Fatalf("expiry did not reload: %v, %d calls", err, calls)
			}
		})
	}
	c, clock := fixture[string, string](Lifetime)
	value, err := c.Get(context.Background(), "late", func(context.Context) (string, time.Time, error) {
		expires := clock.now().Add(time.Minute)
		clock.advance(time.Minute)
		return "expired-grant", expires, nil
	})
	if value != "" || !errors.Is(err, ErrExpired) {
		t.Fatalf("hard-expired verification returned = %q, %v", value, err)
	}
	value, err = c.Get(context.Background(), "ttl-late", func(context.Context) (string, time.Time, error) {
		clock.advance(Lifetime)
		return "late-grant", time.Time{}, nil
	})
	if value != "" || !errors.Is(err, ErrExpired) {
		t.Fatalf("TTL started after upstream work: %q, %v", value, err)
	}
}

func TestCompleteIdentityKeyIsolation(t *testing.T) {
	type key struct {
		subject, session, capability string
		version                      uint64
	}
	c, _ := fixture[key, string](Lifetime)
	keys := []key{{"subject", "session", "tv.access", 1}, {"other", "session", "tv.access", 1}, {"subject", "other", "tv.access", 1}, {"subject", "session", "other", 1}, {"subject", "session", "tv.access", 2}}
	var calls int
	for i, k := range keys {
		expected := string(rune('a' + i))
		value, err := c.Get(context.Background(), k, func(context.Context) (string, time.Time, error) { calls++; return expected, time.Time{}, nil })
		if value != expected || err != nil {
			t.Fatalf("isolated key returned %q, %v", value, err)
		}
	}
	if calls != len(keys) {
		t.Fatal("distinct identities reused another lease")
	}
}

func TestDeleteInvalidatesWaitersAndOlderFillCannotRepopulate(t *testing.T) {
	c, _ := fixture[string, string](Lifetime)
	started, release := make(chan struct{}), make(chan struct{})
	results := make(chan outcome, 1)
	go func() {
		value, err := c.Get(context.Background(), "key", func(context.Context) (string, time.Time, error) {
			close(started)
			<-release
			return "old-grant", time.Time{}, nil
		})
		results <- outcome{value, err}
	}()
	<-started
	c.Delete("key")
	if result := receive(t, results); result.value != "" || !errors.Is(result.err, ErrInvalidated) {
		t.Fatalf("invalidated waiter = %+v", result)
	}
	newLoad := func(context.Context) (string, time.Time, error) { return "new-grant", time.Time{}, nil }
	if value, err := c.Get(context.Background(), "key", newLoad); value != "new-grant" || err != nil {
		t.Fatalf("fresh result = %q, %v", value, err)
	}
	close(release)
	waitInflight(t, c, 0)
	value, err := c.Get(context.Background(), "key", func(context.Context) (string, time.Time, error) {
		t.Error("new fill was lost")
		return "unexpected", time.Time{}, nil
	})
	if value != "new-grant" || err != nil {
		t.Fatalf("old fill replaced new grant: %q, %v", value, err)
	}
	c.Delete("key")
	if value, err := c.Get(context.Background(), "key", func(context.Context) (string, time.Time, error) { return "after-delete", time.Time{}, nil }); value != "after-delete" || err != nil {
		t.Fatal("completed entry was not invalidated")
	}
}

func TestCompletedEntriesAreBoundedWithoutEvictingActiveFills(t *testing.T) {
	c, _ := fixture[string, string](Lifetime)
	c.maxEntries, c.maxInflight = 2, 2
	started, release := make(chan struct{}, 2), make(chan struct{})
	var calls atomic.Int32
	load := func(context.Context) (string, time.Time, error) {
		calls.Add(1)
		started <- struct{}{}
		<-release
		return "verified", time.Time{}, nil
	}
	results := make(chan outcome, 3)
	for _, key := range []string{"a", "b"} {
		go func() { value, err := c.Get(context.Background(), key, load); results <- outcome{value, err} }()
	}
	<-started
	<-started
	if value, err := c.Get(context.Background(), "c", load); value != "" || !errors.Is(err, ErrCapacity) {
		t.Fatalf("capacity result = %q, %v", value, err)
	}
	go func() { value, err := c.Get(context.Background(), "a", load); results <- outcome{value, err} }()
	close(release)
	for i := 0; i < 3; i++ {
		if result := receive(t, results); result.err != nil || result.value != "verified" {
			t.Fatalf("active fill was evicted: %+v", result)
		}
	}
	if calls.Load() != 2 {
		t.Fatalf("duplicate active fills: %d calls", calls.Load())
	}
	for _, key := range []string{"c", "d", "e"} {
		if _, err := c.Get(context.Background(), key, func(context.Context) (string, time.Time, error) { return key, time.Time{}, nil }); err != nil {
			t.Fatal(err)
		}
		c.mu.Lock()
		size := len(c.entries)
		c.mu.Unlock()
		if size != 2 {
			t.Fatalf("cache grew beyond its bound: %d", size)
		}
	}
}

func TestInvalidatedHungLoadersStillConsumeBoundedSlots(t *testing.T) {
	c, _ := fixture[string, string](Lifetime)
	c.maxEntries, c.maxInflight = 10, 1
	started, release := make(chan struct{}), make(chan struct{})
	results := make(chan outcome, 1)
	go func() {
		value, err := c.Get(context.Background(), "a", func(context.Context) (string, time.Time, error) {
			close(started)
			<-release
			return "old", time.Time{}, nil
		})
		results <- outcome{value, err}
	}()
	<-started
	c.Delete("a")
	if result := receive(t, results); !errors.Is(result.err, ErrInvalidated) {
		t.Fatal(result.err)
	}
	if _, err := c.Get(context.Background(), "b", func(context.Context) (string, time.Time, error) {
		t.Error("hung fill no longer consumes its slot")
		return "grant", time.Time{}, nil
	}); !errors.Is(err, ErrCapacity) {
		t.Fatalf("in-flight bound returned %v", err)
	}
	close(release)
	waitInflight(t, c, 0)
	if _, err := c.Get(context.Background(), "b", func(context.Context) (string, time.Time, error) { return "grant", time.Time{}, nil }); err != nil {
		t.Fatalf("slot not released after loader completion: %v", err)
	}
}

func TestLoaderDeadlineFailsClosedEvenWhenLoaderIgnoresCancellation(t *testing.T) {
	c := New[string, string](Lifetime)
	started, release := make(chan struct{}), make(chan struct{})
	results := make(chan outcome, 1)
	go func() {
		value, err := c.Get(context.Background(), "key", func(context.Context) (string, time.Time, error) {
			close(started)
			<-release
			return "late-grant", time.Time{}, nil
		})
		results <- outcome{value, err}
	}()
	<-started
	if result := receive(t, results); result.value != "" || !errors.Is(result.err, context.DeadlineExceeded) {
		t.Fatalf("deadline result = %+v", result)
	}
	close(release)
	waitInflight(t, c, 0)
	if value, err := c.Get(context.Background(), "key", func(context.Context) (string, time.Time, error) {
		t.Error("timeout was not suppressed")
		return "new", time.Time{}, nil
	}); value != "" || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("late grant accepted: %q, %v", value, err)
	}
}
