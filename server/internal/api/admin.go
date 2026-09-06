package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"runtime"
	"sort"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/mismaah/rtl-improved/server/internal/rtl"
	"github.com/mismaah/rtl-improved/server/internal/sshsig"
)

// AdminNamespace is the SSHSIG namespace admin requests are signed under. A
// signature made for anything else — a commit, another service — is not a
// credential for this one, and the namespace is inside the signed bytes so it
// cannot be swapped afterwards.
const AdminNamespace = "rtld-admin"

// AdminPath is where the RPC endpoint is mounted.
const AdminPath = "/v1/admin/rpc"

// AdminSignatureHeader carries the armoured SSHSIG, with its line breaks
// removed — a header cannot hold a newline.
const AdminSignatureHeader = "X-RTLD-Signature"

const (
	adminMaxBody = 64 << 10
	// adminClockSkew bounds how far a request's own timestamp may be from this
	// server's clock. Together with the nonce cache below it makes a captured
	// request useless: signing alone would let anyone who saw one replay it
	// forever.
	adminClockSkew   = 2 * time.Minute
	adminNonceWindow = 5 * time.Minute
	// adminTimeout must stay inside the http.Server's ReadTimeout.
	adminTimeout = 20 * time.Second
	// adminRatePerMinute bounds the cost of unauthenticated traffic. Forging a
	// signature is not something to brute-force; verifying one still costs CPU.
	adminRatePerMinute = 30
	// adminStackLimit caps a goroutine dump.
	adminStackLimit = 8 << 20
)

// adminEnvelope is the request body. The signature covers these bytes exactly
// as they were sent, so there is no canonical form to agree on and no way for
// the signed and the parsed request to differ.
type adminEnvelope struct {
	Op     string          `json:"op"`
	Params json.RawMessage `json:"params,omitempty"`
	TS     int64           `json:"ts"`
	Nonce  string          `json:"nonce"`
}

type adminResponse struct {
	OK     bool   `json:"ok"`
	Op     string `json:"op,omitempty"`
	TookMs int64  `json:"tookMs"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

// adminOp is one callable operation. The handler is unexported so the map
// doubles as the self-describing catalogue the "ops" operation returns.
type adminOp struct {
	Name    string `json:"op"`
	Summary string `json:"summary"`
	Params  string `json:"params,omitempty"`
	run     func(context.Context, json.RawMessage) (any, error)
}

// routeLister is the part of the poller that "status" wants but the live
// endpoints do not, kept separate so the LiveTracks interface stays as narrow
// as it was.
type routeLister interface {
	Routes() []string
}

func (s *Server) adminEnabled() bool { return len(s.adminKeys) > 0 }

// buildAdminOps assembles the operation table. Everything here reads; nothing
// mutates the server, the store or the upstream.
func (s *Server) buildAdminOps() map[string]*adminOp {
	ops := map[string]*adminOp{
		"status": {
			Summary: "runtime, cache, stream and store state",
			run:     func(ctx context.Context, _ json.RawMessage) (any, error) { return s.adminStatus(ctx) },
		},
		"sql": {
			Summary: "run a read-only query against the store",
			Params:  `{"query": "SELECT …", "args": [], "limit": 200}`,
			run:     s.adminSQL,
		},
		"schema": {
			Summary: "tables, indexes, row counts and page accounting",
			Params:  `{"deep": false}`,
			run:     s.adminSchema,
		},
		"logs": {
			Summary: "tail the in-memory log buffer",
			Params:  `{"limit": 100, "level": "info", "contains": ""}`,
			run:     s.adminLogs,
		},
		"upstream": {
			Summary: "call one RTL endpoint from this server and return the raw body",
			Params:  `{"endpoint": "routedetails|roadshape|livecoordinates|etas", "routeCode": "133"}`,
			run:     s.adminUpstream,
		},
		"stacks": {
			Summary: "full goroutine dump",
			run:     func(_ context.Context, _ json.RawMessage) (any, error) { return adminStacks() },
		},
	}
	// Self-describing, so a caller can discover the surface without a copy of
	// this file.
	ops["ops"] = &adminOp{
		Summary: "list the available operations",
		run: func(context.Context, json.RawMessage) (any, error) {
			listing := make([]adminOp, 0, len(ops))
			for name, op := range ops {
				listing = append(listing, adminOp{Name: name, Summary: op.Summary, Params: op.Params})
			}
			sort.Slice(listing, func(i, j int) bool { return listing[i].Name < listing[j].Name })
			return listing, nil
		},
	}
	for name, op := range ops {
		op.Name = name
	}
	return ops
}

// handleAdminRPC authenticates and dispatches one operation.
func (s *Server) handleAdminRPC(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeError(w, r, http.StatusMethodNotAllowed, "admin rpc accepts POST only")
		return
	}
	started := time.Now()
	client := RealIP(r, s.trustProxy)

	if !s.adminRate.allow(started) {
		s.log.Warn("admin rpc rate limited", "client", client)
		w.Header().Set("Retry-After", "60")
		writeError(w, r, http.StatusTooManyRequests, "too many admin requests")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, adminMaxBody))
	if err != nil {
		s.log.Warn("admin rpc body rejected", "client", client, "err", err)
		writeError(w, r, http.StatusRequestEntityTooLarge, "request body too large")
		return
	}

	envelope, key, err := s.authenticateAdmin(r, body, started)
	if err != nil {
		// Logged in full, answered with nothing: a caller who cannot
		// authenticate learns only that they could not.
		s.log.Warn("admin rpc rejected", "client", client, "err", err)
		writeError(w, r, http.StatusUnauthorized, "unauthorized")
		return
	}

	op, ok := s.adminOps[envelope.Op]
	if !ok {
		writeJSON(w, r, http.StatusBadRequest, "no-store", adminResponse{
			Op:     envelope.Op,
			TookMs: time.Since(started).Milliseconds(),
			Error:  fmt.Sprintf("unknown op %q; call \"ops\" to list them", envelope.Op),
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), adminTimeout)
	defer cancel()

	result, err := op.run(ctx, envelope.Params)
	took := time.Since(started).Milliseconds()
	fingerprint := ssh.FingerprintSHA256(key)
	if err != nil {
		s.log.Warn("admin rpc failed", "op", envelope.Op, "client", client, "key", fingerprint, "err", err)
		writeJSON(w, r, http.StatusBadRequest, "no-store", adminResponse{
			Op: envelope.Op, TookMs: took, Error: err.Error(),
		})
		return
	}

	s.log.Info("admin rpc", "op", envelope.Op, "client", client, "key", fingerprint, "tookMs", took)
	writeJSON(w, r, http.StatusOK, "no-store", adminResponse{
		OK: true, Op: envelope.Op, TookMs: took, Result: result,
	})
}

// authenticateAdmin verifies the signature over the raw body, then the freshness
// of what it says.
//
// Order matters: nothing in the body is believed until the signature over it
// has been checked, so the timestamp and nonce below are the signer's own
// claims rather than an attacker's.
func (s *Server) authenticateAdmin(r *http.Request, body []byte, now time.Time) (*adminEnvelope, ssh.PublicKey, error) {
	signature := r.Header.Get(AdminSignatureHeader)
	if signature == "" {
		return nil, nil, fmt.Errorf("missing %s", AdminSignatureHeader)
	}
	key, err := sshsig.Verify(s.adminKeys, AdminNamespace, body, []byte(signature))
	if err != nil {
		return nil, nil, err
	}

	var envelope adminEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, nil, fmt.Errorf("malformed request body: %w", err)
	}
	if envelope.Op == "" {
		return nil, nil, errors.New("no op")
	}

	skew := now.Sub(time.UnixMilli(envelope.TS))
	if skew < 0 {
		skew = -skew
	}
	if skew > adminClockSkew {
		return nil, nil, fmt.Errorf("timestamp is %s away from this server's clock", skew.Round(time.Second))
	}
	// A nonce short enough to collide by accident is not a nonce.
	if raw, err := base64.StdEncoding.DecodeString(envelope.Nonce); err != nil || len(raw) < 16 {
		return nil, nil, errors.New("nonce must be at least 16 random bytes, base64")
	}
	if !s.adminNonces.use(envelope.Nonce, now) {
		return nil, nil, errors.New("nonce reused; this request is a replay")
	}
	return &envelope, key, nil
}

func (s *Server) adminStatus(ctx context.Context) (any, error) {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	status := map[string]any{
		"version":    s.version,
		"startedAt":  s.startedAt.UTC().Format(time.RFC3339),
		"uptimeSec":  int(time.Since(s.startedAt).Seconds()),
		"serverTime": time.Now().UTC().Format(time.RFC3339),
		"runtime": map[string]any{
			"go":         runtime.Version(),
			"goroutines": runtime.NumGoroutine(),
			"maxprocs":   runtime.GOMAXPROCS(0),
			"platform":   runtime.GOOS + "/" + runtime.GOARCH,
		},
		"memory": map[string]any{
			"allocBytes":     mem.Alloc,
			"totalAllocated": mem.TotalAlloc,
			"sysBytes":       mem.Sys,
			"heapObjects":    mem.HeapObjects,
			"gcCount":        mem.NumGC,
		},
	}
	if entry, ok := s.graph.Peek(graphKey); ok {
		status["graphAgeMs"] = time.Since(entry.StoredAt).Milliseconds()
	}
	if s.hub != nil {
		open, max := s.hub.Capacity()
		status["streams"] = map[string]int{"open": open, "max": max}
	}
	if s.poller != nil {
		if lister, ok := s.poller.(routeLister); ok {
			perRoute := map[string]int{}
			total := 0
			for _, code := range lister.Routes() {
				if n := len(s.poller.Tracks(code)); n > 0 {
					perRoute[code] = n
					total += n
				}
			}
			status["live"] = map[string]any{"buses": total, "byRoute": perRoute}
		}
	}
	if s.logs != nil {
		status["logs"] = map[string]int{"held": s.logs.Len(), "capacity": s.logs.Cap()}
	}
	if s.readDB != nil {
		stats, err := s.readDB.Stats(ctx)
		if err != nil {
			return nil, fmt.Errorf("store stats: %w", err)
		}
		store := map[string]any{
			"fixes": stats.Fixes, "arrivals": stats.Arrivals, "segments": stats.Segments,
			"headways": stats.Headways, "days": stats.Days, "oldestFixMs": stats.OldestFixMs,
		}
		if stats.OldestFixMs > 0 {
			store["oldestFix"] = time.UnixMilli(stats.OldestFixMs).UTC().Format(time.RFC3339)
		}
		if size, err := s.storeSizeBytes(ctx); err == nil {
			store["sizeBytes"] = size
		}
		status["store"] = store
	}
	return status, nil
}

// storeSizeBytes reads the file size from SQLite's own page accounting rather
// than from the filesystem, which the process cannot see past its mount.
func (s *Server) storeSizeBytes(ctx context.Context) (int64, error) {
	result, err := s.readDB.Query(ctx,
		`SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()`, nil, 1)
	if err != nil {
		return 0, err
	}
	if len(result.Rows) != 1 || len(result.Rows[0]) != 1 {
		return 0, errors.New("unexpected page accounting")
	}
	size, ok := result.Rows[0][0].(int64)
	if !ok {
		return 0, errors.New("page accounting is not a number")
	}
	return size, nil
}

func (s *Server) adminSQL(ctx context.Context, raw json.RawMessage) (any, error) {
	var params struct {
		Query string `json:"query"`
		Args  []any  `json:"args"`
		Limit int    `json:"limit"`
	}
	if err := decodeParams(raw, &params); err != nil {
		return nil, err
	}
	if s.readDB == nil {
		return nil, errors.New("no database is configured on this server")
	}
	return s.readDB.Query(ctx, params.Query, params.Args, params.Limit)
}

func (s *Server) adminSchema(ctx context.Context, raw json.RawMessage) (any, error) {
	var params struct {
		Deep bool `json:"deep"`
	}
	if err := decodeParams(raw, &params); err != nil {
		return nil, err
	}
	if s.readDB == nil {
		return nil, errors.New("no database is configured on this server")
	}
	return s.readDB.SchemaInfo(ctx, params.Deep)
}

func (s *Server) adminLogs(_ context.Context, raw json.RawMessage) (any, error) {
	var params struct {
		Limit    int    `json:"limit"`
		Level    string `json:"level"`
		Contains string `json:"contains"`
	}
	if err := decodeParams(raw, &params); err != nil {
		return nil, err
	}
	if s.logs == nil {
		return nil, errors.New("no log buffer is configured on this server")
	}

	level := slog.LevelDebug
	if params.Level != "" {
		if err := level.UnmarshalText([]byte(params.Level)); err != nil {
			return nil, fmt.Errorf("unknown level %q", params.Level)
		}
	}
	switch {
	case params.Limit <= 0:
		params.Limit = 100
	case params.Limit > s.logs.Cap():
		params.Limit = s.logs.Cap()
	}

	records := s.logs.Tail(params.Limit, level, params.Contains)
	return map[string]any{
		"records":  records,
		"returned": len(records),
		"held":     s.logs.Len(),
		"capacity": s.logs.Cap(),
	}, nil
}

func (s *Server) adminUpstream(ctx context.Context, raw json.RawMessage) (any, error) {
	var params struct {
		Endpoint  string `json:"endpoint"`
		RouteCode string `json:"routeCode"`
	}
	if err := decodeParams(raw, &params); err != nil {
		return nil, err
	}
	if params.Endpoint == "" {
		return nil, fmt.Errorf("endpoint is required; one of %v", rtl.Endpoints())
	}
	if params.RouteCode != "" && !validRouteCode(params.RouteCode) {
		return nil, fmt.Errorf("invalid route code %q", params.RouteCode)
	}
	return s.rtl.FetchRaw(ctx, params.Endpoint, params.RouteCode)
}

func adminStacks() (any, error) {
	size := 1 << 20
	for {
		buf := make([]byte, size)
		n := runtime.Stack(buf, true)
		if n < size || size >= adminStackLimit {
			return map[string]any{
				"goroutines": runtime.NumGoroutine(),
				"truncated":  n == size,
				"stacks":     string(buf[:n]),
			}, nil
		}
		size *= 2
	}
}

// decodeParams is strict about unknown fields: a mistyped parameter that is
// silently ignored looks like a server that disagrees with you.
func decodeParams(raw json.RawMessage, into any) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		return fmt.Errorf("params: %w", err)
	}
	return nil
}

// nonceCache remembers which nonces have been used, for as long as a request
// bearing one could still be inside the clock-skew window.
type nonceCache struct {
	mu     sync.Mutex
	seen   map[string]time.Time
	window time.Duration
}

func newNonceCache(window time.Duration) *nonceCache {
	return &nonceCache{seen: make(map[string]time.Time), window: window}
}

// use records a nonce and reports whether it was previously unseen.
func (c *nonceCache) use(nonce string, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Swept on the way past rather than on a timer: entries only matter for a
	// few minutes and there are never many of them.
	for seen, at := range c.seen {
		if now.Sub(at) > c.window {
			delete(c.seen, seen)
		}
	}
	if _, replayed := c.seen[nonce]; replayed {
		return false
	}
	c.seen[nonce] = now
	return true
}

// rateLimiter is a fixed-window counter. Precision does not matter here; the
// point is that an unauthenticated flood cannot cost unbounded CPU.
type rateLimiter struct {
	mu      sync.Mutex
	limit   int
	window  time.Time
	counted int
}

func (l *rateLimiter) allow(now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	minute := now.Truncate(time.Minute)
	if minute.After(l.window) {
		l.window, l.counted = minute, 0
	}
	if l.counted >= l.limit {
		return false
	}
	l.counted++
	return true
}
