// Package poller keeps one live picture of the network for every client.
//
// This is where the load argument is settled. Unbatched, one phone on the trip
// screen can issue ~50 requests a minute to RTL, so N clients cost N times that.
// Here, one loop per route serves everyone — but a naive "poll all 15 routes
// every 3 s" would be 300 requests a minute even with nobody connected, which is
// worse than the status quo below roughly seven concurrent users. So the
// interval follows demand: tight for routes someone is actually watching, and
// nothing at all overnight when no bus reports.
//
// It does not follow demand all the way down, though. Every poll also feeds the
// recorder, and an archive whose resolution tracks route popularity is not one
// you can compare buckets across, so the unwatched interval is a floor set by
// the upstream cadence rather than by whether anyone is looking. See
// IdleInterval.
package poller

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/mismaah/rtl-improved/server/internal/geo"
	"github.com/mismaah/rtl-improved/server/internal/hub"
	"github.com/mismaah/rtl-improved/server/internal/rtl"
	"github.com/mismaah/rtl-improved/server/internal/store"
	"github.com/mismaah/rtl-improved/server/internal/track"
)

// Intervals. See the package comment for why these are demand-led.
const (
	// WatchedInterval applies to routes with at least one live subscriber.
	// Measured upstream cadence is ~11 s, so this is not about collecting more
	// positions — there are none — but about noticing one promptly.
	WatchedInterval = 3 * time.Second
	// IdleInterval is the recording floor: how often a route nobody is watching
	// is still polled, so that the history being built does not depend on who
	// happened to be looking at the time.
	//
	// Matched to the ~11 s upstream cadence rather than set by demand. At 20 s
	// the first day's archive came out under-sampled roughly 2x — recorded gaps
	// clustered at 15–30 s against a feed publishing every 11 — and worse for
	// less popular routes, which is exactly backwards for a corpus meant to be
	// uniform. Demand-led intervals are right for *serving* clients and wrong
	// for *building* one.
	//
	// The cost is ~84 req/min for 14 routes (1.4 req/s) against ~42 before,
	// still inside the 3 req/s that upstream was measured to sustain without
	// failures. Do not tighten it past the upstream cadence: below ~11 s the
	// extra requests return coordinates that have not changed.
	IdleInterval = 10 * time.Second
	// ETAs change roughly once per 30 s upstream, so this loses nothing.
	EtaInterval = 15 * time.Second
)

// Service hours in Malé local time. Outside these no bus reports, and polling an
// empty feed all night is pure waste.
const (
	ServiceStartHour = 4
	ServiceEndHour   = 1 // exclusive, next day
)

// TrackMaxAge is how old a position may be and still be handed to a client.
//
// This matters most overnight. Polling stops at 01:00, so without an age bound
// the in-memory tracks would sit there until morning and a client connecting at
// 02:00 would receive last night's fleet as its opening snapshot — presented
// like a live picture, and inconsistent with /v1/live, which refuses a position
// older than 30 seconds.
//
// Comfortably longer than the idle poll interval, so an unwatched route's
// perfectly good position is never discarded for being one cycle old.
const TrackMaxAge = 5 * time.Minute

// Poller maintains live tracks for every route.
type Poller struct {
	rtl   *rtl.Client
	hub   *hub.Hub
	store *store.DB
	log   *slog.Logger

	mu     sync.RWMutex
	tracks map[string]map[string]*track.Track // routeCode -> busCode -> track
	shapes map[string][][]geo.Point           // routeCode -> polylines
	stops  map[string][]rtl.Stop              // routeCode -> stops in route order

	routes atomic.Pointer[[]string]
}

func New(client *rtl.Client, broker *hub.Hub, db *store.DB, log *slog.Logger) *Poller {
	if log == nil {
		log = slog.Default()
	}
	p := &Poller{
		rtl:    client,
		hub:    broker,
		store:  db,
		log:    log,
		tracks: make(map[string]map[string]*track.Track),
		shapes: make(map[string][][]geo.Point),
		stops:  make(map[string][]rtl.Stop),
	}
	empty := []string{}
	p.routes.Store(&empty)
	return p
}

// Tracks returns one route's current tracks, for the SSE handler to send on
// connect. This is the cold-start fix: without it a client must poll twice and
// watch a bus travel 12 m before it can draw an arrow, and it discards that
// history whenever the route changes.
//
// Positions older than TrackMaxAge are withheld rather than served as though
// they were current. An empty snapshot is the honest answer at 3am.
func (p *Poller) Tracks(routeCode string) []*track.Track {
	return p.tracksAt(routeCode, time.Now().UnixMilli())
}

// tracksAt is Tracks with the clock injected, so staleness is testable.
func (p *Poller) tracksAt(routeCode string, nowMs int64) []*track.Track {
	p.mu.RLock()
	defer p.mu.RUnlock()

	byBus := p.tracks[routeCode]
	out := make([]*track.Track, 0, len(byBus))
	for _, t := range byBus {
		if nowMs-t.UpdatedAt > TrackMaxAge.Milliseconds() {
			continue
		}
		clone := *t
		out = append(out, &clone)
	}
	return out
}

// pruneStaleTracks drops positions too old to serve, so the fleet does not sit
// in memory all night waiting for a morning that will replace it anyway.
func (p *Poller) pruneStaleTracks(nowMs int64) int {
	p.mu.Lock()
	defer p.mu.Unlock()

	dropped := 0
	for routeCode, byBus := range p.tracks {
		for busCode, t := range byBus {
			if nowMs-t.UpdatedAt > TrackMaxAge.Milliseconds() {
				delete(byBus, busCode)
				dropped++
			}
		}
		if len(byBus) == 0 {
			delete(p.tracks, routeCode)
		}
	}
	return dropped
}

// Run discovers the route list, loads geometry, and polls until ctx is done.
func (p *Poller) Run(ctx context.Context) {
	if err := p.loadRoutes(ctx); err != nil {
		p.log.Error("could not load routes; poller idle until next attempt", "err", err)
	}

	// Routes and geometry change about never, but a daily refresh costs nothing
	// and picks up a new route without a restart.
	go p.refreshRoutesDaily(ctx)
	go p.pollEtas(ctx)

	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	lastPolled := make(map[string]time.Time)
	var lastPruned time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			// Runs regardless of service hours: expiring last night's positions
			// is exactly what needs to happen while nothing is being polled.
			if now.Sub(lastPruned) >= time.Minute {
				lastPruned = now
				if dropped := p.pruneStaleTracks(now.UnixMilli()); dropped > 0 {
					p.log.Debug("dropped stale tracks", "count", dropped)
				}
			}
			if !inServiceHours(now) {
				continue
			}
			watched := p.hub.RouteSubscribers()
			for _, routeCode := range *p.routes.Load() {
				interval := IdleInterval
				if watched[routeCode] > 0 {
					interval = WatchedInterval
				}
				if now.Sub(lastPolled[routeCode]) < interval {
					continue
				}
				lastPolled[routeCode] = now
				go p.pollRoute(ctx, routeCode)
			}
		}
	}
}

// inServiceHours reports whether buses are plausibly running, in Malé civil
// time (UTC+05:00, no DST — matching serviceDate() in src/lib/time.ts).
func inServiceHours(now time.Time) bool {
	hour := now.UTC().Add(5 * time.Hour).Hour()
	return hour >= ServiceStartHour || hour < ServiceEndHour
}
