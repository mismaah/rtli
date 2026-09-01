package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/mismaah/rtl-improved/server/internal/hub"
)

// heartbeat keeps idle proxies from severing a quiet stream. Well under the
// typical 60 s idle timeout.
const heartbeat = 20 * time.Second

// handleLiveStream streams live bus updates for the requested routes.
//
// The first thing sent is a full snapshot, which is the cold-start fix: today a
// client must poll twice and watch a bus travel 12 m before it can draw a
// heading arrow, and useTrackedBuses throws that history away on every route
// change. Here the server has been tracking continuously, so arrows and trails
// are present on the very first frame.
//
// After that, per-bus deltas — the measured feed staggers buses independently,
// so a whole-fleet snapshot would be mostly redundant bytes.
func (s *Server) handleLiveStream(w http.ResponseWriter, r *http.Request) {
	if s.poller == nil || s.hub == nil {
		writeError(w, r, http.StatusServiceUnavailable, "live streaming is not enabled")
		return
	}
	codes, err := parseRouteCodes(r.URL.Query().Get("routes"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	if len(codes) == 0 {
		writeError(w, r, http.StatusBadRequest, "at least one route is required")
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, r, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	// Claim a slot before writing any headers, so a refusal is still an
	// ordinary JSON error the client can read rather than a truncated stream.
	sub, err := s.hub.Subscribe(RealIP(r, s.trustProxy), codes)
	if err != nil {
		var capacity *hub.ErrAtCapacity
		if errors.As(err, &capacity) {
			// Long enough that a client at capacity backs off rather than
			// hammering, short enough to reconnect once a slot frees up.
			w.Header().Set("Retry-After", "30")
			writeError(w, r, http.StatusServiceUnavailable, capacity.Error())
			return
		}
		writeError(w, r, http.StatusServiceUnavailable, "could not open a stream")
		return
	}
	defer s.hub.Unsubscribe(sub)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	// Without these an intermediary buffers or recompresses the stream and
	// nothing arrives until the connection closes, which looks exactly like a
	// broken feed. `no-transform` is the one that matters at Cloudflare's edge.
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Cache-Control", "no-store, no-transform")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	// Everything currently known, before any delta.
	for _, routeCode := range codes {
		tracks := s.poller.Tracks(routeCode)
		payload, err := json.Marshal(map[string]any{"routeCode": routeCode, "tracks": tracks})
		if err != nil {
			continue
		}
		if !writeEvent(w, flusher, 0, "snapshot", payload) {
			return
		}
	}

	ticker := time.NewTicker(heartbeat)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case event, open := <-sub.Events():
			if !open {
				return
			}
			if !writeEvent(w, flusher, event.ID, event.Name, event.Data) {
				return
			}
		case <-ticker.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// writeEvent emits one SSE frame, reporting whether the client is still there.
func writeEvent(w http.ResponseWriter, flusher http.Flusher, id uint64, name string, data []byte) bool {
	if id > 0 {
		if _, err := fmt.Fprintf(w, "id: %d\n", id); err != nil {
			return false
		}
	}
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, data); err != nil {
		return false
	}
	flusher.Flush()
	return true
}
