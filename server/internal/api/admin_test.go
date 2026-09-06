package api

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/mismaah/rtl-improved/server/internal/hub"
	"github.com/mismaah/rtl-improved/server/internal/logbuf"
	"github.com/mismaah/rtl-improved/server/internal/rtl"
	"github.com/mismaah/rtl-improved/server/internal/sshsig"
	"github.com/mismaah/rtl-improved/server/internal/store"
	"github.com/mismaah/rtl-improved/server/internal/track"
)

// adminClient signs requests the way cmd/rtladm does.
type adminClient struct {
	t      *testing.T
	url    string
	signer ssh.Signer
}

func newSigner(t *testing.T) ssh.Signer {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

func nonce(t *testing.T) string {
	t.Helper()
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

// body assembles an envelope without sending it, so tests can tamper.
func (c *adminClient) body(op string, params any) []byte {
	c.t.Helper()
	envelope := map[string]any{"op": op, "ts": time.Now().UnixMilli(), "nonce": nonce(c.t)}
	if params != nil {
		envelope["params"] = params
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		c.t.Fatal(err)
	}
	return encoded
}

// post signs body and sends it. A nil signer sends no signature at all.
func (c *adminClient) post(body []byte, signer ssh.Signer) (*http.Response, adminResponse) {
	c.t.Helper()
	req, err := http.NewRequest(http.MethodPost, c.url+AdminPath, strings.NewReader(string(body)))
	if err != nil {
		c.t.Fatal(err)
	}
	if signer != nil {
		armored, err := sshsig.Sign(signer, AdminNamespace, body)
		if err != nil {
			c.t.Fatal(err)
		}
		req.Header.Set(AdminSignatureHeader, strings.ReplaceAll(string(armored), "\n", ""))
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()

	raw, err := io.ReadAll(res.Body)
	if err != nil {
		c.t.Fatal(err)
	}
	var decoded adminResponse
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &decoded)
	}
	return res, decoded
}

// call is the happy path: sign, send, require success.
func (c *adminClient) call(op string, params any) adminResponse {
	c.t.Helper()
	res, decoded := c.post(c.body(op, params), c.signer)
	if res.StatusCode != http.StatusOK || !decoded.OK {
		c.t.Fatalf("%s: status %d, error %q", op, res.StatusCode, decoded.Error)
	}
	return decoded
}

// result re-decodes an op's result into a typed value.
func result[T any](t *testing.T, res adminResponse) T {
	t.Helper()
	encoded, err := json.Marshal(res.Result)
	if err != nil {
		t.Fatal(err)
	}
	var out T
	if err := json.Unmarshal(encoded, &out); err != nil {
		t.Fatalf("decode result: %v (%s)", err, encoded)
	}
	return out
}

type adminFixture struct {
	client   *adminClient
	upstream *fakeUpstream
	logs     *logbuf.Buffer
	writer   *store.DB
}

func newAdminServer(t *testing.T) *adminFixture {
	t.Helper()
	signer := newSigner(t)
	upstream := newFakeUpstream(t)

	path := filepath.Join(t.TempDir(), "rtld.db")
	writer, err := store.Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { writer.Close() })
	reader, err := store.OpenReadOnly(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { reader.Close() })

	logs := logbuf.New(64)
	heading := 90.0
	srv := NewServer(Options{
		RTL:       rtl.NewClient(upstream.server.URL),
		Log:       slog.New(logs.Handler(slog.NewJSONHandler(io.Discard, nil))),
		Hub:       hub.New(),
		Poller:    &fakeTracks{tracks: []*track.Track{{BusCode: "C1", Heading: &heading}}},
		AdminKeys: []ssh.PublicKey{signer.PublicKey()},
		ReadDB:    reader,
		Logs:      logs,
		Version:   "test-build",
	})
	front := newFront(t, srv)

	return &adminFixture{
		client:   &adminClient{t: t, url: front, signer: signer},
		upstream: upstream,
		logs:     logs,
		writer:   writer,
	}
}

// --- mounting ---

// With no key configured the endpoint is absent, not merely closed.
func TestAdminAbsentWithoutAKey(t *testing.T) {
	front, _ := newTestServer(t)
	client := &adminClient{t: t, url: front.URL}

	res, _ := client.post(client.body("status", nil), nil)
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404 when no admin key is configured", res.StatusCode)
	}
}

// The outer mux must not shadow the routes it wraps.
func TestAdminMountLeavesPublicRoutesAlone(t *testing.T) {
	fixture := newAdminServer(t)
	for _, path := range []string{"/healthz", "/v1/meta", "/v1/graph", "/v1/live/133"} {
		res, _ := get(t, fixture.client.url+path, nil)
		if res.StatusCode != http.StatusOK {
			t.Errorf("%s = %d, want 200 with the admin mux in place", path, res.StatusCode)
		}
	}
}

// Telling a browser it may read this cross-origin is exactly wrong.
func TestAdminSendsNoCORSHeaders(t *testing.T) {
	fixture := newAdminServer(t)
	body := fixture.client.body("status", nil)
	req, err := http.NewRequest(http.MethodPost, fixture.client.url+AdminPath, strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	armored, err := sshsig.Sign(fixture.client.signer, AdminNamespace, body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(AdminSignatureHeader, strings.ReplaceAll(string(armored), "\n", ""))
	req.Header.Set("Origin", "https://evil.example")

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("Access-Control-Allow-Origin = %q, want none on the admin route", got)
	}
}

func TestAdminRejectsGET(t *testing.T) {
	fixture := newAdminServer(t)
	res, _ := get(t, fixture.client.url+AdminPath, nil)
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", res.StatusCode)
	}
}

// --- authentication ---

func TestAdminRejectsBadSignatures(t *testing.T) {
	fixture := newAdminServer(t)
	client := fixture.client

	t.Run("unsigned", func(t *testing.T) {
		res, _ := client.post(client.body("status", nil), nil)
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("status = %d, want 401", res.StatusCode)
		}
	})

	t.Run("another key", func(t *testing.T) {
		res, _ := client.post(client.body("status", nil), newSigner(t))
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("status = %d, want 401", res.StatusCode)
		}
	})

	t.Run("garbage signature", func(t *testing.T) {
		body := client.body("status", nil)
		req, _ := http.NewRequest(http.MethodPost, client.url+AdminPath, strings.NewReader(string(body)))
		req.Header.Set(AdminSignatureHeader, "not-a-signature")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("status = %d, want 401", res.StatusCode)
		}
	})

	// The signature covers the body byte for byte, so swapping the op after
	// signing must not survive.
	t.Run("body swapped after signing", func(t *testing.T) {
		signed := client.body("status", nil)
		armored, err := sshsig.Sign(client.signer, AdminNamespace, signed)
		if err != nil {
			t.Fatal(err)
		}
		tampered := strings.Replace(string(signed), `"op":"status"`, `"op":"stacks"`, 1)
		if tampered == string(signed) {
			t.Fatal("test did not actually change the body")
		}
		req, _ := http.NewRequest(http.MethodPost, client.url+AdminPath, strings.NewReader(tampered))
		req.Header.Set(AdminSignatureHeader, strings.ReplaceAll(string(armored), "\n", ""))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("status = %d, want 401", res.StatusCode)
		}
	})

	t.Run("stale timestamp", func(t *testing.T) {
		envelope, _ := json.Marshal(map[string]any{
			"op":    "status",
			"ts":    time.Now().Add(-10 * time.Minute).UnixMilli(),
			"nonce": nonce(t),
		})
		res, _ := client.post(envelope, client.signer)
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("status = %d, want 401 for a stale request", res.StatusCode)
		}
	})

	t.Run("short nonce", func(t *testing.T) {
		envelope, _ := json.Marshal(map[string]any{
			"op": "status", "ts": time.Now().UnixMilli(), "nonce": "c2hvcnQ=",
		})
		res, _ := client.post(envelope, client.signer)
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("status = %d, want 401 for a short nonce", res.StatusCode)
		}
	})
}

// A signature is not enough on its own: anyone who captured a valid request
// could otherwise send it again forever.
func TestAdminRejectsReplay(t *testing.T) {
	fixture := newAdminServer(t)
	body := fixture.client.body("status", nil)

	if res, _ := fixture.client.post(body, fixture.client.signer); res.StatusCode != http.StatusOK {
		t.Fatalf("first send: status %d, want 200", res.StatusCode)
	}
	res, _ := fixture.client.post(body, fixture.client.signer)
	if res.StatusCode != http.StatusUnauthorized {
		t.Errorf("replayed request: status %d, want 401", res.StatusCode)
	}
}

// --- operations ---

func TestAdminOpsIsSelfDescribing(t *testing.T) {
	fixture := newAdminServer(t)
	listing := result[[]adminOp](t, fixture.client.call("ops", nil))

	found := map[string]bool{}
	for _, op := range listing {
		if op.Name == "" || op.Summary == "" {
			t.Errorf("op listed without a name or summary: %+v", op)
		}
		found[op.Name] = true
	}
	for _, want := range []string{"ops", "status", "sql", "schema", "logs", "upstream", "stacks"} {
		if !found[want] {
			t.Errorf("op %q missing from the catalogue", want)
		}
	}
}

func TestAdminUnknownOp(t *testing.T) {
	fixture := newAdminServer(t)
	res, decoded := fixture.client.post(fixture.client.body("rm-rf", nil), fixture.client.signer)
	if res.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", res.StatusCode)
	}
	if !strings.Contains(decoded.Error, "unknown op") {
		t.Errorf("error = %q", decoded.Error)
	}
}

func TestAdminStatus(t *testing.T) {
	fixture := newAdminServer(t)
	fixture.writer.InsertFixes(t.Context(), []store.Fix{
		{RouteCode: "133", BusCode: "A1", AtMs: time.Now().UnixMilli(), Lat: 4.1, Lng: 73.5},
	})

	status := result[map[string]any](t, fixture.client.call("status", nil))
	if status["version"] != "test-build" {
		t.Errorf("version = %v", status["version"])
	}
	if _, ok := status["runtime"].(map[string]any)["goroutines"]; !ok {
		t.Errorf("no goroutine count: %+v", status["runtime"])
	}
	dbStats, ok := status["store"].(map[string]any)
	if !ok {
		t.Fatalf("no store stats: %+v", status)
	}
	if dbStats["fixes"] != float64(1) {
		t.Errorf("fixes = %v, want 1", dbStats["fixes"])
	}
	if size, _ := dbStats["sizeBytes"].(float64); size <= 0 {
		t.Errorf("sizeBytes = %v, want a real file size", dbStats["sizeBytes"])
	}
	if _, ok := status["streams"]; !ok {
		t.Error("no stream capacity reported")
	}
}

func TestAdminSQL(t *testing.T) {
	fixture := newAdminServer(t)
	at := time.Now().UnixMilli()
	if err := fixture.writer.InsertFixes(t.Context(), []store.Fix{
		{RouteCode: "133", BusCode: "A1", AtMs: at, Lat: 4.1, Lng: 73.5},
		{RouteCode: "144", BusCode: "B2", AtMs: at, Lat: 4.2, Lng: 73.6},
	}); err != nil {
		t.Fatal(err)
	}

	t.Run("reads", func(t *testing.T) {
		out := result[store.QueryResult](t, fixture.client.call("sql", map[string]any{
			"query": "SELECT route_code FROM bus_fix WHERE bus_code = ? ORDER BY route_code",
			"args":  []any{"B2"},
		}))
		if out.RowCount != 1 || out.Rows[0][0] != "144" {
			t.Errorf("unexpected rows: %+v", out.Rows)
		}
	})

	// The read-only guarantee is SQLite's, not a statement inspection here, so
	// prove it through the endpoint too.
	t.Run("cannot write", func(t *testing.T) {
		for _, statement := range []string{
			"DELETE FROM bus_fix",
			"DROP TABLE bus_fix",
			"UPDATE bus_fix SET lat = 0",
		} {
			res, decoded := fixture.client.post(
				fixture.client.body("sql", map[string]any{"query": statement}), fixture.client.signer)
			if res.StatusCode != http.StatusBadRequest || decoded.OK {
				t.Errorf("%q: status %d ok=%v, want a refusal", statement, res.StatusCode, decoded.OK)
			}
		}
		out := result[store.QueryResult](t, fixture.client.call("sql", map[string]any{
			"query": "SELECT COUNT(*) FROM bus_fix",
		}))
		if out.Rows[0][0] != float64(2) {
			t.Errorf("rows changed: %v", out.Rows[0][0])
		}
	})

	t.Run("mistyped params are refused", func(t *testing.T) {
		res, decoded := fixture.client.post(
			fixture.client.body("sql", map[string]any{"qeury": "SELECT 1"}), fixture.client.signer)
		if res.StatusCode != http.StatusBadRequest || !strings.Contains(decoded.Error, "params") {
			t.Errorf("status %d, error %q, want a params complaint", res.StatusCode, decoded.Error)
		}
	})
}

func TestAdminSchema(t *testing.T) {
	fixture := newAdminServer(t)
	schema := result[store.Schema](t, fixture.client.call("schema", nil))

	var names []string
	for _, object := range schema.Objects {
		names = append(names, object.Name)
	}
	if !strings.Contains(strings.Join(names, ","), "bus_fix") {
		t.Errorf("bus_fix missing from %v", names)
	}
	if schema.Pragmas["journal_mode"] != "wal" {
		t.Errorf("journal_mode = %v", schema.Pragmas["journal_mode"])
	}
	if len(schema.Integrity) != 0 {
		t.Errorf("integrity check ran unasked: %v", schema.Integrity)
	}
}

func TestAdminLogs(t *testing.T) {
	fixture := newAdminServer(t)
	// The first call is itself logged, which is what this then reads back.
	fixture.client.call("status", nil)

	out := result[struct {
		Records  []logbuf.Record `json:"records"`
		Returned int             `json:"returned"`
		Capacity int             `json:"capacity"`
	}](t, fixture.client.call("logs", map[string]any{"contains": "admin rpc"}))

	if out.Returned == 0 {
		t.Fatal("no records matched")
	}
	if out.Capacity != 64 {
		t.Errorf("capacity = %d, want 64", out.Capacity)
	}
	last := out.Records[len(out.Records)-1]
	if last.Msg != "admin rpc" || last.Attrs["op"] != "status" {
		t.Errorf("unexpected record: %+v", last)
	}

	t.Run("unknown level", func(t *testing.T) {
		res, decoded := fixture.client.post(
			fixture.client.body("logs", map[string]any{"level": "shouty"}), fixture.client.signer)
		if res.StatusCode != http.StatusBadRequest || !strings.Contains(decoded.Error, "unknown level") {
			t.Errorf("status %d, error %q", res.StatusCode, decoded.Error)
		}
	})
}

func TestAdminUpstream(t *testing.T) {
	fixture := newAdminServer(t)

	out := result[rtl.RawResult](t, fixture.client.call("upstream", map[string]any{
		"endpoint": "livecoordinates", "routeCode": "133",
	}))
	if out.Endpoint != "livecoordinates" || out.Bytes == 0 {
		t.Errorf("unexpected result: %+v", out)
	}
	// The point of the op is the body exactly as it arrived.
	if !strings.Contains(string(out.Body), `"busCode":"C1"`) {
		t.Errorf("body = %s", out.Body)
	}

	for _, params := range []map[string]any{
		{"endpoint": "nope"},
		{"endpoint": "roadshape"},                           // needs a route code
		{"endpoint": "roadshape", "routeCode": "'; DROP--"}, // rejected before it is sent
	} {
		res, decoded := fixture.client.post(fixture.client.body("upstream", params), fixture.client.signer)
		if res.StatusCode != http.StatusBadRequest || decoded.OK {
			t.Errorf("%v: status %d ok=%v, want a refusal", params, res.StatusCode, decoded.OK)
		}
	}
}

func TestAdminStacks(t *testing.T) {
	fixture := newAdminServer(t)
	out := result[struct {
		Goroutines int    `json:"goroutines"`
		Stacks     string `json:"stacks"`
		Truncated  bool   `json:"truncated"`
	}](t, fixture.client.call("stacks", nil))

	if out.Goroutines < 1 || !strings.Contains(out.Stacks, "goroutine ") {
		t.Errorf("unexpected dump: %d goroutines, %d bytes", out.Goroutines, len(out.Stacks))
	}
	if out.Truncated {
		t.Error("a test-sized dump was truncated")
	}
}

// --- rate limiting ---

func TestAdminRateLimit(t *testing.T) {
	limiter := &rateLimiter{limit: 3}
	now := time.Now()
	for i := range 3 {
		if !limiter.allow(now) {
			t.Fatalf("request %d refused inside the limit", i)
		}
	}
	if limiter.allow(now) {
		t.Error("the limit was not enforced")
	}
	if !limiter.allow(now.Add(time.Minute)) {
		t.Error("the window did not roll over")
	}
}

func TestAdminNonceCache(t *testing.T) {
	cache := newNonceCache(time.Minute)
	now := time.Now()
	if !cache.use("a", now) {
		t.Fatal("a fresh nonce was refused")
	}
	if cache.use("a", now) {
		t.Error("a reused nonce was accepted")
	}
	// Past the window an entry is dropped, which is safe: a request carrying it
	// would already fail the clock-skew check.
	if !cache.use("a", now.Add(2*time.Minute)) {
		t.Error("an expired nonce was not forgotten")
	}
}
