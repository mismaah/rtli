// Package api serves the read-only HTTP surface.
//
// Every endpoint here is a cache in front of RTL, never a source of truth the
// client depends on: when this server is unreachable the app falls back to
// calling RTL directly, so nothing served here may be something the client
// cannot also derive on its own.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/mismaah/rtl-improved/server/internal/cache"
	"github.com/mismaah/rtl-improved/server/internal/geo"
	"github.com/mismaah/rtl-improved/server/internal/hub"
	"github.com/mismaah/rtl-improved/server/internal/rtl"
	"github.com/mismaah/rtl-improved/server/internal/track"
)

// Cache lifetimes, chosen against measured upstream behaviour rather than
// guessed. Each has a TTL — how long an entry is served without asking again —
// and a stale bound: how far past that it may still be served when upstream is
// unreachable, before the request is failed so the client can fall back to RTL
// or to its own saved snapshot instead.
const (
	// RTL republishes routedetails rarely, and what it does change through the
	// day is that past departures drop off — so a slightly older copy is more
	// complete than a fresh one, not less. Five minutes is chosen against
	// GraphWarmInterval below rather than against how fast the data moves: the
	// entry is refreshed off the request path, and the TTL only has to outlive
	// the gap between those refreshes.
	graphTTL = 5 * time.Minute
	// Routes and stops are effectively static and the timetable covers the whole
	// day, so hours-old data is still true. Bounded well inside a service day so
	// it can never present yesterday as today.
	graphMaxStale = 6 * time.Hour

	// Route geometry does not change. The TTL only bounds memory growth, and
	// stale geometry is simply correct geometry.
	shapeTTL      = 24 * time.Hour
	shapeMaxStale = 7 * 24 * time.Hour

	// Measured: ETA rows change roughly once per 30 s, so 10 s cannot lose a
	// transition a client would otherwise have seen.
	etasTTL = 10 * time.Second
	// A countdown is only true near when it was read. A minute out is already
	// misleading; beyond that, no ETA is far better than a wrong one.
	etasMaxStale = 60 * time.Second

	// Measured: a bus's position advances on a ~11 s cycle. 2 s is not about
	// collecting more positions — there are none — but about noticing a new one
	// promptly, which is what shrinks the staleness a rider sees.
	liveTTL = 2 * time.Second
	// A bus drawn where it was half a minute ago is a bus in the wrong place.
	liveMaxStale = 30 * time.Second
)

// GraphWarmInterval is how often WarmGraph refreshes the graph entry. Inside
// graphTTL, so a client arriving at any moment finds one already there.
const GraphWarmInterval = graphTTL - 30*time.Second

// Server holds the upstream client and the caches shared by all requests.
type Server struct {
	rtl *rtl.Client
	log *slog.Logger
	// origins is the CORS allowlist. Empty means echo any origin.
	origins    []string
	trustProxy bool

	graph  *cache.Cache[json.RawMessage]
	shapes *cache.Cache[json.RawMessage]
	etas   *cache.Cache[*rtl.StopsEta]
	live   *cache.Cache[*rtl.LiveCoordinates]

	startedAt time.Time

	// Optional: set when live streaming is enabled. Without them the server is
	// still a perfectly good read-through cache.
	hub    *hub.Hub
	poller LiveTracks
}

// LiveTracks is the poller's read side, kept as an interface so the API package
// does not depend on the poller's internals (and so it is trivial to fake).
type LiveTracks interface {
	Tracks(routeCode string) []*track.Track
}

// Options configures a Server.
type Options struct {
	RTL *rtl.Client
	Log *slog.Logger
	// AllowOrigin is a comma-separated CORS allowlist, e.g.
	// "https://rtl.pages.dev,https://rtl.example.com". "*" allows any origin,
	// which is safe in the sense that nothing here is authenticated or
	// user-specific, but naming the real front end keeps this server from
	// quietly becoming someone else's free backend.
	AllowOrigin string
	// TrustProxyHeaders makes CF-Connecting-IP and X-Forwarded-For authoritative
	// for client identity. Set this only when the sole route to the server is
	// through that proxy — a Cloudflare Tunnel, say. On a directly reachable
	// port it lets anyone forge an identity per request and walk past the caps.
	TrustProxyHeaders bool
	// Hub and Poller enable /v1/live/stream. Both or neither.
	Hub    *hub.Hub
	Poller LiveTracks
}

func NewServer(opts Options) *Server {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.AllowOrigin == "" {
		opts.AllowOrigin = "*"
	}
	var origins []string
	if opts.AllowOrigin != "*" {
		for field := range strings.SplitSeq(opts.AllowOrigin, ",") {
			if origin := strings.TrimSpace(field); origin != "" {
				origins = append(origins, origin)
			}
		}
	}
	return &Server{
		rtl:        opts.RTL,
		log:        opts.Log,
		origins:    origins,
		trustProxy: opts.TrustProxyHeaders,
		graph:      cache.New[json.RawMessage](graphTTL, graphMaxStale),
		shapes:     cache.New[json.RawMessage](shapeTTL, shapeMaxStale),
		etas:       cache.New[*rtl.StopsEta](etasTTL, etasMaxStale),
		live:       cache.New[*rtl.LiveCoordinates](liveTTL, liveMaxStale),
		startedAt:  time.Now(),
		hub:        opts.Hub,
		poller:     opts.Poller,
	}
}

// Handler returns the routed, CORS-wrapped handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /v1/meta", s.handleMeta)
	mux.HandleFunc("GET /v1/graph", s.handleGraph)
	mux.HandleFunc("GET /v1/shapes/{routeCode}", s.handleShape)
	mux.HandleFunc("GET /v1/etas", s.handleEtas)
	mux.HandleFunc("GET /v1/live/stream", s.handleLiveStream)
	mux.HandleFunc("GET /v1/live/{routeCode}", s.handleLive)
	return s.withCORS(mux)
}

// allowOrigin returns the value to echo back, and whether the origin is allowed.
//
// With no allowlist configured any origin is echoed. With one, only a listed
// origin is answered — and the echo is the request's own origin rather than the
// list, because Access-Control-Allow-Origin takes exactly one value.
func (s *Server) allowOrigin(requestOrigin string) (string, bool) {
	if len(s.origins) == 0 {
		return "*", true
	}
	for _, allowed := range s.origins {
		if requestOrigin == allowed {
			return requestOrigin, true
		}
	}
	return "", false
}

// withCORS answers preflights and tags every response. The front end is served
// from another origin entirely, so without this nothing reaches the browser.
func (s *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Always vary on Origin: with an allowlist the response genuinely
		// differs per origin, and a shared cache must not blur them together.
		w.Header().Set("Vary", "Origin")
		if origin, ok := s.allowOrigin(r.Header.Get("Origin")); ok {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Max-Age", "86400")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, "no-store", map[string]any{
		"ok":        true,
		"uptimeSec": int(time.Since(s.startedAt).Seconds()),
	})
}

// handleMeta reports what the server currently holds, so the client can be
// honest with the rider about where its data came from and how old it is.
func (s *Server) handleMeta(w http.ResponseWriter, r *http.Request) {
	meta := map[string]any{"uptimeSec": int(time.Since(s.startedAt).Seconds())}
	if entry, ok := s.graph.Peek(graphKey); ok {
		meta["graphAgeMs"] = time.Since(entry.StoredAt).Milliseconds()
	}
	if s.hub != nil {
		used, max := s.hub.Capacity()
		meta["streams"] = map[string]int{"open": used, "max": max}
	}
	writeJSON(w, r, http.StatusOK, "no-store", meta)
}

const graphKey = "routedetails"

// handleGraph serves routes, stops and timetables in RTL's own JSON shape.
//
// Deliberately the same shape rather than a prebuilt graph: buildGraph.ts stays
// the single normalizer, so the server and the client's direct-to-RTL fallback
// can never disagree about what a route is.
func (s *Server) handleGraph(w http.ResponseWriter, r *http.Request) {
	payload, err := s.graphPayload(r.Context())
	if err != nil {
		s.fail(w, r, "graph", err)
		return
	}
	writeRaw(w, r, "public, max-age=60, stale-while-revalidate=600", payload)
}

// graphPayload returns the cached routedetails, fetching them when the entry
// has expired.
func (s *Server) graphPayload(ctx context.Context) (json.RawMessage, error) {
	payload, _, err := s.graph.Get(ctx, graphKey, s.loadGraph)
	return payload, err
}

func (s *Server) loadGraph(ctx context.Context) (json.RawMessage, error) {
	details, err := s.rtl.RouteDetails(ctx)
	if err != nil {
		return nil, err
	}
	return json.Marshal(details)
}

// WarmGraph keeps the graph cached ahead of demand until ctx is done.
//
// Without it the first visitor after a quiet few minutes pays for the upstream
// fetch inside their own page load, and that is the least forgiving request in
// a session: the graph is what the app opens with, the client abandons a slow
// backend for RTL, and it then holds that decision until the page is reloaded.
// A ticker moves the cost off the request path entirely for ~320 upstream
// requests a day, against the ~130k the poller already makes.
//
// Failures are logged and retried on the next tick rather than escalated. A
// warm that cannot reach RTL leaves the previous entry in place, which is
// exactly what graphMaxStale exists to allow.
//
// Refresh rather than Get, deliberately: Get would find the entry still inside
// its TTL and leave it alone, so a tick would do nothing until the entry had
// already expired — and waiting for the expiry is the whole thing this exists
// to prevent.
func (s *Server) WarmGraph(ctx context.Context) {
	s.warmGraph(ctx, GraphWarmInterval)
}

// warmGraph is WarmGraph with the interval injected, so a test does not have to
// wait out the real one.
func (s *Server) warmGraph(ctx context.Context, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		if err := s.graph.Refresh(ctx, graphKey, s.loadGraph); err != nil && ctx.Err() == nil {
			s.log.Warn("could not warm the graph cache", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// handleShape serves one route's geometry, already simplified.
func (s *Server) handleShape(w http.ResponseWriter, r *http.Request) {
	routeCode := r.PathValue("routeCode")
	if !validRouteCode(routeCode) {
		writeError(w, r, http.StatusBadRequest, "routeCode must be 1-8 alphanumeric characters")
		return
	}

	payload, _, err := s.shapes.Get(r.Context(), routeCode, func(ctx context.Context) (json.RawMessage, error) {
		shape, err := s.rtl.RoadShape(ctx, routeCode)
		if err != nil {
			return nil, err
		}
		simplified, err := geo.SimplifyFeatureCollection(shape.RoadShape, geo.DefaultSimplifyEpsilon)
		if err != nil {
			// Simplification is an optimization; never fail a request over it.
			s.log.Warn("shape simplification failed, serving verbatim",
				"routeCode", routeCode, "err", err)
			simplified = shape.RoadShape
		}
		return json.Marshal(rtl.RoadShape{RoadShape: simplified})
	})
	if err != nil {
		s.fail(w, r, "shape", err)
		return
	}
	writeRaw(w, r, "public, max-age=2592000, immutable", payload)
}

// EtasResponse is one batched answer covering several routes.
//
// The rows are RTL's verbatim strings, not parsed minutes, so parseEta.ts stays
// the one place an ETA is interpreted. AgeMs lets the client correct for however
// long this server has been holding the reading, since a countdown read 8
// seconds ago is 8 seconds wrong.
type EtasResponse struct {
	Routes map[string]*EtaRoute `json:"routes"`
}

type EtaRoute struct {
	InboundStopsETAList  []rtl.StopEta `json:"inboundStopsETAList"`
	OutboundStopsETAList []rtl.StopEta `json:"outboundStopsETAList"`
	AgeMs                int64         `json:"ageMs"`
}

// maxBatchRoutes caps one request at the whole network.
const maxBatchRoutes = 15

// handleEtas collapses the client's per-route fan-out into one request.
//
// A route that fails upstream is simply absent from the response, never an
// error: a missing ETA must not cost a rider their itinerary.
func (s *Server) handleEtas(w http.ResponseWriter, r *http.Request) {
	codes, err := parseRouteCodes(r.URL.Query().Get("routes"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	if len(codes) == 0 {
		writeJSON(w, r, http.StatusOK, "no-store", EtasResponse{Routes: map[string]*EtaRoute{}})
		return
	}

	var (
		mu     sync.Mutex
		result = make(map[string]*EtaRoute, len(codes))
		wg     sync.WaitGroup
	)
	for _, code := range codes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			etas, _, err := s.etas.Get(r.Context(), code, func(ctx context.Context) (*rtl.StopsEta, error) {
				return s.rtl.StopEtas(ctx, code)
			})
			if err != nil || etas == nil {
				return
			}
			var age int64
			if entry, ok := s.etas.Peek(code); ok {
				age = time.Since(entry.StoredAt).Milliseconds()
			}
			mu.Lock()
			result[code] = &EtaRoute{
				// Normalized to empty rather than null: RTL sends null for
				// outbound on every route, and this endpoint's contract is
				// easier to consume if a list is always a list.
				InboundStopsETAList:  orEmpty(etas.InboundStopsETAList),
				OutboundStopsETAList: orEmpty(etas.OutboundStopsETAList),
				AgeMs:                age,
			}
			mu.Unlock()
		}()
	}
	wg.Wait()

	writeJSON(w, r, http.StatusOK, "public, max-age=10", EtasResponse{Routes: result})
}

// handleLive serves current bus positions for one route.
//
// This is the plain-JSON form, kept as the fallback for clients that cannot hold
// an SSE stream open and as the shape the service worker can reason about. It is
// never served stale beyond its short TTL: a bus position that is wrong is worse
// than one that is missing.
func (s *Server) handleLive(w http.ResponseWriter, r *http.Request) {
	routeCode := r.PathValue("routeCode")
	if !validRouteCode(routeCode) {
		writeError(w, r, http.StatusBadRequest, "routeCode must be 1-8 alphanumeric characters")
		return
	}

	live, _, err := s.live.Get(r.Context(), routeCode, func(ctx context.Context) (*rtl.LiveCoordinates, error) {
		return s.rtl.LiveCoordinates(ctx, routeCode)
	})
	if err != nil {
		s.fail(w, r, "live", err)
		return
	}

	buses := live.BusList
	if buses == nil {
		buses = []rtl.Bus{}
	}
	var age int64
	if entry, ok := s.live.Peek(routeCode); ok {
		age = time.Since(entry.StoredAt).Milliseconds()
	}
	writeJSON(w, r, http.StatusOK, "no-store", map[string]any{
		"busList": buses,
		"ageMs":   age,
	})
}

func orEmpty(rows []rtl.StopEta) []rtl.StopEta {
	if rows == nil {
		return []rtl.StopEta{}
	}
	return rows
}

func (s *Server) fail(w http.ResponseWriter, r *http.Request, op string, err error) {
	if errors.Is(err, context.Canceled) {
		return // The client went away; nothing to report.
	}
	s.log.Warn("upstream request failed", "op", op, "err", err)
	writeError(w, r, http.StatusBadGateway, "could not reach the RTL bus service")
}
