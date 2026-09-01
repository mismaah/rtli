package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// writeRaw sends an already-encoded JSON body with an ETag, so a client that
// polls an unchanged timetable pays for headers and nothing else.
func writeRaw(w http.ResponseWriter, r *http.Request, cacheControl string, body []byte) {
	sum := sha256.Sum256(body)
	etag := `"` + hex.EncodeToString(sum[:16]) + `"`

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", cacheControl)
	w.Header().Set("ETag", etag)

	if matchesETag(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, cacheControl string, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		http.Error(w, `{"error":"internal encoding failure"}`, http.StatusInternalServerError)
		return
	}
	if status == http.StatusOK && cacheControl != "no-store" {
		writeRaw(w, r, cacheControl, body)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", cacheControl)
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func writeError(w http.ResponseWriter, r *http.Request, status int, message string) {
	writeJSON(w, r, status, "no-store", map[string]string{"error": message})
}

// matchesETag handles the comma-separated list form of If-None-Match, including
// the weak-comparison prefix.
func matchesETag(header, etag string) bool {
	if header == "" {
		return false
	}
	for candidate := range strings.SplitSeq(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || candidate == etag || strings.TrimPrefix(candidate, "W/") == etag {
			return true
		}
	}
	return false
}

// validRouteCode guards the upstream call. Route codes are short numeric ids
// like "133"; anything else is a malformed request, not a lookup to attempt.
func validRouteCode(code string) bool {
	if code == "" || len(code) > 8 {
		return false
	}
	for _, r := range code {
		if (r < '0' || r > '9') && (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') {
			return false
		}
	}
	return true
}

// parseRouteCodes splits and validates the ?routes= list, rejecting duplicates
// so one request cannot fan out repeatedly to the same upstream route.
func parseRouteCodes(raw string) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	seen := make(map[string]struct{})
	var out []string
	for field := range strings.SplitSeq(raw, ",") {
		code := strings.TrimSpace(field)
		if code == "" {
			continue
		}
		if !validRouteCode(code) {
			return nil, fmt.Errorf("invalid route code %q", code)
		}
		if _, dup := seen[code]; dup {
			continue
		}
		seen[code] = struct{}{}
		out = append(out, code)
		if len(out) > maxBatchRoutes {
			return nil, fmt.Errorf("at most %d routes per request", maxBatchRoutes)
		}
	}
	return out, nil
}
