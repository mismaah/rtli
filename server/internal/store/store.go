// Package store persists what the poller observes.
//
// Two things live here that the client cannot do for itself: the full day's
// timetable (RTL only ever returns departures still to come, so a phone opening
// the app in the evening has no morning) and a history of where buses actually
// were, which is what eventually turns an assumed headway into a measured one.
//
// No user data is stored, ever. Nothing here is keyed to a person, a device or
// a session — only to buses, routes and stops, all of which are public.
package store

import (
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	_ "embed"
	"fmt"
	"io"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schema string

// Retention windows. Raw fixes are bulky and short-lived; what is learned from
// them is small and worth keeping.
//
// RawRetention is 60 days rather than the 7 the tiering intends, because the
// rollup that would distil fixes into stop_arrival, segment_obs and headway_obs
// does not exist yet. Until it does, deleting a fix deletes the only copy of
// what it could have taught, and the ETA-correction work needs weeks of it.
// Drop this back to 7 days once the rollup is running and has backfilled.
//
// Sizing: day one measured ~9.5 MB/day at the old 20 s recording floor. The
// floor is now 10 s and a moving bus clears the jitter radius within either
// interval, so expect roughly double — ~19 MB/day, so ~1.1 GB at 60 days
// against ~130 MB at 7. Worth re-measuring after a day at the new rate.
const (
	RawRetention       = 60 * 24 * time.Hour
	AggregateRetention = 90 * 24 * time.Hour
)

// DB is the persistent store.
type DB struct {
	sql *sql.DB
}

// Open opens (and migrates) the database at path. Use ":memory:" in tests.
func Open(ctx context.Context, path string) (*DB, error) {
	dsn := path
	if path != ":memory:" {
		// _txlock=immediate avoids SQLITE_BUSY under concurrent writers, which
		// the poller and the rollup job both are.
		dsn = path + "?_pragma=busy_timeout(5000)&_txlock=immediate"
	}
	handle, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// SQLite takes one writer at a time; more connections buy contention, not
	// throughput, and this workload is tiny.
	handle.SetMaxOpenConns(1)

	if _, err := handle.ExecContext(ctx, schema); err != nil {
		handle.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	if err := ensureAutoVacuum(ctx, handle); err != nil {
		handle.Close()
		return nil, fmt.Errorf("auto_vacuum: %w", err)
	}
	return &DB{sql: handle}, nil
}

// ensureAutoVacuum repairs a database created before the pragma ordering in
// schema.sql was fixed.
//
// auto_vacuum can only be set on an empty database, so on an existing file the
// pragma alone does nothing — the setting only takes hold across a full VACUUM,
// which rewrites the file. Until it does, Prune's incremental_vacuum is a no-op
// and freed pages are never handed back.
//
// This runs at most once per database: a successful VACUUM leaves auto_vacuum
// reading 2, so the next startup skips it. Doing it on open is deliberate —
// VACUUM needs to copy the whole file, and it is far cheaper to pay that now
// than after the widened raw retention has grown it.
func ensureAutoVacuum(ctx context.Context, handle *sql.DB) error {
	var mode int
	if err := handle.QueryRowContext(ctx, `PRAGMA auto_vacuum`).Scan(&mode); err != nil {
		return err
	}
	if mode != 0 {
		return nil
	}
	if _, err := handle.ExecContext(ctx, `PRAGMA auto_vacuum = INCREMENTAL`); err != nil {
		return err
	}
	// VACUUM cannot run inside a transaction, which is why this is not part of
	// the schema script.
	if _, err := handle.ExecContext(ctx, `VACUUM`); err != nil {
		return err
	}
	return nil
}

func (db *DB) Close() error { return db.sql.Close() }

// Fix is one observed bus position, already corrected onto the route.
type Fix struct {
	RouteCode string
	BusCode   string
	AtMs      int64
	Lat, Lng  float64
	SnapLat   *float64
	SnapLng   *float64
	OffsetM   *float64
	Heading   *float64
	SpeedMps  *float64
}

// InsertFixes records a batch of positions in one transaction.
//
// Callers pass only positions where the bus actually moved: a parked bus
// re-reporting the same coordinates every 11 seconds teaches nothing and would
// be the majority of the table.
func (db *DB) InsertFixes(ctx context.Context, fixes []Fix) error {
	if len(fixes) == 0 {
		return nil
	}
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx, `INSERT INTO bus_fix
		(route_code, bus_code, at_ms, lat, lng, snap_lat, snap_lng, offset_m, heading, speed_mps)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, f := range fixes {
		if _, err := stmt.ExecContext(ctx, f.RouteCode, f.BusCode, f.AtMs, f.Lat, f.Lng,
			f.SnapLat, f.SnapLng, f.OffsetM, f.Heading, f.SpeedMps); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// RecordActivity notes that a route was seen moving, so a route that is simply
// not running today can be told apart from one no itinerary happened to use.
func (db *DB) RecordActivity(ctx context.Context, serviceDate, routeCode string, atMs int64, fixes int) error {
	_, err := db.sql.ExecContext(ctx, `
		INSERT INTO route_activity (service_date, route_code, first_ms, last_ms, fix_count)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (service_date, route_code) DO UPDATE SET
			last_ms   = MAX(last_ms, excluded.last_ms),
			first_ms  = MIN(first_ms, excluded.first_ms),
			fix_count = fix_count + excluded.fix_count`,
		serviceDate, routeCode, atMs, atMs, fixes)
	return err
}

// Activity is a route's observed movement on one service date.
type Activity struct {
	RouteCode string
	FirstMs   int64
	LastMs    int64
	FixCount  int
}

func (db *DB) ActivityFor(ctx context.Context, serviceDate string) ([]Activity, error) {
	rows, err := db.sql.QueryContext(ctx,
		`SELECT route_code, first_ms, last_ms, fix_count FROM route_activity WHERE service_date = ?`,
		serviceDate)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Activity
	for rows.Next() {
		var a Activity
		if err := rows.Scan(&a.RouteCode, &a.FirstMs, &a.LastMs, &a.FixCount); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// PutTimetable stores the merged full-day timetable for a service date.
//
// Gzip'd because it is ~230 KB of highly repetitive JSON and this row is
// rewritten every few minutes all day.
func (db *DB) PutTimetable(ctx context.Context, serviceDate string, payload []byte) error {
	var buf bytes.Buffer
	writer := gzip.NewWriter(&buf)
	if _, err := writer.Write(payload); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	_, err := db.sql.ExecContext(ctx, `
		INSERT INTO day_timetable (service_date, updated_ms, payload) VALUES (?, ?, ?)
		ON CONFLICT (service_date) DO UPDATE SET updated_ms = excluded.updated_ms, payload = excluded.payload`,
		serviceDate, time.Now().UnixMilli(), buf.Bytes())
	return err
}

// GetTimetable returns the stored timetable for a service date, or nil when
// there is none. A missing day is not an error: it is simply a day this server
// was not running for.
func (db *DB) GetTimetable(ctx context.Context, serviceDate string) ([]byte, error) {
	var compressed []byte
	err := db.sql.QueryRowContext(ctx,
		`SELECT payload FROM day_timetable WHERE service_date = ?`, serviceDate).Scan(&compressed)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	return io.ReadAll(reader)
}

// DeleteTimetable removes one service date's stored timetable. Used by the
// startup check to clean up after its write test.
func (db *DB) DeleteTimetable(ctx context.Context, serviceDate string) error {
	_, err := db.sql.ExecContext(ctx, `DELETE FROM day_timetable WHERE service_date = ?`, serviceDate)
	return err
}

// MaleOffset is Malé's fixed civil offset. UTC+05:00, no DST, ever — the same
// assumption ServiceDate and serviceDate() in src/lib/time.ts are built on.
const MaleOffset = 5 * time.Hour

// maleBucket returns the day-of-week (0=Sunday) and hour a moment falls in,
// in Malé civil time. Every bucketed column in this schema uses these, so a
// median "for a Tuesday at 08:00" means a Tuesday morning in Malé rather than
// wherever the server happens to be.
func maleBucket(atMs int64) (dow, hour int) {
	t := time.UnixMilli(atMs).UTC().Add(MaleOffset)
	return int(t.Weekday()), t.Hour()
}

// Arrival is one bus reaching one stop. TripOrder, SchedMin and DeltaMin stay
// nil until there is a stored timetable to compare against.
type Arrival struct {
	RouteCode string
	StopCode  string
	BusCode   string
	AtMs      int64
	TripOrder *int
	SchedMin  *float64
	DeltaMin  *float64
}

// Segment is one observed ride between two adjacent stops.
type Segment struct {
	RouteCode string
	FromStop  string
	ToStop    string
	AtMs      int64
	Secs      float64
}

// Headway is one observed wait between successive buses at a stop.
type Headway struct {
	RouteCode string
	StopCode  string
	AtMs      int64
	Secs      float64
}

// FixRow is a recorded position, read back for rolling up. The snapped position
// is the one returned: it is what was matched to the route when it was recorded,
// so re-deriving from the raw reading would answer a different question.
type FixRow struct {
	BusCode string
	AtMs    int64
	Lat     float64
	Lng     float64
}

// FixesForRoute returns one route's positions over [fromMs, toMs), oldest first.
func (db *DB) FixesForRoute(ctx context.Context, routeCode string, fromMs, toMs int64) ([]FixRow, error) {
	rows, err := db.sql.QueryContext(ctx, `
		SELECT bus_code, at_ms, COALESCE(snap_lat, lat), COALESCE(snap_lng, lng)
		FROM bus_fix
		WHERE route_code = ? AND at_ms >= ? AND at_ms < ?
		ORDER BY bus_code, at_ms`, routeCode, fromMs, toMs)
	if err != nil {
		return nil, fmt.Errorf("fixes: %w", err)
	}
	defer rows.Close()

	var out []FixRow
	for rows.Next() {
		var f FixRow
		if err := rows.Scan(&f.BusCode, &f.AtMs, &f.Lat, &f.Lng); err != nil {
			return nil, fmt.Errorf("fixes: %w", err)
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// ReplaceAggregates swaps in a freshly derived set of aggregates for one route
// over one window, in a single transaction.
//
// Replace rather than append, because a rollup is a pure function of the fixes
// in the window and re-running it must not double the record. The window is
// cleared first: stop_arrival could lean on its unique constraint, but the
// interpolated timestamp shifts by a second or two when the same day is rolled
// up again after more fixes have landed, so the constraint would let near
// duplicates through.
func (db *DB) ReplaceAggregates(ctx context.Context, routeCode string, fromMs, toMs int64,
	arrivals []Arrival, segments []Segment, headways []Headway) error {

	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for _, clear := range []string{
		`DELETE FROM stop_arrival WHERE route_code = ? AND at_ms >= ? AND at_ms < ?`,
		`DELETE FROM segment_obs  WHERE route_code = ? AND at_ms >= ? AND at_ms < ?`,
		`DELETE FROM headway_obs  WHERE route_code = ? AND at_ms >= ? AND at_ms < ?`,
	} {
		if _, err := tx.ExecContext(ctx, clear, routeCode, fromMs, toMs); err != nil {
			return fmt.Errorf("clear aggregates: %w", err)
		}
	}

	arrivalStmt, err := tx.PrepareContext(ctx, `INSERT OR IGNORE INTO stop_arrival
		(route_code, stop_code, bus_code, at_ms, trip_order, sched_min, delta_min, dow, hour)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer arrivalStmt.Close()
	for _, a := range arrivals {
		dow, hour := maleBucket(a.AtMs)
		if _, err := arrivalStmt.ExecContext(ctx, a.RouteCode, a.StopCode, a.BusCode, a.AtMs,
			a.TripOrder, a.SchedMin, a.DeltaMin, dow, hour); err != nil {
			return fmt.Errorf("insert arrival: %w", err)
		}
	}

	segmentStmt, err := tx.PrepareContext(ctx, `INSERT INTO segment_obs
		(route_code, from_stop, to_stop, at_ms, secs, dow, hour) VALUES (?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer segmentStmt.Close()
	for _, s := range segments {
		dow, hour := maleBucket(s.AtMs)
		if _, err := segmentStmt.ExecContext(ctx, s.RouteCode, s.FromStop, s.ToStop,
			s.AtMs, s.Secs, dow, hour); err != nil {
			return fmt.Errorf("insert segment: %w", err)
		}
	}

	headwayStmt, err := tx.PrepareContext(ctx, `INSERT INTO headway_obs
		(route_code, stop_code, at_ms, secs, dow, hour) VALUES (?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer headwayStmt.Close()
	for _, h := range headways {
		dow, hour := maleBucket(h.AtMs)
		if _, err := headwayStmt.ExecContext(ctx, h.RouteCode, h.StopCode,
			h.AtMs, h.Secs, dow, hour); err != nil {
			return fmt.Errorf("insert headway: %w", err)
		}
	}

	return tx.Commit()
}
