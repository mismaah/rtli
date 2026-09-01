package store

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// Pruned reports what a retention pass removed.
type Pruned struct {
	Fixes      int64
	Arrivals   int64
	Segments   int64
	Headways   int64
	Timetables int64
}

func (p Pruned) Total() int64 {
	return p.Fixes + p.Arrivals + p.Segments + p.Headways + p.Timetables
}

// Prune enforces the retention windows.
//
// Raw fixes go at 7 days and the aggregates derived from them at 90. The order
// matters: rollups must already have run, because once a fix is deleted what it
// could have taught is gone. RunRetention below sequences the two correctly.
func (db *DB) Prune(ctx context.Context, now time.Time) (Pruned, error) {
	rawCutoff := now.Add(-RawRetention).UnixMilli()
	aggCutoff := now.Add(-AggregateRetention).UnixMilli()
	aggDate := now.Add(-AggregateRetention).Format("2006-01-02")

	var pruned Pruned
	steps := []struct {
		into  *int64
		query string
		arg   any
	}{
		{&pruned.Fixes, `DELETE FROM bus_fix WHERE at_ms < ?`, rawCutoff},
		{&pruned.Arrivals, `DELETE FROM stop_arrival WHERE at_ms < ?`, aggCutoff},
		{&pruned.Segments, `DELETE FROM segment_obs WHERE at_ms < ?`, aggCutoff},
		{&pruned.Headways, `DELETE FROM headway_obs WHERE at_ms < ?`, aggCutoff},
		{&pruned.Timetables, `DELETE FROM day_timetable WHERE service_date < ?`, aggDate},
		{new(int64), `DELETE FROM route_activity WHERE service_date < ?`, aggDate},
	}
	for _, step := range steps {
		res, err := db.sql.ExecContext(ctx, step.query, step.arg)
		if err != nil {
			return pruned, fmt.Errorf("prune: %w", err)
		}
		affected, _ := res.RowsAffected()
		*step.into = affected
	}

	// Hand the freed pages back rather than letting the file only ever grow.
	if _, err := db.sql.ExecContext(ctx, `PRAGMA incremental_vacuum`); err != nil {
		return pruned, fmt.Errorf("vacuum: %w", err)
	}
	return pruned, nil
}

// RunRetention prunes hourly until ctx is cancelled, running once at startup so
// a long-stopped server reclaims disk immediately rather than after an hour.
//
// There is no rollup step to sequence before it: arrivals, segment times and
// headways are derived online as fixes arrive, while the route graph is already
// in memory, so nothing is waiting to be learned from a fix by the time it is
// old enough to delete.
func (db *DB) RunRetention(ctx context.Context, log *slog.Logger) {
	tick := func() {
		start := time.Now()
		pruned, err := db.Prune(ctx, start)
		if err != nil {
			log.Error("prune failed", "err", err)
			return
		}
		if pruned.Total() > 0 {
			log.Info("retention pass complete",
				"fixes", pruned.Fixes, "arrivals", pruned.Arrivals,
				"segments", pruned.Segments, "headways", pruned.Headways,
				"timetables", pruned.Timetables, "took", time.Since(start))
		}
	}

	tick()
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			tick()
		}
	}
}

// Stats reports current table sizes, for /v1/meta and for judging whether the
// history is deep enough to be trusted yet.
type Stats struct {
	Fixes       int64 `json:"fixes"`
	Arrivals    int64 `json:"arrivals"`
	Segments    int64 `json:"segments"`
	Headways    int64 `json:"headways"`
	Days        int64 `json:"days"`
	OldestFixMs int64 `json:"oldestFixMs"`
}

func (db *DB) Stats(ctx context.Context) (Stats, error) {
	var s Stats
	rows := map[string]*int64{
		`SELECT COUNT(*) FROM bus_fix`:       &s.Fixes,
		`SELECT COUNT(*) FROM stop_arrival`:  &s.Arrivals,
		`SELECT COUNT(*) FROM segment_obs`:   &s.Segments,
		`SELECT COUNT(*) FROM headway_obs`:   &s.Headways,
		`SELECT COUNT(*) FROM day_timetable`: &s.Days,
	}
	for query, into := range rows {
		if err := db.sql.QueryRowContext(ctx, query).Scan(into); err != nil {
			return s, err
		}
	}
	// COALESCE: an empty table yields NULL, which will not scan into an int64.
	if err := db.sql.QueryRowContext(ctx,
		`SELECT COALESCE(MIN(at_ms), 0) FROM bus_fix`).Scan(&s.OldestFixMs); err != nil {
		return s, err
	}
	return s, nil
}
