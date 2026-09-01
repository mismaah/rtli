package store

import (
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
