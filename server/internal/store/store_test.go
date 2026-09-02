package store

import (
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"
)

func openTest(t *testing.T) *DB {
	t.Helper()
	db, err := Open(t.Context(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func ptr(v float64) *float64 { return &v }

func TestInsertAndStats(t *testing.T) {
	db := openTest(t)
	now := time.Now().UnixMilli()

	fixes := []Fix{
		{RouteCode: "133", BusCode: "C1", AtMs: now, Lat: 4.17, Lng: 73.50, Heading: ptr(90), SpeedMps: ptr(8)},
		{RouteCode: "133", BusCode: "C2", AtMs: now, Lat: 4.18, Lng: 73.51},
	}
	if err := db.InsertFixes(t.Context(), fixes); err != nil {
		t.Fatalf("InsertFixes: %v", err)
	}

	stats, err := db.Stats(t.Context())
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if stats.Fixes != 2 {
		t.Errorf("fixes = %d, want 2", stats.Fixes)
	}
	if stats.OldestFixMs != now {
		t.Errorf("oldestFixMs = %d, want %d", stats.OldestFixMs, now)
	}
}

// An empty database must report zeroes rather than failing to scan a NULL.
func TestStatsOnEmptyDatabase(t *testing.T) {
	db := openTest(t)
	stats, err := db.Stats(t.Context())
	if err != nil {
		t.Fatalf("Stats on empty db: %v", err)
	}
	if stats.Fixes != 0 || stats.OldestFixMs != 0 {
		t.Errorf("empty stats = %+v, want zeroes", stats)
	}
}

func TestInsertFixesIsAtomic(t *testing.T) {
	db := openTest(t)
	if err := db.InsertFixes(t.Context(), nil); err != nil {
		t.Errorf("InsertFixes(nil) = %v, want nil", err)
	}
	stats, _ := db.Stats(t.Context())
	if stats.Fixes != 0 {
		t.Errorf("empty batch inserted %d rows", stats.Fixes)
	}
}

// The user's requirement: position history must not accumulate forever.
func TestPruneDropsRawFixesPastRetention(t *testing.T) {
	db := openTest(t)
	now := time.Now()

	fresh := now.Add(-1 * time.Hour).UnixMilli()
	stale := now.Add(-RawRetention - time.Hour).UnixMilli()
	if err := db.InsertFixes(t.Context(), []Fix{
		{RouteCode: "133", BusCode: "C1", AtMs: fresh, Lat: 4.17, Lng: 73.50},
		{RouteCode: "133", BusCode: "C2", AtMs: stale, Lat: 4.17, Lng: 73.50},
		{RouteCode: "133", BusCode: "C3", AtMs: stale, Lat: 4.17, Lng: 73.50},
	}); err != nil {
		t.Fatalf("InsertFixes: %v", err)
	}

	pruned, err := db.Prune(t.Context(), now)
	if err != nil {
		t.Fatalf("Prune: %v", err)
	}
	if pruned.Fixes != 2 {
		t.Errorf("pruned %d fixes, want 2", pruned.Fixes)
	}

	stats, _ := db.Stats(t.Context())
	if stats.Fixes != 1 {
		t.Errorf("%d fixes survived, want 1 (the recent one)", stats.Fixes)
	}
	if stats.OldestFixMs != fresh {
		t.Errorf("oldest surviving fix = %d, want the fresh one %d", stats.OldestFixMs, fresh)
	}
}

// Aggregates outlive raw fixes: that asymmetry is the whole point of the tier.
func TestPruneKeepsAggregatesLongerThanRawFixes(t *testing.T) {
	db := openTest(t)
	now := time.Now()
	// Older than the raw window, comfortably inside the aggregate window.
	old := now.Add(-RawRetention - 24*time.Hour)

	if err := db.InsertFixes(t.Context(), []Fix{
		{RouteCode: "133", BusCode: "C1", AtMs: old.UnixMilli(), Lat: 4.17, Lng: 73.50},
	}); err != nil {
		t.Fatalf("InsertFixes: %v", err)
	}
	if _, err := db.sql.ExecContext(t.Context(), `INSERT INTO stop_arrival
		(route_code, stop_code, bus_code, at_ms, trip_order, sched_min, delta_min, dow, hour)
		VALUES ('133','103','C1',?,1,480.0,3.0,1,8)`, old.UnixMilli()); err != nil {
		t.Fatalf("seed arrival: %v", err)
	}

	if _, err := db.Prune(t.Context(), now); err != nil {
		t.Fatalf("Prune: %v", err)
	}

	stats, _ := db.Stats(t.Context())
	if stats.Fixes != 0 {
		t.Errorf("raw fixes = %d, want 0 (past the 7-day window)", stats.Fixes)
	}
	if stats.Arrivals != 1 {
		t.Errorf("arrivals = %d, want 1 (still inside the 90-day window)", stats.Arrivals)
	}
}

func TestPruneDropsAggregatesPastTheirWindow(t *testing.T) {
	db := openTest(t)
	now := time.Now()
	ancient := now.Add(-AggregateRetention - 24*time.Hour).UnixMilli()

	if _, err := db.sql.ExecContext(t.Context(), `INSERT INTO stop_arrival
		(route_code, stop_code, bus_code, at_ms, dow, hour) VALUES ('133','103','C1',?,1,8)`, ancient); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := db.Prune(t.Context(), now); err != nil {
		t.Fatalf("Prune: %v", err)
	}
	stats, _ := db.Stats(t.Context())
	if stats.Arrivals != 0 {
		t.Errorf("arrivals = %d, want 0 past the aggregate window", stats.Arrivals)
	}
}

func TestTimetableRoundTrip(t *testing.T) {
	db := openTest(t)
	payload, _ := json.Marshal(map[string]any{
		"routeResponse": []map[string]any{{"code": "133", "routeNumber": "R1"}},
	})

	if err := db.PutTimetable(t.Context(), "2026-09-01", payload); err != nil {
		t.Fatalf("PutTimetable: %v", err)
	}
	got, err := db.GetTimetable(t.Context(), "2026-09-01")
	if err != nil {
		t.Fatalf("GetTimetable: %v", err)
	}
	if string(got) != string(payload) {
		t.Errorf("round trip changed the payload:\n got %s\nwant %s", got, payload)
	}
}

// A day this server was not running for is a missing row, not an error.
func TestMissingTimetableIsNotAnError(t *testing.T) {
	db := openTest(t)
	got, err := db.GetTimetable(t.Context(), "1999-01-01")
	if err != nil {
		t.Fatalf("GetTimetable for an unknown day = %v, want nil error", err)
	}
	if got != nil {
		t.Errorf("got %d bytes for an unknown day, want nil", len(got))
	}
}

func TestPutTimetableOverwritesSameDay(t *testing.T) {
	db := openTest(t)
	ctx := t.Context()
	if err := db.PutTimetable(ctx, "2026-09-01", []byte(`{"v":1}`)); err != nil {
		t.Fatalf("first put: %v", err)
	}
	if err := db.PutTimetable(ctx, "2026-09-01", []byte(`{"v":2}`)); err != nil {
		t.Fatalf("second put: %v", err)
	}
	got, _ := db.GetTimetable(ctx, "2026-09-01")
	if string(got) != `{"v":2}` {
		t.Errorf("got %s, want the later payload", got)
	}
	stats, _ := db.Stats(ctx)
	if stats.Days != 1 {
		t.Errorf("days = %d, want 1 row per service date", stats.Days)
	}
}

func TestRecordActivityAccumulates(t *testing.T) {
	db := openTest(t)
	ctx := t.Context()
	base := time.Now().UnixMilli()

	if err := db.RecordActivity(ctx, "2026-09-01", "133", base+1000, 3); err != nil {
		t.Fatalf("RecordActivity: %v", err)
	}
	if err := db.RecordActivity(ctx, "2026-09-01", "133", base, 2); err != nil {
		t.Fatalf("RecordActivity: %v", err)
	}

	activity, err := db.ActivityFor(ctx, "2026-09-01")
	if err != nil {
		t.Fatalf("ActivityFor: %v", err)
	}
	if len(activity) != 1 {
		t.Fatalf("rows = %d, want 1", len(activity))
	}
	got := activity[0]
	if got.FixCount != 5 {
		t.Errorf("fixCount = %d, want 5", got.FixCount)
	}
	if got.FirstMs != base {
		t.Errorf("firstMs = %d, want the earlier %d", got.FirstMs, base)
	}
	if got.LastMs != base+1000 {
		t.Errorf("lastMs = %d, want the later %d", got.LastMs, base+1000)
	}
}

func TestPruneIsIdempotent(t *testing.T) {
	db := openTest(t)
	now := time.Now()
	if err := db.InsertFixes(t.Context(), []Fix{
		{RouteCode: "133", BusCode: "C1", AtMs: now.Add(-RawRetention - time.Hour).UnixMilli()},
	}); err != nil {
		t.Fatalf("InsertFixes: %v", err)
	}
	first, _ := db.Prune(t.Context(), now)
	second, _ := db.Prune(t.Context(), now)
	if first.Fixes != 1 || second.Fixes != 0 {
		t.Errorf("prune passes removed %d then %d, want 1 then 0", first.Fixes, second.Fixes)
	}
}

func TestDeleteTimetable(t *testing.T) {
	db := openTest(t)
	ctx := t.Context()

	if err := db.PutTimetable(ctx, "2026-09-01", []byte(`{"v":1}`)); err != nil {
		t.Fatalf("PutTimetable: %v", err)
	}
	if err := db.DeleteTimetable(ctx, "2026-09-01"); err != nil {
		t.Fatalf("DeleteTimetable: %v", err)
	}
	got, err := db.GetTimetable(ctx, "2026-09-01")
	if err != nil {
		t.Fatalf("GetTimetable: %v", err)
	}
	if got != nil {
		t.Errorf("got %d bytes after delete, want nil", len(got))
	}
}

// The startup check writes and deletes a row; deleting one that is not there
// must not be an error, or a half-finished check would wedge the next deploy.
func TestDeleteMissingTimetableIsNotAnError(t *testing.T) {
	db := openTest(t)
	if err := db.DeleteTimetable(t.Context(), "1999-01-01"); err != nil {
		t.Errorf("DeleteTimetable on a missing day = %v, want nil", err)
	}
}

// auto_vacuum can only be set on an empty database, and SQLite accepts and
// ignores the pragma otherwise. The first deployed database was created with
// journal_mode ahead of it, which allocated page 1 first and left auto_vacuum at
// NONE — making the incremental_vacuum in Prune a silent no-op.
func TestOpenSetsIncrementalAutoVacuum(t *testing.T) {
	db := openTest(t)

	var mode int
	if err := db.sql.QueryRowContext(t.Context(), `PRAGMA auto_vacuum`).Scan(&mode); err != nil {
		t.Fatalf("PRAGMA auto_vacuum: %v", err)
	}
	if mode != 2 {
		t.Errorf("auto_vacuum = %d, want 2 (INCREMENTAL)", mode)
	}
}

// A database already in the field carries auto_vacuum = NONE, which no pragma
// can change on its own. Opening it must repair it, and must not lose its rows.
func TestOpenRepairsALegacyDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")

	// Reproduce the original ordering: journal_mode first, so the auto_vacuum
	// that follows is accepted and ignored.
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := legacy.ExecContext(t.Context(), `
		PRAGMA journal_mode = WAL;
		PRAGMA auto_vacuum = INCREMENTAL;
		CREATE TABLE bus_fix (
			id INTEGER PRIMARY KEY, route_code TEXT NOT NULL, bus_code TEXT NOT NULL,
			at_ms INTEGER NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
			snap_lat REAL, snap_lng REAL, offset_m REAL, heading REAL, speed_mps REAL);
		INSERT INTO bus_fix (route_code, bus_code, at_ms, lat, lng)
			VALUES ('133', 'C1', 1, 4.17, 73.50);`); err != nil {
		t.Fatalf("build legacy db: %v", err)
	}
	var before int
	if err := legacy.QueryRowContext(t.Context(), `PRAGMA auto_vacuum`).Scan(&before); err != nil {
		t.Fatalf("PRAGMA auto_vacuum: %v", err)
	}
	if before != 0 {
		t.Fatalf("legacy fixture is not reproducing the bug: auto_vacuum = %d, want 0", before)
	}
	legacy.Close()

	db, err := Open(t.Context(), path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	var after int
	if err := db.sql.QueryRowContext(t.Context(), `PRAGMA auto_vacuum`).Scan(&after); err != nil {
		t.Fatalf("PRAGMA auto_vacuum: %v", err)
	}
	if after != 2 {
		t.Errorf("auto_vacuum after repair = %d, want 2 (INCREMENTAL)", after)
	}

	stats, err := db.Stats(t.Context())
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if stats.Fixes != 1 {
		t.Errorf("fixes after repair = %d, want the 1 that was there", stats.Fixes)
	}
}

// The snap is only reviewable against the reading it corrected, so the two must
// land in different columns.
func TestInsertKeepsRawAndSnappedApart(t *testing.T) {
	db := openTest(t)

	if err := db.InsertFixes(t.Context(), []Fix{{
		RouteCode: "133", BusCode: "C1", AtMs: 1,
		Lat: 4.1700, Lng: 73.5000,
		SnapLat: ptr(4.1701), SnapLng: ptr(73.5002), OffsetM: ptr(23.4),
	}}); err != nil {
		t.Fatalf("InsertFixes: %v", err)
	}

	var lat, lng, snapLat, snapLng float64
	if err := db.sql.QueryRowContext(t.Context(),
		`SELECT lat, lng, snap_lat, snap_lng FROM bus_fix`).Scan(&lat, &lng, &snapLat, &snapLng); err != nil {
		t.Fatalf("select: %v", err)
	}
	if lat != 4.1700 || lng != 73.5000 {
		t.Errorf("raw = (%v, %v), want the reported (4.17, 73.5)", lat, lng)
	}
	if snapLat != 4.1701 || snapLng != 73.5002 {
		t.Errorf("snapped = (%v, %v), want (4.1701, 73.5002)", snapLat, snapLng)
	}
}

// Every bucketed column is Malé civil time. A bus arriving at 01:30 Malé is an
// hour-1 arrival on a Thursday, not a 20:30 Wednesday one, and getting this
// wrong would scatter each evening's late running into the wrong bucket.
func TestAggregatesBucketInMaleTime(t *testing.T) {
	db := openTest(t)

	// 2026-09-02T20:30:00Z is 01:30 on Thursday 3 September in Malé.
	at := time.Date(2026, 9, 2, 20, 30, 0, 0, time.UTC).UnixMilli()
	if err := db.ReplaceAggregates(t.Context(), "133", at-1000, at+1000,
		[]Arrival{{RouteCode: "133", StopCode: "103", BusCode: "C1", AtMs: at}},
		[]Segment{{RouteCode: "133", FromStop: "103", ToStop: "304", AtMs: at, Secs: 90}},
		[]Headway{{RouteCode: "133", StopCode: "103", AtMs: at, Secs: 600}}); err != nil {
		t.Fatalf("ReplaceAggregates: %v", err)
	}

	for _, table := range []string{"stop_arrival", "segment_obs", "headway_obs"} {
		var dow, hour int
		if err := db.sql.QueryRowContext(t.Context(),
			`SELECT dow, hour FROM `+table).Scan(&dow, &hour); err != nil {
			t.Fatalf("%s: %v", table, err)
		}
		if dow != 4 || hour != 1 {
			t.Errorf("%s bucketed at dow=%d hour=%d, want Thursday (4) at 01:00", table, dow, hour)
		}
	}
}

// A rollup is a pure function of the fixes in its window, so re-running it must
// replace rather than accumulate. Appending would multiply every observation by
// the number of passes that had seen it.
func TestReplaceAggregatesIsIdempotent(t *testing.T) {
	db := openTest(t)
	at := time.Now().UnixMilli()

	write := func() {
		t.Helper()
		if err := db.ReplaceAggregates(t.Context(), "133", at-1000, at+1000,
			[]Arrival{{RouteCode: "133", StopCode: "103", BusCode: "C1", AtMs: at}},
			[]Segment{{RouteCode: "133", FromStop: "103", ToStop: "304", AtMs: at, Secs: 90}},
			[]Headway{{RouteCode: "133", StopCode: "103", AtMs: at, Secs: 600}}); err != nil {
			t.Fatalf("ReplaceAggregates: %v", err)
		}
	}
	write()
	write()
	write()

	stats, err := db.Stats(t.Context())
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if stats.Arrivals != 1 || stats.Segments != 1 || stats.Headways != 1 {
		t.Errorf("after three passes: arrivals=%d segments=%d headways=%d, want 1 each",
			stats.Arrivals, stats.Segments, stats.Headways)
	}
}

// Replacing one window must not disturb another. A rollup of today re-runs every
// half hour; if it cleared more than its own window it would erase the history
// it exists to build.
func TestReplaceAggregatesLeavesOtherWindowsAlone(t *testing.T) {
	db := openTest(t)
	yesterday := time.Now().Add(-24 * time.Hour).UnixMilli()
	today := time.Now().UnixMilli()

	if err := db.ReplaceAggregates(t.Context(), "133", yesterday-1000, yesterday+1000,
		[]Arrival{{RouteCode: "133", StopCode: "103", BusCode: "C1", AtMs: yesterday}}, nil, nil); err != nil {
		t.Fatalf("seed yesterday: %v", err)
	}
	if err := db.ReplaceAggregates(t.Context(), "133", today-1000, today+1000,
		[]Arrival{{RouteCode: "133", StopCode: "103", BusCode: "C2", AtMs: today}}, nil, nil); err != nil {
		t.Fatalf("write today: %v", err)
	}

	stats, err := db.Stats(t.Context())
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if stats.Arrivals != 2 {
		t.Errorf("arrivals = %d, want 2 (yesterday's kept alongside today's)", stats.Arrivals)
	}
}

func TestFixesForRouteReturnsTheSnappedPositionInWindow(t *testing.T) {
	db := openTest(t)
	at := time.Now().UnixMilli()

	if err := db.InsertFixes(t.Context(), []Fix{
		{RouteCode: "133", BusCode: "C1", AtMs: at - 10_000, Lat: 4.17, Lng: 73.50,
			SnapLat: ptr(4.1701), SnapLng: ptr(73.5002)},
		{RouteCode: "133", BusCode: "C1", AtMs: at + 10_000, Lat: 4.18, Lng: 73.51},
		{RouteCode: "999", BusCode: "C9", AtMs: at, Lat: 4.19, Lng: 73.52},
	}); err != nil {
		t.Fatalf("InsertFixes: %v", err)
	}

	got, err := db.FixesForRoute(t.Context(), "133", at-20_000, at)
	if err != nil {
		t.Fatalf("FixesForRoute: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d fixes, want the single one inside the window", len(got))
	}
	if got[0].Lat != 4.1701 || got[0].Lng != 73.5002 {
		t.Errorf("got the raw reading (%v, %v), want the snapped position", got[0].Lat, got[0].Lng)
	}
}
