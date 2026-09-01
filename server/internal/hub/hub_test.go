package hub

import (
	"errors"
	"sync"
	"testing"
)

func mustSubscribe(t *testing.T, h *Hub, client string, routes ...string) *Subscriber {
	t.Helper()
	sub, err := h.Subscribe(client, routes)
	if err != nil {
		t.Fatalf("Subscribe(%s, %v): %v", client, routes, err)
	}
	return sub
}

func TestSubscriberOnlyReceivesItsRoutes(t *testing.T) {
	h := New()
	sub := mustSubscribe(t, h, "c2", "133")
	defer h.Unsubscribe(sub)

	h.Publish("bus", "132", []byte(`{"busCode":"other"}`))
	h.Publish("bus", "133", []byte(`{"busCode":"mine"}`))

	event := <-sub.Events()
	if event.RouteCode != "133" {
		t.Fatalf("received route %q, want 133", event.RouteCode)
	}
	select {
	case extra := <-sub.Events():
		t.Fatalf("received an unwanted event for route %q", extra.RouteCode)
	default:
	}
}

// An empty route code is a broadcast to everyone.
func TestEmptyRouteReachesEverySubscriber(t *testing.T) {
	h := New()
	a := mustSubscribe(t, h, "c1", "133")
	b := mustSubscribe(t, h, "c2", "132")
	defer h.Unsubscribe(a)
	defer h.Unsubscribe(b)

	h.Publish("ping", "", []byte(`{}`))

	for i, sub := range []*Subscriber{a, b} {
		select {
		case <-sub.Events():
		default:
			t.Errorf("subscriber %d missed the broadcast", i)
		}
	}
}

func TestEventIDsAreMonotonic(t *testing.T) {
	h := New()
	sub := mustSubscribe(t, h, "c2", "133")
	defer h.Unsubscribe(sub)

	for range 5 {
		h.Publish("bus", "133", []byte(`{}`))
	}
	var last uint64
	for range 5 {
		event := <-sub.Events()
		if event.ID <= last {
			t.Fatalf("event id %d did not advance past %d", event.ID, last)
		}
		last = event.ID
	}
}

// One stalled client must never hold up the poller, and therefore every other
// client, behind it.
func TestSlowSubscriberIsDroppedNotBlocking(t *testing.T) {
	h := New()
	slow := mustSubscribe(t, h, "c1", "133")
	defer h.Unsubscribe(slow)

	// Never read from `slow`; publish well past its buffer.
	for range bufferSize + 50 {
		h.Publish("bus", "133", []byte(`{}`))
	}

	if slow.Dropped() == 0 {
		t.Error("a subscriber that never read reported no drops")
	}
	if got := len(slow.Events()); got != bufferSize {
		t.Errorf("buffered %d events, want the cap of %d", got, bufferSize)
	}
}

func TestRouteSubscribersCounts(t *testing.T) {
	h := New()
	a := mustSubscribe(t, h, "c1", "133", "132")
	b := mustSubscribe(t, h, "c2", "133")
	defer h.Unsubscribe(a)
	defer h.Unsubscribe(b)

	counts := h.RouteSubscribers()
	if counts["133"] != 2 {
		t.Errorf("route 133 watchers = %d, want 2", counts["133"])
	}
	if counts["132"] != 1 {
		t.Errorf("route 132 watchers = %d, want 1", counts["132"])
	}

	h.Unsubscribe(b)
	if counts := h.RouteSubscribers(); counts["133"] != 1 {
		t.Errorf("after unsubscribe, route 133 watchers = %d, want 1", counts["133"])
	}
}

func TestUnsubscribeIsIdempotent(t *testing.T) {
	h := New()
	sub := mustSubscribe(t, h, "c2", "133")
	h.Unsubscribe(sub)
	h.Unsubscribe(sub) // Must not panic on a double close.
	if h.Len() != 0 {
		t.Errorf("subscribers = %d, want 0", h.Len())
	}
}

func TestConcurrentPublishAndSubscribe(t *testing.T) {
	// Generous per-client cap: this test churns 20 connections under one id.
	h := NewWithLimits(1000, 1000)
	var wg sync.WaitGroup

	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sub := mustSubscribe(t, h, "c2", "133")
			for range 10 {
				select {
				case <-sub.Events():
				default:
				}
			}
			h.Unsubscribe(sub)
		}()
	}
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 25 {
				h.Publish("bus", "133", []byte(`{}`))
			}
		}()
	}
	wg.Wait()

	if h.Len() != 0 {
		t.Errorf("subscribers left = %d, want 0", h.Len())
	}
}

// The endpoint is public and unauthenticated, so unbounded long-lived
// connections are a memory-exhaustion invitation.
func TestGlobalConnectionCap(t *testing.T) {
	h := NewWithLimits(3, 100)
	for i := range 3 {
		if _, err := h.Subscribe("c"+string(rune('a'+i)), []string{"133"}); err != nil {
			t.Fatalf("subscribe %d: %v", i, err)
		}
	}
	_, err := h.Subscribe("cz", []string{"133"})
	var capacity *ErrAtCapacity
	if !errors.As(err, &capacity) {
		t.Fatalf("err = %v, want ErrAtCapacity", err)
	}
	if capacity.PerClient {
		t.Error("global cap reported as a per-client refusal")
	}
}

func TestPerClientCap(t *testing.T) {
	h := NewWithLimits(100, 2)
	for i := range 2 {
		if _, err := h.Subscribe("same", []string{"133"}); err != nil {
			t.Fatalf("subscribe %d: %v", i, err)
		}
	}
	_, err := h.Subscribe("same", []string{"133"})
	var capacity *ErrAtCapacity
	if !errors.As(err, &capacity) || !capacity.PerClient {
		t.Fatalf("err = %v, want a per-client ErrAtCapacity", err)
	}
	// A different client must still get in: one noisy host may not lock out
	// everybody else.
	if _, err := h.Subscribe("other", []string{"133"}); err != nil {
		t.Errorf("a different client was refused: %v", err)
	}
}

// Disconnecting must return the slot, or the server bleeds capacity until restart.
func TestUnsubscribeReleasesCapacity(t *testing.T) {
	h := NewWithLimits(1, 1)
	sub := mustSubscribe(t, h, "c1", "133")
	if _, err := h.Subscribe("c2", []string{"133"}); err == nil {
		t.Fatal("second connection accepted despite a cap of 1")
	}
	h.Unsubscribe(sub)
	if _, err := h.Subscribe("c2", []string{"133"}); err != nil {
		t.Errorf("capacity was not released on unsubscribe: %v", err)
	}
}

// The per-client tally must not accumulate an entry for every address that ever
// connected; that is a slow leak on a long-running public server.
func TestPerClientTallyDoesNotLeak(t *testing.T) {
	h := NewWithLimits(100, 5)
	for i := range 50 {
		client := "client-" + string(rune('a'+i%26)) + string(rune('a'+i/26))
		sub := mustSubscribe(t, h, client, "133")
		h.Unsubscribe(sub)
	}
	h.mu.RLock()
	remaining := len(h.perClient)
	h.mu.RUnlock()
	if remaining != 0 {
		t.Errorf("perClient retained %d entries after every client left", remaining)
	}
}

func TestZeroLimitsFallBackToDefaults(t *testing.T) {
	h := NewWithLimits(0, -1)
	if _, max := h.Capacity(); max != DefaultMaxConnections {
		t.Errorf("max connections = %d, want the default %d", max, DefaultMaxConnections)
	}
}
