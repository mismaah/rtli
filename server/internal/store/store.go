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
const (
	RawRetention       = 7 * 24 * time.Hour
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
	return &DB{sql: handle}, nil
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
