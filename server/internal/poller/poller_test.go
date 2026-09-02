package poller

import (
	"log/slog"
	"testing"
	"time"

	"github.com/mismaah/rtl-improved/server/internal/hub"
	"github.com/mismaah/rtl-improved/server/internal/track"
)

// The Malé civil day is UTC+05:00 with no DST, ever. If this drifts from
// serviceDate() in src/lib/time.ts, the server's day buckets and the client's
// IndexedDB cache keys quietly describe different days.
func TestServiceDateMatchesMaleCivilDay(t *testing.T) {
	tests := []struct {
		name string
		utc  string
		want string
	}{
		{"midday UTC", "2026-09-01T12:00:00Z", "2026-09-01"},
		// 19:30 UTC is 00:30 the next day in Malé.
		{"evening UTC rolls the day over", "2026-09-01T19:30:00Z", "2026-09-02"},
		// 18:59 UTC is 23:59 in Malé — still the same day.
		{"just before the rollover", "2026-09-01T18:59:00Z", "2026-09-01"},
		{"exactly at the rollover", "2026-09-01T19:00:00Z", "2026-09-02"},
		{"early UTC is still yesterday's evening nowhere", "2026-09-01T00:00:00Z", "2026-09-01"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			at, err := time.Parse(time.RFC3339, tt.utc)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if got := ServiceDate(at); got != tt.want {
				t.Errorf("ServiceDate(%s) = %s, want %s", tt.utc, got, tt.want)
			}
		})
	}
}

// ServiceDate must not depend on the machine's local timezone.
func TestServiceDateIgnoresLocalZone(t *testing.T) {
	at, _ := time.Parse(time.RFC3339, "2026-09-01T19:30:00Z")
	want := ServiceDate(at)

	for _, zone := range []string{"UTC", "America/New_York", "Asia/Tokyo", "Pacific/Kiritimati"} {
		loc, err := time.LoadLocation(zone)
		if err != nil {
			t.Skipf("zone %s unavailable: %v", zone, err)
		}
		if got := ServiceDate(at.In(loc)); got != want {
			t.Errorf("ServiceDate in %s = %s, want %s", zone, got, want)
		}
	}
}

// No bus reports overnight, and polling an empty feed until dawn is pure waste.
func TestInServiceHours(t *testing.T) {
	tests := []struct {
		utc  string
		male string
		want bool
	}{
		{"2026-09-01T04:00:00Z", "09:00", true},
		{"2026-09-01T12:00:00Z", "17:00", true},
		{"2026-09-01T18:00:00Z", "23:00", true},
		{"2026-09-01T19:30:00Z", "00:30", true},  // just inside, before 01:00
		{"2026-09-01T20:30:00Z", "01:30", false}, // shut
		{"2026-09-01T22:00:00Z", "03:00", false}, // shut
		{"2026-09-01T23:00:00Z", "04:00", true},  // service resumes
	}
	for _, tt := range tests {
		at, err := time.Parse(time.RFC3339, tt.utc)
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		if got := inServiceHours(at); got != tt.want {
			t.Errorf("inServiceHours(%s = %s Malé) = %v, want %v", tt.utc, tt.male, got, tt.want)
		}
	}
}

// Watched routes must be polled tightly and everything else slowly; that
// asymmetry is what keeps idle load off RTL.
func TestIntervalsAreOrdered(t *testing.T) {
	if WatchedInterval >= IdleInterval {
		t.Errorf("watched interval %v is not tighter than idle %v", WatchedInterval, IdleInterval)
	}
	// Measured upstream cadence is ~11 s; polling a watched route slower than
	// that would mean routinely missing a position entirely.
	if WatchedInterval > 11*time.Second {
		t.Errorf("watched interval %v exceeds the ~11s upstream cadence", WatchedInterval)
	}
	// ETAs change roughly every 30 s upstream.
	if EtaInterval > 30*time.Second {
		t.Errorf("ETA interval %v exceeds the ~30s upstream change rate", EtaInterval)
	}
}

// --- stale tracks ---

func newTestPoller(t *testing.T) *Poller {
	t.Helper()
	p := New(nil, hub.New(), nil, slog.New(slog.DiscardHandler))
	return p
}

func seed(p *Poller, routeCode, busCode string, updatedAt int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.tracks[routeCode] == nil {
		p.tracks[routeCode] = map[string]*track.Track{}
	}
	p.tracks[routeCode][busCode] = &track.Track{BusCode: busCode, UpdatedAt: updatedAt}
}

// The overnight case: polling stops at 01:00, so without an age bound a client
// connecting at 02:00 gets last night's fleet as a live snapshot.
func TestSnapshotWithholdsStalePositions(t *testing.T) {
	p := newTestPoller(t)
	now := time.Now().UnixMilli()

	seed(p, "133", "fresh", now-10_000)
	seed(p, "133", "stale", now-TrackMaxAge.Milliseconds()-1000)

	got := p.tracksAt("133", now)
	if len(got) != 1 {
		t.Fatalf("snapshot returned %d tracks, want 1", len(got))
	}
	if got[0].BusCode != "fresh" {
		t.Errorf("returned %q, want the fresh bus", got[0].BusCode)
	}
}

// A route polled on the slow idle interval is routinely one cycle old; that is
// perfectly good data and must not be discarded.
func TestIdleIntervalPositionsAreNotConsideredStale(t *testing.T) {
	p := newTestPoller(t)
	now := time.Now().UnixMilli()
	seed(p, "133", "idle", now-IdleInterval.Milliseconds())

	if got := p.tracksAt("133", now); len(got) != 1 {
		t.Errorf("a position one idle cycle old was withheld (%d returned)", len(got))
	}
}

func TestOvernightSnapshotIsEmpty(t *testing.T) {
	p := newTestPoller(t)
	now := time.Now().UnixMilli()
	// Last polled just before service ended; a client connects three hours on.
	seed(p, "133", "B1", now-3*time.Hour.Milliseconds())

	if got := p.tracksAt("133", now); len(got) != 0 {
		t.Errorf("snapshot returned %d tracks three hours after the last poll, want none", len(got))
	}
}

// Withholding is not enough on its own; the fleet must also leave memory.
func TestPruneDropsStaleTracksAndEmptyRoutes(t *testing.T) {
	p := newTestPoller(t)
	now := time.Now().UnixMilli()

	seed(p, "133", "fresh", now-5_000)
	seed(p, "133", "stale", now-TrackMaxAge.Milliseconds()-1)
	seed(p, "132", "alsoStale", now-TrackMaxAge.Milliseconds()-1)

	if dropped := p.pruneStaleTracks(now); dropped != 2 {
		t.Errorf("pruned %d, want 2", dropped)
	}

	p.mu.RLock()
	defer p.mu.RUnlock()
	if len(p.tracks["133"]) != 1 {
		t.Errorf("route 133 kept %d tracks, want 1", len(p.tracks["133"]))
	}
	// A route with nothing left should not linger as an empty map.
	if _, present := p.tracks["132"]; present {
		t.Error("route 132 remained after all its tracks expired")
	}
}

func TestPruneIsSafeWhenNothingIsStale(t *testing.T) {
	p := newTestPoller(t)
	now := time.Now().UnixMilli()
	seed(p, "133", "B1", now)

	if dropped := p.pruneStaleTracks(now); dropped != 0 {
		t.Errorf("pruned %d fresh tracks, want 0", dropped)
	}
	if len(p.tracksAt("133", now)) != 1 {
		t.Error("a fresh track went missing")
	}
}

// The recording floor trades upstream load for archive quality, and both halves
// of that trade have to keep holding.
//
// Tight enough that the history is not under-sampled against the ~11 s feed:
// the first day ran at 20 s and produced recorded gaps clustered at 15–30 s,
// roughly half the resolution available. Loose enough to stay inside the request
// rate upstream was measured to sustain without failures.
func TestIdleIntervalStaysWithinTheMeasuredBudget(t *testing.T) {
	const (
		// Measured per-bus GPS cadence. Polling faster than this returns the
		// same coordinates.
		upstreamCadence = 11 * time.Second
		// The whole network, polled every IdleInterval with nobody connected.
		routes = 15
		// Measured sustained against RTL with no failures.
		toleratedPerSec = 3.0
	)

	if IdleInterval > upstreamCadence {
		t.Errorf("idle interval %v is looser than the %v upstream cadence; the archive would be under-sampled",
			IdleInterval, upstreamCadence)
	}
	if perSec := routes / IdleInterval.Seconds(); perSec > toleratedPerSec {
		t.Errorf("idle load %.2f req/s exceeds the %.1f req/s upstream was measured to sustain",
			perSec, toleratedPerSec)
	}
}
