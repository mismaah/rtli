package rollup

import (
	"context"
	"log/slog"
	"time"

	"github.com/mismaah/rtl-improved/server/internal/geo"
	"github.com/mismaah/rtl-improved/server/internal/rtl"
	"github.com/mismaah/rtl-improved/server/internal/store"
)

const (
	// Interval between passes. Well inside a service day, so the aggregates
	// stay roughly current without re-deriving the same day continuously.
	Interval = 30 * time.Minute

	// MaleOffset is Malé civil time: UTC+05:00, no DST, ever.
	MaleOffset = 5 * time.Hour

	// ServiceDayStartHour is when a service date's window opens in Malé time.
	// Buses report from about 04:00 and run past midnight to 01:00, so a
	// service date's fixes span 04:00 through to 04:00 the next morning. Slicing
	// at midnight would cut every night's last hour of running onto the wrong
	// day and make an evening headway look like a morning one.
	ServiceDayStartHour = 4
)

// Reference supplies what a rollup needs to know about a route beyond its
// recorded positions: where it goes, and where its stops are along it.
type Reference interface {
	Routes() []string
	RouteGeometry(routeCode string) ([][]geo.Point, bool)
	RouteStops(routeCode string) ([]rtl.Stop, bool)
}

// Job derives aggregates from recorded fixes on a schedule.
//
// It exists because raw fixes are pruned at store.RawRetention and these are
// not: a fix that expires before it has been rolled up takes everything it
// could have taught with it. That is not a hypothetical — the recorder shipped
// months before this did, and the whole first period of history was being
// deleted a week at a time with nothing derived from it.
type Job struct {
	store *store.DB
	ref   Reference
	log   *slog.Logger

	// Service dates already rolled up to completion, so a finished day is not
	// re-derived on every pass. Deliberately in memory rather than persisted:
	// losing it on restart costs one redundant pass, and ReplaceAggregates is
	// idempotent, so the failure mode is wasted work rather than wrong data.
	done map[string]bool

	// Line geometry is fixed for the life of a route and expensive enough to
	// measure that it is worth keeping between passes.
	lines map[string]*Line
}

func NewJob(db *store.DB, ref Reference, log *slog.Logger) *Job {
	return &Job{store: db, ref: ref, log: log, done: map[string]bool{}, lines: map[string]*Line{}}
}

// MaxBackfillDays bounds a backfill, so a database whose raw retention has been
// widened cannot turn one restart into an hours-long re-derivation. Raw fixes
// live store.RawRetention; this is the most of that a single startup will chew
// through, and a later restart picks up whatever is left.
const MaxBackfillDays = 90

// Run rolls up on a ticker until ctx is cancelled, starting with a backfill so
// a restart does not leave the aggregates a full interval behind — and so a
// change to how they are derived reaches the history as well as today.
func (j *Job) Run(ctx context.Context) {
	j.Backfill(ctx, time.Now())

	ticker := time.NewTicker(Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			j.Once(ctx, now)
		}
	}
}

// Backfill re-derives every service day still covered by raw fixes, oldest
// first, then hands over to the ordinary two-day pass.
//
// Once alone only ever looks at today and yesterday, which is right while the
// derivation is stable and wrong the moment it changes: a fix that was recorded
// weeks ago is still on disk, still the only evidence of an arrival, and nothing
// would ever revisit it. Both of the corrections this shipped alongside — the
// stop resolver that had been dropping six routes to a single stop each, and the
// schedule matching that had never run at all — apply to history that is already
// recorded, and are worth nothing until something re-reads it.
//
// Safe to run repeatedly. ReplaceAggregates clears each route's window before
// inserting, so a day derived twice ends up with one copy, not two.
func (j *Job) Backfill(ctx context.Context, now time.Time) {
	stats, err := j.store.Stats(ctx)
	if err != nil {
		j.log.Warn("backfill could not read store stats", "err", err)
		j.Once(ctx, now)
		return
	}

	current := ServiceDayStart(now)
	if stats.OldestFixMs <= 0 {
		j.Once(ctx, now)
		return
	}

	from := ServiceDayStart(time.UnixMilli(stats.OldestFixMs))
	if earliest := current.AddDate(0, 0, -MaxBackfillDays); from.Before(earliest) {
		from = earliest
	}

	started := time.Now()
	days := 0
	for day := from; day.Before(current); day = day.Add(24 * time.Hour) {
		select {
		case <-ctx.Done():
			return
		default:
		}
		if j.rollUp(ctx, day, day.Add(24*time.Hour)) > 0 {
			// A completed day, derived from every fix it will ever have. Mark it
			// so the ordinary pass does not queue it up again.
			j.done[ServiceDate(day)] = true
			days++
		}
	}
	if days > 0 {
		j.log.Info("backfill complete", "days", days,
			"from", ServiceDate(from), "took", time.Since(started).Round(time.Millisecond))
	}

	j.Once(ctx, now)
}

// Once rolls up the service day in progress, and the previous one if it has
// ended and has not been finished off yet.
func (j *Job) Once(ctx context.Context, now time.Time) {
	current := ServiceDayStart(now)
	j.rollUp(ctx, current, now)

	previous := current.Add(-24 * time.Hour)
	key := ServiceDate(previous)
	if !j.done[key] {
		// The previous day is complete only once the current one has opened,
		// which ServiceDayStart guarantees by construction.
		//
		// Marked done only if the pass actually had routes to work with. The
		// job starts at the same moment as the poller, which discovers the
		// route list over the network, so the first pass routinely runs before
		// there is anything to roll up. Marking it done regardless would retire
		// yesterday having derived nothing from it, and nothing would revisit
		// it for the life of the process.
		if j.rollUp(ctx, previous, current) > 0 {
			j.done[key] = true
		}
	}
}

// rollUp derives and stores every route's aggregates for [from, to), returning
// how many routes it successfully stored.
func (j *Job) rollUp(ctx context.Context, from, to time.Time) int {
	fromMs, toMs := from.UnixMilli(), to.UnixMilli()
	started := time.Now()
	var arrivals, segments, headways, routes int

	for _, routeCode := range j.ref.Routes() {
		select {
		case <-ctx.Done():
			return routes
		default:
		}

		line, refs, sched, ok := j.reference(routeCode)
		if !ok {
			continue
		}

		fixes, err := j.store.FixesForRoute(ctx, routeCode, fromMs, toMs)
		if err != nil {
			j.log.Warn("rollup could not read fixes", "routeCode", routeCode, "err", err)
			continue
		}
		if len(fixes) == 0 {
			continue
		}

		derived := make([]Fix, 0, len(fixes))
		for _, f := range fixes {
			derived = append(derived, Fix{BusCode: f.BusCode, AtMs: f.AtMs, Lat: f.Lat, Lng: f.Lng})
		}

		a := Annotate(Arrivals(derived, refs, line), sched)
		s := Segments(a, refs)
		h := Headways(a)

		if err := j.store.ReplaceAggregates(ctx, routeCode, fromMs, toMs,
			storeArrivals(routeCode, a), storeSegments(routeCode, s), storeHeadways(routeCode, h)); err != nil {
			j.log.Warn("rollup could not store aggregates", "routeCode", routeCode, "err", err)
			continue
		}
		arrivals, segments, headways = arrivals+len(a), segments+len(s), headways+len(h)
		routes++
	}

	if routes == 0 {
		// Nothing to say, and nothing was learned. Silent so a restart before
		// the route list has loaded does not look like a failure.
		return 0
	}
	j.log.Info("rollup pass complete",
		"serviceDate", ServiceDate(from), "routes", routes,
		"arrivals", arrivals, "segments", segments, "headways", headways,
		"took", time.Since(started).Round(time.Millisecond))
	return routes
}

// reference resolves a route's geometry, stop positions and timetable, caching
// what is expensive to rebuild.
func (j *Job) reference(routeCode string) (*Line, []StopRef, *Schedule, bool) {
	stops, ok := j.ref.RouteStops(routeCode)
	if !ok || len(stops) == 0 {
		return nil, nil, nil, false
	}
	line, cached := j.lines[routeCode]
	if !cached {
		lines, ok := j.ref.RouteGeometry(routeCode)
		if !ok {
			// A route whose shape never loaded cannot be linearly referenced,
			// so its positions stay raw rather than being guessed at.
			return nil, nil, nil, false
		}
		line = NewLine(lines)
		j.lines[routeCode] = line
	}
	if line == nil {
		return nil, nil, nil, false
	}
	refs := ResolveStops(stops, line)
	if len(refs) == 0 {
		return nil, nil, nil, false
	}
	// Not cached: the published timetable is reloaded by the poller through the
	// day, and a stale copy here would measure lateness against yesterday.
	// Building it is a walk over one route's stops, which is nothing beside the
	// arrival derivation it feeds.
	return line, refs, NewSchedule(stops), true
}

// ServiceDate is the Malé civil date a moment belongs to. Matches
// poller.ServiceDate and serviceDate() in src/lib/time.ts.
func ServiceDate(t time.Time) string {
	return t.UTC().Add(MaleOffset).Format("2006-01-02")
}

// ServiceDayStart is the most recent 04:00 Malé at or before now, as a UTC
// instant. Fixes from that moment to the next one belong to that service date.
func ServiceDayStart(now time.Time) time.Time {
	male := now.UTC().Add(MaleOffset)
	start := time.Date(male.Year(), male.Month(), male.Day(), ServiceDayStartHour, 0, 0, 0, time.UTC)
	if male.Before(start) {
		start = start.Add(-24 * time.Hour)
	}
	return start.Add(-MaleOffset)
}

func storeArrivals(routeCode string, in []Arrival) []store.Arrival {
	out := make([]store.Arrival, 0, len(in))
	for _, a := range in {
		out = append(out, store.Arrival{
			RouteCode: routeCode, StopCode: a.StopCode, BusCode: a.BusCode, AtMs: a.AtMs,
			TripOrder: a.TripOrder, SchedMin: a.SchedMin, DeltaMin: a.DeltaMin,
		})
	}
	return out
}

func storeSegments(routeCode string, in []Segment) []store.Segment {
	out := make([]store.Segment, 0, len(in))
	for _, s := range in {
		out = append(out, store.Segment{
			RouteCode: routeCode, FromStop: s.FromStop, ToStop: s.ToStop, AtMs: s.AtMs, Secs: s.Secs,
		})
	}
	return out
}

func storeHeadways(routeCode string, in []Headway) []store.Headway {
	out := make([]store.Headway, 0, len(in))
	for _, h := range in {
		out = append(out, store.Headway{
			RouteCode: routeCode, StopCode: h.StopCode, AtMs: h.AtMs, Secs: h.Secs,
			SameBus: h.SameBus,
		})
	}
	return out
}
