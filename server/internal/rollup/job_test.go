package rollup

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/mismaah/rtl-improved/server/internal/geo"
	"github.com/mismaah/rtl-improved/server/internal/rtl"
	"github.com/mismaah/rtl-improved/server/internal/store"
)

func mustParse(t *testing.T, s string) time.Time {
	t.Helper()
	at, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("parse %s: %v", s, err)
	}
	return at
}

// A service day runs 04:00 to 04:00 Malé, not midnight to midnight. Buses run
// past midnight to about 01:00, so cutting at midnight would file the last hour
// of every evening's running under the next morning — and an evening headway
// would land in a bucket labelled 00:xx alongside nothing else.
func TestServiceDayStartCutsAtFourAmMale(t *testing.T) {
	tests := []struct {
		name string
		utc  string
		male string
		want string // service date the moment belongs to
	}{
		{"mid-morning", "2026-09-02T06:00:00Z", "11:00 Wed", "2026-09-02"},
		{"evening", "2026-09-02T16:00:00Z", "21:00 Wed", "2026-09-02"},
		{"just before midnight", "2026-09-02T18:59:00Z", "23:59 Wed", "2026-09-02"},
		{"after midnight, still running", "2026-09-02T20:30:00Z", "01:30 Thu", "2026-09-02"},
		{"the dead hours", "2026-09-02T22:00:00Z", "03:00 Thu", "2026-09-02"},
		{"one minute before the cut", "2026-09-02T22:59:00Z", "03:59 Thu", "2026-09-02"},
		{"exactly at the cut", "2026-09-02T23:00:00Z", "04:00 Thu", "2026-09-03"},
		{"service resumed", "2026-09-03T00:30:00Z", "05:30 Thu", "2026-09-03"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			start := ServiceDayStart(mustParse(t, tt.utc))
			if got := ServiceDate(start); got != tt.want {
				t.Errorf("%s (%s Malé) belongs to service date %s, want %s",
					tt.utc, tt.male, got, tt.want)
			}
			// Whatever the moment, the window it opens must contain it and be
			// exactly one day long.
			at := mustParse(t, tt.utc)
			if at.Before(start) || !at.Before(start.Add(24*time.Hour)) {
				t.Errorf("%s falls outside its own service window starting %s", tt.utc, start)
			}
		})
	}
}

// The window must tile: every service day starts where the last one ended, with
// no hour belonging to both days or to neither.
func TestServiceDaysTileWithoutGaps(t *testing.T) {
	at := mustParse(t, "2026-09-02T06:00:00Z")
	start := ServiceDayStart(at)

	for i := 0; i < 10; i++ {
		next := ServiceDayStart(start.Add(24 * time.Hour))
		if want := start.Add(24 * time.Hour); !next.Equal(want) {
			t.Fatalf("day after %s started at %s, want %s", start, next, want)
		}
		start = next
	}
}

func TestServiceDayStartIgnoresLocalZone(t *testing.T) {
	at := mustParse(t, "2026-09-02T20:30:00Z")
	want := ServiceDayStart(at)

	for _, zone := range []string{"UTC", "America/New_York", "Asia/Tokyo", "Pacific/Kiritimati"} {
		loc, err := time.LoadLocation(zone)
		if err != nil {
			t.Skipf("zone %s unavailable: %v", zone, err)
		}
		if got := ServiceDayStart(at.In(loc)); !got.Equal(want) {
			t.Errorf("ServiceDayStart in %s = %s, want %s", zone, got, want)
		}
	}
}

// fixtureRef stands in for the live poller, serving the captured R1 shape and
// stop list.
type fixtureRef struct {
	stops []rtl.Stop
	lines [][]geo.Point
}

func (f *fixtureRef) Routes() []string                           { return []string{"133"} }
func (f *fixtureRef) RouteGeometry(string) ([][]geo.Point, bool) { return f.lines, true }
func (f *fixtureRef) RouteStops(string) ([]rtl.Stop, bool)       { return f.stops, true }

// The whole path, wired as main.go wires it: fixes in the store, real geometry,
// aggregates out. Catches the wiring faults the pure tests cannot — a window
// that excludes its own data, a reference that never resolves, a service date
// off by a day.
func TestJobRollsUpRecordedFixes(t *testing.T) {
	line, stops := r1(t)

	shapeRaw, err := os.ReadFile(fixtureDir + "roadshape-r1.json")
	if err != nil {
		t.Fatalf("read roadshape: %v", err)
	}
	ref := &fixtureRef{stops: stops, lines: geo.Polylines(shapeRaw)}

	db, err := store.Open(t.Context(), filepath.Join(t.TempDir(), "rollup.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	// A bus driving one lap of R1 at 10 m/s, sampled every 10 s, in the middle
	// of a service day.
	start := mustParse(t, "2026-09-02T06:00:00Z")
	var fixes []store.Fix
	for d := 0.0; d < line.Length(); d += 100 {
		lat, lng := alongR1(line, d)
		fixes = append(fixes, store.Fix{
			RouteCode: "133", BusCode: "C1",
			AtMs: start.Add(time.Duration(d/10) * time.Second).UnixMilli(),
			Lat:  lat, Lng: lng, SnapLat: &lat, SnapLng: &lng,
		})
	}
	if err := db.InsertFixes(t.Context(), fixes); err != nil {
		t.Fatalf("InsertFixes: %v", err)
	}

	job := NewJob(db, ref, slog.New(slog.NewTextHandler(io.Discard, nil)))
	job.Once(t.Context(), start.Add(2*time.Hour))

	stats, err := db.Stats(t.Context())
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	// One lap past 18 stops. The first is only recorded if the bus crosses it
	// after its first fix, so allow the sequence to start mid-route.
	if stats.Arrivals < 15 || stats.Arrivals > 18 {
		t.Errorf("arrivals = %d, want one lap's worth (15-18)", stats.Arrivals)
	}
	if stats.Segments < 14 {
		t.Errorf("segments = %d, want roughly one per stop pair", stats.Segments)
	}
	// One lap crosses each stop once, so no stop has a second arrival to have
	// waited for. A bus going round twice would record laps, flagged SameBus.
	if stats.Headways != 0 {
		t.Errorf("headways = %d, want 0 from a single lap", stats.Headways)
	}
}

// Once only ever looks at today and yesterday, which is right while the
// derivation is stable and wrong the moment it changes: raw fixes outlive the
// aggregates derived from them, so a corrected derivation has to be able to
// reach back over history that is already on disk.
func TestBackfillRederivesOlderDays(t *testing.T) {
	line, stops := r1(t)
	shapeRaw, err := os.ReadFile(fixtureDir + "roadshape-r1.json")
	if err != nil {
		t.Fatalf("read roadshape: %v", err)
	}
	ref := &fixtureRef{stops: stops, lines: geo.Polylines(shapeRaw)}

	db, err := store.Open(t.Context(), filepath.Join(t.TempDir(), "backfill.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	// Four days of laps, the oldest well outside anything Once would look at.
	now := mustParse(t, "2026-09-06T06:00:00Z")
	var fixes []store.Fix
	for day := 1; day <= 4; day++ {
		start := now.AddDate(0, 0, -day)
		for d := 0.0; d < line.Length(); d += 100 {
			lat, lng := alongR1(line, d)
			fixes = append(fixes, store.Fix{
				RouteCode: "133", BusCode: "C1",
				AtMs: start.Add(time.Duration(d/10) * time.Second).UnixMilli(),
				Lat:  lat, Lng: lng, SnapLat: &lat, SnapLng: &lng,
			})
		}
	}
	if err := db.InsertFixes(t.Context(), fixes); err != nil {
		t.Fatalf("InsertFixes: %v", err)
	}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	// What the old behaviour reaches: yesterday, and nothing before it.
	NewJob(db, ref, log).Once(t.Context(), now)
	after, err := db.Stats(t.Context())
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}

	NewJob(db, ref, log).Backfill(t.Context(), now)
	backfilled, err := db.Stats(t.Context())
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}

	if backfilled.Arrivals <= after.Arrivals {
		t.Errorf("backfill derived %d arrivals against Once's %d; the older days "+
			"were never revisited", backfilled.Arrivals, after.Arrivals)
	}
	// Once reaches one of the four days; the backfill reaches all of them.
	if backfilled.Arrivals < 3*after.Arrivals {
		t.Errorf("backfill derived %d arrivals against %d for a single day; it did not "+
			"cover all four", backfilled.Arrivals, after.Arrivals)
	}

	// Idempotent: a day derived twice must end up with one copy, not two.
	NewJob(db, ref, log).Backfill(t.Context(), now)
	again, err := db.Stats(t.Context())
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if again.Arrivals != backfilled.Arrivals {
		t.Errorf("a second backfill changed arrivals from %d to %d; it is not idempotent",
			backfilled.Arrivals, again.Arrivals)
	}
}

// alongR1 returns a latitude and longitude d metres along the fixture line, by
// walking its own geometry.
func alongR1(line *Line, d float64) (lat, lng float64) {
	for i := 1; i < len(line.cum); i++ {
		if line.cum[i] < d || line.breaks[i] {
			continue
		}
		span := line.cum[i] - line.cum[i-1]
		t := 0.0
		if span > 0 {
			t = (d - line.cum[i-1]) / span
		}
		x := line.xs[i-1] + t*(line.xs[i]-line.xs[i-1])
		y := line.ys[i-1] + t*(line.ys[i]-line.ys[i-1])
		return y / metersPerDegLat, x / line.scale
	}
	return line.ys[len(line.ys)-1] / metersPerDegLat, line.xs[len(line.xs)-1] / line.scale
}

// loadingRef reproduces the startup race exactly: the poller publishes the route
// list *before* it fetches the shapes, one per route, so there is a real window
// where Routes() is complete and RouteGeometry is not.
type loadingRef struct {
	stops   []rtl.Stop
	lines   [][]geo.Point
	shapeIn bool // whether the geometry has arrived yet
}

func (l *loadingRef) Routes() []string { return []string{"133"} }
func (l *loadingRef) RouteGeometry(string) ([][]geo.Point, bool) {
	if !l.shapeIn {
		return nil, false
	}
	return l.lines, true
}
func (l *loadingRef) RouteStops(string) ([]rtl.Stop, bool) { return l.stops, true }

// The job and the poller start in the same breath, so the first sweep can land
// before there is any geometry to place stops on. Sweeping then would derive
// nothing, retire every day as finished, and leave the history on whatever it
// was last derived from — which is the one thing the sweep exists to replace.
func TestBackfillWaitsForGeometryBeforeRetiringDays(t *testing.T) {
	line, stops := r1(t)
	shapeRaw, err := os.ReadFile(fixtureDir + "roadshape-r1.json")
	if err != nil {
		t.Fatalf("read roadshape: %v", err)
	}
	ref := &loadingRef{stops: stops, lines: geo.Polylines(shapeRaw)}

	db, err := store.Open(t.Context(), filepath.Join(t.TempDir(), "race.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	now := mustParse(t, "2026-09-06T06:00:00Z")
	var fixes []store.Fix
	for day := 1; day <= 3; day++ {
		start := now.AddDate(0, 0, -day)
		for d := 0.0; d < line.Length(); d += 100 {
			lat, lng := alongR1(line, d)
			fixes = append(fixes, store.Fix{
				RouteCode: "133", BusCode: "C1",
				AtMs: start.Add(time.Duration(d/10) * time.Second).UnixMilli(),
				Lat:  lat, Lng: lng, SnapLat: &lat, SnapLng: &lng,
			})
		}
	}
	if err := db.InsertFixes(t.Context(), fixes); err != nil {
		t.Fatalf("InsertFixes: %v", err)
	}

	job := NewJob(db, ref, slog.New(slog.NewTextHandler(io.Discard, nil)))

	// The shapes have not landed. Nothing may be derived, and nothing may be
	// recorded as finished.
	job.Backfill(t.Context(), now)
	early, err := db.Stats(t.Context())
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if early.Arrivals != 0 {
		t.Fatalf("derived %d arrivals with no geometry loaded", early.Arrivals)
	}

	// The poller finishes, and the next pass on the ticker must still sweep.
	ref.shapeIn = true
	job.Backfill(t.Context(), now)
	after, err := db.Stats(t.Context())
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if after.Arrivals == 0 {
		t.Fatal("the sweep never ran once geometry arrived; the backfill was lost " +
			"to the startup race")
	}

	// And having run, it does not run again.
	if !job.swept {
		t.Error("a completed sweep was not recorded, so it will repeat every pass")
	}
}

// emptyRef is a poller that has not finished discovering routes yet.
type emptyRef struct{}

func (emptyRef) Routes() []string                           { return nil }
func (emptyRef) RouteGeometry(string) ([][]geo.Point, bool) { return nil, false }
func (emptyRef) RouteStops(string) ([]rtl.Stop, bool)       { return nil, false }

// The job and the poller start together, and the poller discovers its routes
// over the network, so the job's first pass routinely runs against an empty
// route list. Retiring the previous service day on that pass would derive
// nothing from it and never come back to it.
func TestJobDoesNotRetireADayItCouldNotRollUp(t *testing.T) {
	line, stops := r1(t)

	shapeRaw, err := os.ReadFile(fixtureDir + "roadshape-r1.json")
	if err != nil {
		t.Fatalf("read roadshape: %v", err)
	}

	db, err := store.Open(t.Context(), filepath.Join(t.TempDir(), "rollup.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	// Yesterday's lap, recorded and waiting to be rolled up.
	yesterday := mustParse(t, "2026-09-02T06:00:00Z")
	var fixes []store.Fix
	for d := 0.0; d < line.Length(); d += 100 {
		lat, lng := alongR1(line, d)
		fixes = append(fixes, store.Fix{
			RouteCode: "133", BusCode: "C1",
			AtMs: yesterday.Add(time.Duration(d/10) * time.Second).UnixMilli(),
			Lat:  lat, Lng: lng, SnapLat: &lat, SnapLng: &lng,
		})
	}
	if err := db.InsertFixes(t.Context(), fixes); err != nil {
		t.Fatalf("InsertFixes: %v", err)
	}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	job := NewJob(db, emptyRef{}, log)

	// First pass, before the route list has loaded.
	now := yesterday.Add(26 * time.Hour)
	job.Once(t.Context(), now)

	stats, _ := db.Stats(t.Context())
	if stats.Arrivals != 0 {
		t.Fatalf("a job with no routes derived %d arrivals", stats.Arrivals)
	}

	// Routes arrive; the same job must still pick yesterday up.
	job.ref = &fixtureRef{stops: stops, lines: geo.Polylines(shapeRaw)}
	job.Once(t.Context(), now)

	stats, _ = db.Stats(t.Context())
	if stats.Arrivals == 0 {
		t.Error("yesterday was retired by the pass that could not read it, and never rolled up")
	}
}
