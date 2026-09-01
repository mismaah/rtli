// Package hub fans live updates out to connected clients.
//
// Why push at all, given the measured facts: a bus's position advances on a ~11 s
// cycle, so polling faster collects nothing extra. But a 10 s poll lands at a
// random phase against an 11 s cycle, leaving a client's view ~5.5 s stale on
// average and up to 11 s at worst. At the measured 64 m of movement per update
// that is roughly 30 m of error. The server polls tightly and pushes, so a
// client learns of a new fix within a second or so of it existing.
//
// SSE rather than WebSocket: the traffic is entirely server-to-client,
// EventSource brings reconnection and Last-Event-ID for free, and there is no
// bidirectional requirement anywhere in the app.
package hub

import (
	"sync"
	"sync/atomic"
)

// Event is one message bound for subscribers.
type Event struct {
	// ID is monotonic per hub, so a reconnecting client can say where it left
	// off via Last-Event-ID.
	ID uint64
	// Name is the SSE event type: "snapshot", "bus", "etas" or "ping".
	Name string
	// RouteCode this concerns; empty means every subscriber gets it.
	RouteCode string
	// Data is the already-encoded JSON payload.
	Data []byte
}

// bufferSize is per subscriber. Measured event rates are low — around 0.45 bus
// events a second for a five-bus route — so this is minutes of slack. A client
// that cannot keep up with even this is not one worth stalling the hub for.
const bufferSize = 64

// Subscriber is one connected client.
type Subscriber struct {
	events chan Event
	routes map[string]struct{}
	client string
	mu     sync.RWMutex
	// dropped counts events discarded because the buffer was full, so a
	// struggling connection is visible rather than silently lossy.
	dropped atomic.Uint64
}

// Events is the stream to write to the client.
func (s *Subscriber) Events() <-chan Event { return s.events }

// Dropped reports how many events this subscriber missed.
func (s *Subscriber) Dropped() uint64 { return s.dropped.Load() }

// wants reports whether this subscriber cares about an event's route.
func (s *Subscriber) wants(routeCode string) bool {
	if routeCode == "" {
		return true
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.routes[routeCode]
	return ok
}

// Connection limits.
//
// This endpoint is public and unauthenticated, so an open-ended number of
// long-lived connections is a memory-exhaustion invitation. Cloudflare sits in
// front and handles volumetric abuse; these are the backstop that keeps one
// determined client from taking the server down.
const (
	// DefaultMaxConnections across the whole server. At ~4 KB of buffer each
	// this is a few megabytes — generous for a 15-route network in one city.
	DefaultMaxConnections = 500
	// DefaultMaxPerClient is deliberately loose. Malé's mobile carriers use
	// carrier-grade NAT, so a great many real riders share one source address;
	// a tight per-client cap would lock out a whole network rather than an
	// abuser. This stops one host opening thousands, nothing subtler.
	DefaultMaxPerClient = 20
)

// ErrAtCapacity is returned when a subscription would exceed a limit.
type ErrAtCapacity struct{ PerClient bool }

func (e *ErrAtCapacity) Error() string {
	if e.PerClient {
		return "too many connections from this client"
	}
	return "server at connection capacity"
}

// Hub broadcasts events to subscribers, filtered by route.
type Hub struct {
	maxConnections int
	maxPerClient   int

	mu          sync.RWMutex
	subscribers map[*Subscriber]struct{}
	perClient   map[string]int
	nextID      atomic.Uint64
}

// New returns a hub with the default limits. Zero or negative values fall back
// to the defaults, so a misconfiguration cannot accidentally disable the cap.
func New() *Hub { return NewWithLimits(DefaultMaxConnections, DefaultMaxPerClient) }

func NewWithLimits(maxConnections, maxPerClient int) *Hub {
	if maxConnections <= 0 {
		maxConnections = DefaultMaxConnections
	}
	if maxPerClient <= 0 {
		maxPerClient = DefaultMaxPerClient
	}
	return &Hub{
		maxConnections: maxConnections,
		maxPerClient:   maxPerClient,
		subscribers:    make(map[*Subscriber]struct{}),
		perClient:      make(map[string]int),
	}
}

// Subscribe registers a client interested in the given routes.
//
// client identifies the connecting host for the per-client cap; see RealIP in
// the api package for why that cannot simply be RemoteAddr here.
func (h *Hub) Subscribe(client string, routes []string) (*Subscriber, error) {
	set := make(map[string]struct{}, len(routes))
	for _, r := range routes {
		set[r] = struct{}{}
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	if len(h.subscribers) >= h.maxConnections {
		return nil, &ErrAtCapacity{}
	}
	if h.perClient[client] >= h.maxPerClient {
		return nil, &ErrAtCapacity{PerClient: true}
	}

	sub := &Subscriber{events: make(chan Event, bufferSize), routes: set, client: client}
	h.subscribers[sub] = struct{}{}
	h.perClient[client]++
	return sub, nil
}

// Unsubscribe removes a client and closes its stream. Safe to call twice.
func (h *Hub) Unsubscribe(sub *Subscriber) {
	h.mu.Lock()
	_, present := h.subscribers[sub]
	if present {
		delete(h.subscribers, sub)
		// Drop the key entirely at zero, or the map becomes a slow leak of every
		// address that ever connected.
		if h.perClient[sub.client]--; h.perClient[sub.client] <= 0 {
			delete(h.perClient, sub.client)
		}
	}
	h.mu.Unlock()
	if present {
		close(sub.events)
	}
}

// Publish fans an event out to every interested subscriber.
//
// Never blocks: a subscriber whose buffer is full has the event dropped and
// counted. One stalled client must not be able to hold up the poller, and
// therefore every other client, behind it.
func (h *Hub) Publish(name, routeCode string, data []byte) {
	event := Event{ID: h.nextID.Add(1), Name: name, RouteCode: routeCode, Data: data}

	h.mu.RLock()
	defer h.mu.RUnlock()
	for sub := range h.subscribers {
		if !sub.wants(routeCode) {
			continue
		}
		select {
		case sub.events <- event:
		default:
			sub.dropped.Add(1)
		}
	}
}

// RouteSubscribers reports how many clients are watching each route. The poller
// reads this to decide which routes deserve a tight interval and which only need
// to be sampled often enough to keep the history fed.
func (h *Hub) RouteSubscribers() map[string]int {
	h.mu.RLock()
	defer h.mu.RUnlock()

	counts := make(map[string]int)
	for sub := range h.subscribers {
		sub.mu.RLock()
		for route := range sub.routes {
			counts[route]++
		}
		sub.mu.RUnlock()
	}
	return counts
}

// Len reports the number of connected subscribers.
func (h *Hub) Len() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subscribers)
}

// Capacity reports current and maximum connections, for /v1/meta.
func (h *Hub) Capacity() (used, max int) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subscribers), h.maxConnections
}
