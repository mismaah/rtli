package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mismaah/rtl-improved/server/internal/hub"
	"github.com/mismaah/rtl-improved/server/internal/rtl"
	"github.com/mismaah/rtl-improved/server/internal/track"
)

// fakeUpstream stands in for RTL and counts what it is asked for, which is how
// the fan-in claim gets verified rather than assumed.
type fakeUpstream struct {
	server *httptest.Server
	hits   sync.Map // path -> *atomic.Int32
}

func newFakeUpstream(t *testing.T) *fakeUpstream {
	t.Helper()
	f := &fakeUpstream{}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		counter, _ := f.hits.LoadOrStore(r.URL.Path, &atomic.Int32{})
		counter.(*atomic.Int32).Add(1)

		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/routedetails"):
			fmt.Fprint(w, `{"routeResponse":[{"id":1,"code":"133","routeNumber":"R1","name":"West Park to HM Phase 1","dvname":"","busRouteStopList":[{"id":7044,"order":1,"name":"Maafannu Bus Terminal","dvname":"","code":"103","latitude":"4.169366","longitude":"73.504676","timings":[{"order":45,"timing":"16:45:00"}]}],"isMiniBusRoute":0,"fare":10.0,"isDistanceFareType":0}]}`)
		case strings.HasSuffix(r.URL.Path, "/roadshape"):
			fmt.Fprint(w, `{"roadShape":{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"LineString","coordinates":[[73.5,4.1],[73.5000001,4.1000001],[73.6,4.2]]}}]}}`)
		case strings.HasSuffix(r.URL.Path, "/livecoordinates"):
			fmt.Fprint(w, `{"busList":[{"busCode":"C1","plateNumber":"C1","latitude":4.1,"longitude":73.5}]}`)
		case strings.HasSuffix(r.URL.Path, "/all-stops-of-route"):
			var req struct {
				RouteCode string `json:"routeCode"`
			}
			_ = json.Unmarshal(body, &req)
			fmt.Fprintf(w, `{"inboundStopsETAList":[{"eta":"5 Minutes ","vehicleCode":"C1","stopName":"S","stopCode":"103","stopOrder":1,"routeCode":%q,"routeNumber":null,"routeName":"R","destination":"D","direction":"I"}],"outboundStopsETAList":null}`, req.RouteCode)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeUpstream) count(suffix string) int32 {
	var total int32
	f.hits.Range(func(key, value any) bool {
		if strings.HasSuffix(key.(string), suffix) {
			total += value.(*atomic.Int32).Load()
		}
		return true
	})
	return total
}

func newTestServer(t *testing.T) (*httptest.Server, *fakeUpstream) {
	t.Helper()
	upstream := newFakeUpstream(t)
	srv := NewServer(Options{RTL: rtl.NewClient(upstream.server.URL)})
	front := httptest.NewServer(srv.Handler())
	t.Cleanup(front.Close)
	return front, upstream
}

func get(t *testing.T, url string, header http.Header) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	for k, v := range header {
		req.Header[k] = v
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res, body
}

// The central claim of this server: many clients, one upstream request.
func TestConcurrentClientsCollapseToOneUpstreamCall(t *testing.T) {
	front, upstream := newTestServer(t)

	var wg sync.WaitGroup
	for range 40 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, _ := get(t, front.URL+"/v1/graph", nil)
			if res.StatusCode != http.StatusOK {
				t.Errorf("status = %d, want 200", res.StatusCode)
			}
		}()
	}
	wg.Wait()

	if got := upstream.count("/routedetails"); got != 1 {
		t.Fatalf("40 concurrent clients caused %d upstream calls, want 1", got)
	}
}

// The graph is the one request a page load opens with, and a client that finds
// it cold gives up on this server and talks to RTL for the rest of its session.
// So it must be warm before anyone asks, not merely cheap once someone has.
func TestWarmGraphFillsTheCacheBeforeTheFirstRequest(t *testing.T) {
	upstream := newFakeUpstream(t)
	srv := NewServer(Options{RTL: rtl.NewClient(upstream.server.URL)})
	front := httptest.NewServer(srv.Handler())
	t.Cleanup(front.Close)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go srv.WarmGraph(ctx)

	deadline := time.Now().Add(2 * time.Second)
	for upstream.count("/routedetails") == 0 {
		if time.Now().After(deadline) {
			t.Fatal("WarmGraph never fetched the graph")
		}
		time.Sleep(5 * time.Millisecond)
	}

	res, _ := get(t, front.URL+"/v1/graph", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if got := upstream.count("/routedetails"); got != 1 {
		t.Fatalf("upstream calls = %d, want 1: the request should have been served warm", got)
	}
}

// Every tick must actually go upstream. Warming with a plain cache read would
// find the entry still inside its five-minute TTL and leave it there, so the
// entry would go on ageing until it expired — putting the wait back on whoever
// arrived next, which is the whole thing this is here to prevent.
func TestWarmGraphRefreshesAnEntryThatHasNotExpired(t *testing.T) {
	upstream := newFakeUpstream(t)
	srv := NewServer(Options{RTL: rtl.NewClient(upstream.server.URL)})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go srv.warmGraph(ctx, 20*time.Millisecond)

	deadline := time.Now().Add(2 * time.Second)
	for upstream.count("/routedetails") < 3 {
		if time.Now().After(deadline) {
			t.Fatalf("upstream fetches = %d, want the ticker to keep refreshing",
				upstream.count("/routedetails"))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// The refresh has to land inside the lifetime of what it is refreshing, or
// there is a window in which a client still pays for the upstream fetch.
func TestGraphIsWarmedBeforeItExpires(t *testing.T) {
	if GraphWarmInterval >= graphTTL {
		t.Fatalf("GraphWarmInterval %v must be shorter than graphTTL %v", GraphWarmInterval, graphTTL)
	}
}

func TestGraphPreservesUpstreamShape(t *testing.T) {
	front, _ := newTestServer(t)
	_, body := get(t, front.URL+"/v1/graph", nil)

	var details rtl.RouteDetails
	if err := json.Unmarshal(body, &details); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(details.RouteResponse) != 1 {
		t.Fatalf("routes = %d, want 1", len(details.RouteResponse))
	}
	route := details.RouteResponse[0]
	if route.Code != "133" || route.RouteNumber != "R1" {
		t.Errorf("code/routeNumber = %q/%q, want 133/R1", route.Code, route.RouteNumber)
	}
	// The client's buildGraph accepts string coordinates; re-serving them as
	// numbers would be a silent contract break.
	if !strings.Contains(string(body), `"latitude":"4.169366"`) {
		t.Error("latitude was not re-served as a string")
	}
}

func TestETagRevalidationReturns304(t *testing.T) {
	front, _ := newTestServer(t)

	res, body := get(t, front.URL+"/v1/graph", nil)
	etag := res.Header.Get("ETag")
	if etag == "" {
		t.Fatal("no ETag on first response")
	}

	res2, body2 := get(t, front.URL+"/v1/graph", http.Header{"If-None-Match": {etag}})
	if res2.StatusCode != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", res2.StatusCode)
	}
	if len(body2) != 0 {
		t.Errorf("304 carried %d bytes of body", len(body2))
	}
	if len(body) == 0 {
		t.Error("first response was empty")
	}
}

func TestShapeIsSimplified(t *testing.T) {
	front, _ := newTestServer(t)
	_, body := get(t, front.URL+"/v1/shapes/133", nil)

	var out struct {
		RoadShape struct {
			Features []struct {
				Geometry struct {
					Coordinates [][2]float64 `json:"coordinates"`
				} `json:"geometry"`
			} `json:"features"`
		} `json:"roadShape"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	coords := out.RoadShape.Features[0].Geometry.Coordinates
	// The middle point is collinear to within epsilon and must be dropped.
	if len(coords) != 2 {
		t.Fatalf("coordinates = %d, want 2 after simplification", len(coords))
	}
}

func TestBatchedEtasHitsEachRouteOnce(t *testing.T) {
	front, upstream := newTestServer(t)

	_, body := get(t, front.URL+"/v1/etas?routes=133,132,127", nil)
	var out EtasResponse
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out.Routes) != 3 {
		t.Fatalf("routes in response = %d, want 3", len(out.Routes))
	}
	if got := upstream.count("/all-stops-of-route"); got != 3 {
		t.Errorf("upstream ETA calls = %d, want 3", got)
	}
	// Null outbound from upstream must surface as an empty list, not null.
	for code, route := range out.Routes {
		if route.OutboundStopsETAList == nil {
			t.Errorf("route %s outbound is null, want []", code)
		}
		if len(route.InboundStopsETAList) != 1 {
			t.Errorf("route %s inbound = %d rows, want 1", code, len(route.InboundStopsETAList))
		}
		// ETA text must be verbatim so parseEta.ts stays the only interpreter.
		if got := route.InboundStopsETAList[0].Eta; got != "5 Minutes " {
			t.Errorf("eta = %q, want %q (verbatim, trailing space intact)", got, "5 Minutes ")
		}
	}
}

func TestDuplicateRouteCodesAreCollapsed(t *testing.T) {
	front, upstream := newTestServer(t)
	get(t, front.URL+"/v1/etas?routes=133,133,133", nil)
	if got := upstream.count("/all-stops-of-route"); got != 1 {
		t.Errorf("upstream calls = %d, want 1 for a repeated route", got)
	}
}

func TestRejectsMalformedInput(t *testing.T) {
	front, upstream := newTestServer(t)
	for _, path := range []string{
		"/v1/etas?routes=../etc/passwd",
		"/v1/etas?routes=133,%20%21bad",
		"/v1/shapes/bad!code",
	} {
		res, _ := get(t, front.URL+path, nil)
		if res.StatusCode != http.StatusBadRequest {
			t.Errorf("GET %s status = %d, want 400", path, res.StatusCode)
		}
	}
	if got := upstream.count("/roadshape") + upstream.count("/all-stops-of-route"); got != 0 {
		t.Errorf("malformed input reached upstream %d times, want 0", got)
	}
}

func TestCORSPreflight(t *testing.T) {
	front, _ := newTestServer(t)
	req, _ := http.NewRequestWithContext(t.Context(), http.MethodOptions, front.URL+"/v1/graph", nil)
	req.Header.Set("Origin", "https://example.test")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Errorf("status = %d, want 204", res.StatusCode)
	}
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Allow-Origin = %q, want *", got)
	}
}

// A route upstream refuses must be absent, never an error: a missing ETA can
// never be allowed to cost a rider their itinerary.
func TestFailedRouteIsOmittedNotFatal(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusInternalServerError)
	}))
	t.Cleanup(upstream.Close)

	srv := NewServer(Options{RTL: rtl.NewClient(upstream.URL)})
	front := httptest.NewServer(srv.Handler())
	t.Cleanup(front.Close)

	res, body := get(t, front.URL+"/v1/etas?routes=133", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 even when upstream fails", res.StatusCode)
	}
	var out EtasResponse
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out.Routes) != 0 {
		t.Errorf("routes = %d, want 0", len(out.Routes))
	}
}

// --- live streaming ---

type fakeTracks struct{ tracks []*track.Track }

func (f *fakeTracks) Tracks(string) []*track.Track { return f.tracks }

func newStreamingServer(t *testing.T) (*httptest.Server, *hub.Hub) {
	t.Helper()
	upstream := newFakeUpstream(t)
	broker := hub.New()
	heading := 90.0
	srv := NewServer(Options{
		RTL:    rtl.NewClient(upstream.server.URL),
		Hub:    broker,
		Poller: &fakeTracks{tracks: []*track.Track{{BusCode: "C1", Heading: &heading}}},
	})
	front := httptest.NewServer(srv.Handler())
	t.Cleanup(front.Close)
	return front, broker
}

// The literal /v1/live/stream must win over the /v1/live/{routeCode} wildcard.
// "stream" is a valid-looking route code, so a precedence slip would silently
// turn every stream request into an upstream lookup for a route named "stream".
func TestStreamPathBeatsRouteWildcard(t *testing.T) {
	front, _ := newStreamingServer(t)

	req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, front.URL+"/v1/live/stream?routes=133", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET stream: %v", err)
	}
	defer res.Body.Close()

	if got := res.Header.Get("Content-Type"); !strings.HasPrefix(got, "text/event-stream") {
		t.Fatalf("Content-Type = %q, want text/event-stream", got)
	}
}

func TestStreamSendsSnapshotThenDeltas(t *testing.T) {
	front, broker := newStreamingServer(t)

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, front.URL+"/v1/live/stream?routes=133", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET stream: %v", err)
	}
	defer res.Body.Close()

	reader := bufio.NewReader(res.Body)
	readFrame := func() string {
		var frame strings.Builder
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				t.Fatalf("read frame: %v", err)
			}
			if line == "\n" {
				return frame.String()
			}
			frame.WriteString(line)
		}
	}

	// The snapshot must arrive unprompted, carrying an already-inferred heading:
	// that is the whole cold-start fix.
	snapshot := readFrame()
	if !strings.Contains(snapshot, "event: snapshot") {
		t.Fatalf("first frame was not a snapshot:\n%s", snapshot)
	}
	if !strings.Contains(snapshot, `"heading":90`) {
		t.Errorf("snapshot lacks the pre-computed heading:\n%s", snapshot)
	}

	// Wait for the subscription to register before publishing to it.
	for range 100 {
		if broker.Len() > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	broker.Publish("bus", "133", []byte(`{"busCode":"C9"}`))

	delta := readFrame()
	if !strings.Contains(delta, "event: bus") || !strings.Contains(delta, "C9") {
		t.Errorf("expected a bus delta, got:\n%s", delta)
	}
	if !strings.Contains(delta, "id: ") {
		t.Errorf("delta carried no id, so Last-Event-ID resume cannot work:\n%s", delta)
	}
}

func TestStreamRejectsMissingRoutes(t *testing.T) {
	front, _ := newStreamingServer(t)
	res, _ := get(t, front.URL+"/v1/live/stream", nil)
	if res.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 when no routes are given", res.StatusCode)
	}
}

// Without a hub the server is still a valid cache; streaming just is not on.
func TestStreamUnavailableWithoutHub(t *testing.T) {
	front, _ := newTestServer(t)
	res, _ := get(t, front.URL+"/v1/live/stream?routes=133", nil)
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503 when streaming is disabled", res.StatusCode)
	}
}

func TestStreamDisconnectReleasesSubscriber(t *testing.T) {
	front, broker := newStreamingServer(t)

	ctx, cancel := context.WithCancel(t.Context())
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, front.URL+"/v1/live/stream?routes=133", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET stream: %v", err)
	}
	for range 100 {
		if broker.Len() > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	res.Body.Close()

	for range 200 {
		if broker.Len() == 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Errorf("subscriber still registered after disconnect (len=%d)", broker.Len())
}

// A refusal must arrive as a readable JSON error, not a truncated stream: the
// slot is claimed before any streaming header is written.
func TestStreamRefusedAtCapacityIsReadable(t *testing.T) {
	upstream := newFakeUpstream(t)
	srv := NewServer(Options{
		RTL:    rtl.NewClient(upstream.server.URL),
		Hub:    hub.NewWithLimits(1, 1),
		Poller: &fakeTracks{},
	})
	front := httptest.NewServer(srv.Handler())
	t.Cleanup(front.Close)

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	first, _ := http.NewRequestWithContext(ctx, http.MethodGet, front.URL+"/v1/live/stream?routes=133", nil)
	res, err := http.DefaultClient.Do(first)
	if err != nil {
		t.Fatalf("first stream: %v", err)
	}
	defer res.Body.Close()

	second, body := get(t, front.URL+"/v1/live/stream?routes=133", nil)
	if second.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 at capacity", second.StatusCode)
	}
	if got := second.Header.Get("Retry-After"); got == "" {
		t.Error("no Retry-After on a capacity refusal, so clients cannot back off")
	}
	if !strings.HasPrefix(second.Header.Get("Content-Type"), "application/json") {
		t.Errorf("Content-Type = %q, want JSON", second.Header.Get("Content-Type"))
	}
	var decoded map[string]string
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("refusal body was not JSON: %v (%s)", err, body)
	}
	if decoded["error"] == "" {
		t.Error("refusal carried no error message")
	}
}

// The stream must not be buffered or recompressed by anything in front of it.
func TestStreamSetsAntiBufferingHeaders(t *testing.T) {
	front, _ := newStreamingServer(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, front.URL+"/v1/live/stream?routes=133", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	defer res.Body.Close()

	if got := res.Header.Get("X-Accel-Buffering"); got != "no" {
		t.Errorf("X-Accel-Buffering = %q, want no", got)
	}
	if got := res.Header.Get("Cache-Control"); !strings.Contains(got, "no-transform") {
		t.Errorf("Cache-Control = %q, want it to include no-transform", got)
	}
}

// --- CORS allowlist ---

func newAllowlistServer(t *testing.T, allow string) *httptest.Server {
	t.Helper()
	upstream := newFakeUpstream(t)
	srv := NewServer(Options{RTL: rtl.NewClient(upstream.server.URL), AllowOrigin: allow})
	front := httptest.NewServer(srv.Handler())
	t.Cleanup(front.Close)
	return front
}

func TestCORSAllowlist(t *testing.T) {
	front := newAllowlistServer(t, "https://rtl.pages.dev, https://rtl.example.com")

	tests := []struct {
		origin string
		want   string
	}{
		{"https://rtl.pages.dev", "https://rtl.pages.dev"},
		{"https://rtl.example.com", "https://rtl.example.com"},
		{"https://evil.test", ""},
		{"", ""},
	}
	for _, tt := range tests {
		req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, front.URL+"/v1/graph", nil)
		if tt.origin != "" {
			req.Header.Set("Origin", tt.origin)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET: %v", err)
		}
		res.Body.Close()
		if got := res.Header.Get("Access-Control-Allow-Origin"); got != tt.want {
			t.Errorf("origin %q -> Allow-Origin %q, want %q", tt.origin, got, tt.want)
		}
		// Always, so a shared cache never blurs two origins together.
		if got := res.Header.Get("Vary"); !strings.Contains(got, "Origin") {
			t.Errorf("origin %q: Vary = %q, want it to include Origin", tt.origin, got)
		}
	}
}

func TestCORSWildcardStillAllowsAnyone(t *testing.T) {
	front := newAllowlistServer(t, "*")
	req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, front.URL+"/v1/graph", nil)
	req.Header.Set("Origin", "https://anything.test")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	res.Body.Close()
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Allow-Origin = %q, want *", got)
	}
}
