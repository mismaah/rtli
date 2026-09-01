package cache

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSingleFlightCollapsesConcurrentMisses(t *testing.T) {
	c := New[int](time.Minute, time.Hour)
	var loads atomic.Int32
	release := make(chan struct{})

	var wg sync.WaitGroup
	for range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, err := c.Get(t.Context(), "k", func(context.Context) (int, error) {
				loads.Add(1)
				<-release
				return 7, nil
			})
			if err != nil {
				t.Errorf("Get: %v", err)
			}
		}()
	}
	// Give the goroutines a chance to pile up on the same cold key.
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	if got := loads.Load(); got != 1 {
		t.Fatalf("50 concurrent misses triggered %d loads, want 1", got)
	}
}

func TestHitDoesNotReload(t *testing.T) {
	c := New[int](time.Minute, time.Hour)
	var loads atomic.Int32
	load := func(context.Context) (int, error) {
		loads.Add(1)
		return 1, nil
	}

	if _, hit, _ := c.Get(t.Context(), "k", load); hit {
		t.Fatal("first Get reported a hit")
	}
	if _, hit, _ := c.Get(t.Context(), "k", load); !hit {
		t.Fatal("second Get reported a miss")
	}
	if got := loads.Load(); got != 1 {
		t.Fatalf("loads = %d, want 1", got)
	}
}

func TestExpiryTriggersReload(t *testing.T) {
	c := New[int](10*time.Millisecond, time.Hour)
	var loads atomic.Int32
	load := func(context.Context) (int, error) {
		return int(loads.Add(1)), nil
	}

	v, _, _ := c.Get(t.Context(), "k", load)
	if v != 1 {
		t.Fatalf("first value = %d, want 1", v)
	}
	time.Sleep(20 * time.Millisecond)
	v, _, _ = c.Get(t.Context(), "k", load)
	if v != 2 {
		t.Fatalf("value after expiry = %d, want 2", v)
	}
}

// A failing refresh must not blank out a good answer: upstream is known to be
// intermittently unreachable and a stale timetable beats none.
func TestStaleServedWhenRefreshFails(t *testing.T) {
	c := New[string](10*time.Millisecond, time.Hour)
	ok := func(context.Context) (string, error) { return "good", nil }
	boom := func(context.Context) (string, error) { return "", errors.New("upstream down") }

	if v, _, err := c.Get(t.Context(), "k", ok); err != nil || v != "good" {
		t.Fatalf("seed: %q %v", v, err)
	}
	time.Sleep(20 * time.Millisecond)

	v, hit, err := c.Get(t.Context(), "k", boom)
	if err != nil {
		t.Fatalf("failed refresh returned error %v, want stale value", err)
	}
	if v != "good" {
		t.Fatalf("stale value = %q, want %q", v, "good")
	}
	if hit {
		t.Fatal("stale serve reported as a fresh hit")
	}
}

func TestColdFailureReturnsError(t *testing.T) {
	c := New[string](time.Minute, time.Hour)
	_, _, err := c.Get(t.Context(), "k", func(context.Context) (string, error) {
		return "", errors.New("upstream down")
	})
	if err == nil {
		t.Fatal("cold miss with a failing load returned no error")
	}
}

// Past the stale bound the error must surface, so the caller falls back to RTL
// or to its own snapshot rather than being handed something too old to be true.
func TestStaleBeyondBoundReturnsError(t *testing.T) {
	c := New[string](10*time.Millisecond, 30*time.Millisecond)
	ok := func(context.Context) (string, error) { return "good", nil }
	boom := func(context.Context) (string, error) { return "", errors.New("upstream down") }

	if _, _, err := c.Get(t.Context(), "k", ok); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Inside the bound: still served.
	time.Sleep(15 * time.Millisecond)
	if v, _, err := c.Get(t.Context(), "k", boom); err != nil || v != "good" {
		t.Fatalf("within stale bound: got %q %v, want the stale value", v, err)
	}

	// Past it: the error wins.
	time.Sleep(40 * time.Millisecond)
	if _, _, err := c.Get(t.Context(), "k", boom); err == nil {
		t.Error("value past the stale bound was served, want an error")
	}
}

// A zero bound means never serve stale at all.
func TestZeroStaleBoundNeverServesStale(t *testing.T) {
	c := New[string](time.Millisecond, 0)
	if _, _, err := c.Get(t.Context(), "k", func(context.Context) (string, error) {
		return "good", nil
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	time.Sleep(10 * time.Millisecond)
	if _, _, err := c.Get(t.Context(), "k", func(context.Context) (string, error) {
		return "", errors.New("down")
	}); err == nil {
		t.Error("stale value served despite a zero bound")
	}
}

// A successful refresh must reset the clock, not inherit the old entry's age.
func TestSuccessfulRefreshResetsStaleness(t *testing.T) {
	c := New[string](10*time.Millisecond, 50*time.Millisecond)
	ok := func(context.Context) (string, error) { return "good", nil }
	boom := func(context.Context) (string, error) { return "", errors.New("down") }

	c.Get(t.Context(), "k", ok)
	time.Sleep(40 * time.Millisecond)
	c.Get(t.Context(), "k", ok) // Refresh: age resets here.
	time.Sleep(30 * time.Millisecond)

	if v, _, err := c.Get(t.Context(), "k", boom); err != nil || v != "good" {
		t.Errorf("after a refresh: got %q %v, want the value still inside the bound", v, err)
	}
}
