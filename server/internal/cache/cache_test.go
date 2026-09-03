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

// The point of Refresh: an entry that is still perfectly fresh is reloaded
// anyway. Warming an entry with Get instead would do nothing until it had
// already expired, leaving the next reader to wait for upstream — which is the
// wait warming exists to prevent.
func TestRefreshReplacesAnEntryThatIsStillFresh(t *testing.T) {
	c := New[int](time.Minute, time.Hour)
	var loads atomic.Int32
	load := func(context.Context) (int, error) {
		return int(loads.Add(1)), nil
	}

	if _, _, err := c.Get(t.Context(), "k", load); err != nil {
		t.Fatalf("Get: %v", err)
	}
	if err := c.Refresh(t.Context(), "k", load); err != nil {
		t.Fatalf("Refresh: %v", err)
	}

	value, hit, err := c.Get(t.Context(), "k", load)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !hit {
		t.Error("the refreshed value should have been served as a hit")
	}
	if value != 2 || loads.Load() != 2 {
		t.Fatalf("value = %d after %d loads, want 2 after 2", value, loads.Load())
	}
}

func TestRefreshJoinsAnInFlightLoadRatherThanDuplicatingIt(t *testing.T) {
	c := New[int](time.Minute, time.Hour)
	var loads atomic.Int32
	release := make(chan struct{})
	load := func(context.Context) (int, error) {
		loads.Add(1)
		<-release
		return 7, nil
	}

	go func() {
		_, _, _ = c.Get(context.Background(), "k", load)
	}()
	// Let the reader claim the slot before the warm tick arrives.
	time.Sleep(50 * time.Millisecond)

	done := make(chan error, 1)
	go func() { done <- c.Refresh(context.Background(), "k", load) }()
	time.Sleep(50 * time.Millisecond)
	close(release)

	if err := <-done; err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if got := loads.Load(); got != 1 {
		t.Fatalf("loads = %d, want 1: a refresh must join a load already running", got)
	}
}

// A warm that cannot reach upstream must leave the previous entry alone: it is
// the stale bound's job to decide how long that entry may still be served, not
// the failed refresh's job to erase it.
func TestFailedRefreshKeepsThePreviousEntry(t *testing.T) {
	c := New[int](time.Millisecond, time.Hour)
	if _, _, err := c.Get(t.Context(), "k", func(context.Context) (int, error) { return 7, nil }); err != nil {
		t.Fatalf("Get: %v", err)
	}

	wantErr := errors.New("upstream down")
	if err := c.Refresh(t.Context(), "k", func(context.Context) (int, error) { return 0, wantErr }); !errors.Is(err, wantErr) {
		t.Fatalf("Refresh error = %v, want %v", err, wantErr)
	}

	entry, ok := c.Peek("k")
	if !ok || entry.Value != 7 {
		t.Fatalf("Peek = %v, %v; want the previous value 7 still there", entry, ok)
	}
}
