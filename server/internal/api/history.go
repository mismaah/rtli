package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

const (
	// historyWindow is how far back the summary looks.
	//
	// Long enough that a route's quiet day does not move its median, short
	// enough that a timetable change from a month ago is not still being
	// averaged in with how the route runs today. Aggregates are kept for 90
	// days; this is the slice of them that describes the present.
	historyWindow = 28 * 24 * time.Hour

	// historyTTL bounds how often the medians are recomputed. The rollup only
	// produces new observations every rollup.Interval, so recomputing faster
	// than that reads the same rows to reach the same answer.
	historyTTL = 30 * time.Minute
	// A summary of four weeks does not go stale in an hour. Serving a slightly
	// old one beats failing, because the client's fallback is a hardcoded guess.
	historyMaxStale = 24 * time.Hour

	historyKey = "history"
)

// handleHistory serves what the recorded history says about how the network
// actually runs: measured headways, measured ride times between stops, and
// measured lateness against the published timetable.
//
// This is the one endpoint that serves something RTL does not publish. Every
// other route here is a cache or a reshaping of upstream data; this is the
// product of the recorder, and it exists because four of these routes publish
// no timetable at all and the rest publish one the buses do not keep to.
//
// It answers 503 rather than an empty summary when there is no store, so a
// client can tell "this server cannot measure" from "this route has not been
// measured yet" — the first is a reason to keep its own assumptions, the second
// is a reason to keep asking.
func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	if s.readDB == nil {
		writeJSON(w, r, http.StatusServiceUnavailable, "no-store",
			map[string]string{"error": "history is not available on this server"})
		return
	}
	payload, _, err := s.history.Get(r.Context(), historyKey, s.loadHistory)
	if err != nil {
		s.fail(w, r, "history", err)
		return
	}
	// Cacheable for a while: it changes on the rollup's half-hourly cadence, and
	// a client that holds it for the length of a session is holding something
	// still true.
	writeRaw(w, r, "public, max-age=600, stale-while-revalidate=3600", payload)
}

func (s *Server) loadHistory(ctx context.Context) (json.RawMessage, error) {
	now := time.Now()
	summary, err := s.readDB.History(ctx, now.Add(-historyWindow).UnixMilli(), now.UnixMilli())
	if err != nil {
		return nil, err
	}
	return json.Marshal(summary)
}
