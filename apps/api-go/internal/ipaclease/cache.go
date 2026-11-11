// Package ipaclease coalesces live IPAC checks into bounded, expiring leases.
// Callers must cache only fully verified results and include the complete
// upstream identity and session version in their key.
package ipaclease

import (
	"context"
	"errors"
	"sync"
	"time"
)

const (
	Lifetime      = 5 * time.Minute
	errorLifetime = 2 * time.Second
	loadTimeout   = 3 * time.Second
	entryLimit    = 4096
	inflightLimit = 128
)

var (
	ErrExpired     = errors.New("IPAC lease expired before it could be used")
	ErrInvalidated = errors.New("IPAC lease was invalidated during verification")
	ErrCapacity    = errors.New("IPAC lease verification capacity exhausted")
)

type entry[V any] struct {
	done        chan struct{}
	loadContext context.Context
	cancel      context.CancelFunc
	loading     bool
	invalidated bool
	value       V
	err         error
	expires     time.Time
	used        uint64
}

// Cache stores values in memory only. Values returned by a loader must be
// immutable after publication; callers needing mutable data must copy it.
// A hung loader still consumes an in-flight slot until it returns, preventing
// retries from creating an unbounded number of detached goroutines.
type Cache[K comparable, V any] struct {
	mu          sync.Mutex
	ttl         time.Duration
	entries     map[K]*entry[V]
	inflight    int
	sequence    uint64
	now         func() time.Time
	maxEntries  int
	maxInflight int
}

// New constructs a cache with a strictly positive lease lifetime. Loader
// errors have their own short lifetime and never retain an earlier value.
func New[K comparable, V any](ttl time.Duration) *Cache[K, V] {
	if ttl <= 0 {
		panic("IPAC lease lifetime must be positive")
	}
	return &Cache[K, V]{ttl: ttl, entries: make(map[K]*entry[V]), now: time.Now, maxEntries: entryLimit, maxInflight: inflightLimit}
}

// Get verifies an uncached key once, sharing that verification with concurrent
// callers. Each caller can cancel its own wait without canceling the loader.
// A positive lease expires at the earlier of loader start + ttl and hardExpiry;
// a zero hardExpiry adds no separate bound. Expired results are never returned.
func (c *Cache[K, V]) Get(ctx context.Context, key K, load func(context.Context) (V, time.Time, error)) (V, error) {
	var zero V
	if err := ctx.Err(); err != nil {
		return zero, err
	}
	c.mu.Lock()
	started := c.now()
	if e, exists := c.entries[key]; exists {
		if e.loading || started.Before(e.expires) {
			c.sequence++
			e.used = c.sequence
			c.mu.Unlock()
			return c.wait(ctx, e)
		}
		delete(c.entries, key)
	}
	if c.inflight >= c.maxInflight || !c.makeRoom() {
		c.mu.Unlock()
		return zero, ErrCapacity
	}
	loadContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), loadTimeout)
	c.sequence++
	e := &entry[V]{done: make(chan struct{}), loadContext: loadContext, cancel: cancel, loading: true, used: c.sequence}
	c.entries[key] = e
	c.inflight++
	c.mu.Unlock()
	go c.fill(key, e, started, load)
	return c.wait(ctx, e)
}

// Delete forces the next Get to verify again. Entry identity protects against
// an older loader repopulating the key; its waiters fail immediately. Explicit
// invalidation may cancel that loader, unlike an individual waiter's context.
func (c *Cache[K, V]) Delete(key K) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, exists := c.entries[key]; exists {
		delete(c.entries, key)
		e.invalidated = true
		if e.loading {
			e.loading = false
			e.err = ErrInvalidated
			close(e.done)
			e.cancel()
		}
	}
}

// makeRoom evicts only completed entries, preferring the least recently used.
// Active fills remain registered so a second caller cannot start a duplicate.
// c.mu must be held.
func (c *Cache[K, V]) makeRoom() bool {
	if len(c.entries) < c.maxEntries {
		return true
	}
	var candidate K
	var oldest *entry[V]
	for key, e := range c.entries {
		if !e.loading && (oldest == nil || e.used < oldest.used) {
			candidate, oldest = key, e
		}
	}
	if oldest == nil {
		return false
	}
	delete(c.entries, candidate)
	return true
}

func (c *Cache[K, V]) fill(key K, e *entry[V], started time.Time, load func(context.Context) (V, time.Time, error)) {
	defer e.cancel()
	value, hardExpiry, err := load(e.loadContext)
	if contextErr := e.loadContext.Err(); contextErr != nil {
		err = contextErr
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.inflight--
	if e.invalidated || c.entries[key] != e {
		return
	}
	finished := c.now()
	expires := started.Add(c.ttl)
	if !hardExpiry.IsZero() && hardExpiry.Before(expires) {
		expires = hardExpiry
	}
	if err == nil && !finished.Before(expires) {
		err = ErrExpired
	}
	if err != nil {
		var zero V
		value, expires = zero, finished.Add(errorLifetime)
	}
	e.loading, e.value, e.err, e.expires = false, value, err, expires
	close(e.done)
}

func (c *Cache[K, V]) wait(ctx context.Context, e *entry[V]) (V, error) {
	var zero V
	select {
	case <-ctx.Done():
		return zero, ctx.Err()
	case <-e.done:
	case <-e.loadContext.Done():
		// A loader ignoring its deadline remains bounded by the in-flight limit,
		// but its callers must not wait indefinitely or receive its late result.
		// Completed results take precedence over the loader's deferred cancel.
		select {
		case <-e.done:
		default:
			return zero, e.loadContext.Err()
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return zero, err
	}
	if e.invalidated {
		return zero, ErrInvalidated
	}
	if e.err != nil {
		return zero, e.err
	}
	if !c.now().Before(e.expires) {
		return zero, ErrExpired
	}
	return e.value, nil
}
