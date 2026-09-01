// Package cache is a TTL memo whose misses are single-flighted.
//
// The whole point of this server is that one upstream request serves every
// client, so a cold or expired entry must never let a burst of readers become a
// burst of upstream calls. Callers that arrive during a refresh wait for the
// in-flight one instead of starting their own.
package cache

import (
	"context"
	"sync"
	"time"
)

// Entry is a cached value and the moment it was produced.
type Entry[T any] struct {
	Value    T
	StoredAt time.Time
}

// Cache memoizes one value per key for a fixed TTL.
type Cache[T any] struct {
	ttl      time.Duration
	maxStale time.Duration

	mu      sync.Mutex
	entries map[string]*slot[T]
}

type slot[T any] struct {
	entry *Entry[T]
	// done is non-nil exactly while a refresh is in flight; waiters block on it.
	done chan struct{}
	err  error
}

// New returns a cache whose entries are fresh for ttl and may be served, when
// upstream is failing, for up to maxStale past the moment they were stored.
//
// maxStale is the honesty bound. Serving something slightly old beats a blank
// screen, but serving it forever means quietly presenting yesterday as today —
// and the client has its own saved snapshot to fall back on, which is a better
// answer than a stale one dressed up as current. A maxStale of 0 disables
// stale-serving entirely.
func New[T any](ttl, maxStale time.Duration) *Cache[T] {
	return &Cache[T]{ttl: ttl, maxStale: maxStale, entries: make(map[string]*slot[T])}
}

// Get returns the cached value for key, calling load only when there is no
// fresh entry and no refresh already running.
//
// On a load failure a recent entry is preferred over an error: a slightly old
// timetable is worth far more to a rider than a blank screen, and upstream is
// known to be intermittently unreachable. Past maxStale the error is returned
// instead, so the client falls back to RTL or to its own snapshot rather than
// being handed something too old to be true.
func (c *Cache[T]) Get(ctx context.Context, key string, load func(context.Context) (T, error)) (T, bool, error) {
	for {
		c.mu.Lock()
		s, ok := c.entries[key]
		if !ok {
			s = &slot[T]{}
			c.entries[key] = s
		}
		if s.entry != nil && time.Since(s.entry.StoredAt) < c.ttl {
			value := s.entry.Value
			c.mu.Unlock()
			return value, true, nil
		}
		if s.done != nil {
			done := s.done
			c.mu.Unlock()
			select {
			case <-done:
				continue // Re-read; the refresher has published its result.
			case <-ctx.Done():
				var zero T
				return zero, false, ctx.Err()
			}
		}
		// This caller owns the refresh.
		s.done = make(chan struct{})
		c.mu.Unlock()

		value, err := load(ctx)

		c.mu.Lock()
		if err == nil {
			s.entry = &Entry[T]{Value: value, StoredAt: time.Now()}
		}
		s.err = err
		done := s.done
		s.done = nil
		stale := s.entry
		c.mu.Unlock()
		close(done)

		if err != nil {
			if stale != nil && time.Since(stale.StoredAt) <= c.maxStale {
				return stale.Value, false, nil // Recent enough to still be true.
			}
			var zero T
			return zero, false, err
		}
		return value, false, nil
	}
}

// Peek returns the current entry without triggering a load.
func (c *Cache[T]) Peek(key string) (*Entry[T], bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s, ok := c.entries[key]
	if !ok || s.entry == nil {
		return nil, false
	}
	return s.entry, true
}

// Put stores a value directly, for producers that refresh on their own schedule
// (the poller) rather than on demand.
func (c *Cache[T]) Put(key string, value T) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s, ok := c.entries[key]
	if !ok {
		s = &slot[T]{}
		c.entries[key] = s
	}
	s.entry = &Entry[T]{Value: value, StoredAt: time.Now()}
}
