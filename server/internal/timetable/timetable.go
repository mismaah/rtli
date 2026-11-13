// Package timetable accumulates each service day's whole timetable.
//
// RTL's routedetails only ever lists departures still to come. A single fetch
// is therefore a timetable with a hole where the day so far should be, and the
// size of the hole depends on nothing more meaningful than when the fetch
// happened. The first deployment took one such snapshot at startup — 07:15 —
// and measured every arrival for two months against it: nothing before 07:15
// could ever match, so the whole morning peak went unmeasured, and in the
// weeks a restart had happened at 20:33 only one arrival in seven matched.
//
// The fix is the one the client already applies in IndexedDB: merge every
// response into a per-day store keyed by (route, stop, trip), so the day fills
// in rather than drains away. Done here as well because the server is the one
// thing awake at 04:00 to see the day whole, and because the rollup needs the
// day an arrival happened on, not whatever is left of today.
package timetable

import (
	"context"
	"encoding/json"
	"log/slog"
	"maps"
	"sort"
	"sync"
	"time"

	"github.com/mismaah/rtl-improved/server/internal/rtl"
	"github.com/mismaah/rtl-improved/server/internal/store"
)

// CompleteWithinMin is how soon after the service day opens a capture must
// begin to count as whole. RTL lists departures still to come, so a day first
// fetched before its first departure has seen all of them. The graph is
// refreshed every few minutes around the clock, so an uninterrupted server
// captures each day within minutes of 04:00; one that only starts later in the
// day is missing whatever already left.
const CompleteWithinMin = 20

// maxCached bounds how many stored days are kept parsed in memory. A rollup
// sweep walks days in order and nearly all of them resolve to the same one or
// two references, so a handful is plenty.
const maxCached = 8

// Timings is a day's departures: route code -> stop code -> departures, in
// trip order.
type Timings map[string]map[string][]rtl.Timing

// Source says which day a Timings was taken from.
type Source struct {
	// Date is the service date whose capture supplied the bulk of the times.
	Date string
	// Own is true when that is the day that was asked for.
	Own bool
	// Complete is true when the times cover the whole day.
	Complete bool
}

// Store persists captured days. Satisfied by *store.DB.
type Store interface {
	PutTimetable(ctx context.Context, serviceDate string, payload []byte, firstMs int64, complete bool) error
	GetTimetable(ctx context.Context, serviceDate string) ([]byte, error)
	ListTimetables(ctx context.Context) ([]store.TimetableInfo, error)
}

// tripTimes is route -> stop -> trip order -> "HH:MM:SS", the shape a merge
// works in: keyed by trip, so a departure seen twice is stored once.
type tripTimes map[string]map[string]map[int]string

type day struct {
	date     string
	firstMs  int64
	complete bool
	times    tripTimes
}

// Book is the accumulated timetable, today's in memory and every day's on disk.
type Book struct {
	store Store
	log   *slog.Logger

	mu    sync.Mutex
	today *day
	// cache holds parsed stored days other than today, oldest-loaded first.
	cache      map[string]*day
	cacheOrder []string
	// completeTypes records which day types have a complete day stored, and
	// generation counts how many times that set has grown. A rollup compares
	// generations to learn that history derived against a stand-in can now be
	// derived against something better.
	completeTypes map[string]bool
	generation    int
}

// New returns a book persisting through st, which may be nil for a server
// without a store: it still merges, it just forgets on restart.
func New(st Store, log *slog.Logger) *Book {
	if log == nil {
		log = slog.Default()
	}
	return &Book{store: st, log: log, cache: map[string]*day{}, completeTypes: map[string]bool{}}
}

// Load reads what is already stored, so a restart mid-day resumes today's
// capture instead of starting a new, incomplete one.
func (b *Book) Load(ctx context.Context, now time.Time) error {
	if b.store == nil {
		return nil
	}
	infos, err := b.store.ListTimetables(ctx)
	if err != nil {
		return err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, info := range infos {
		if info.Complete {
			b.completeTypes[store.DayType(info.ServiceDate)] = true
		}
	}
	if len(b.completeTypes) > 0 {
		b.generation = 1
	}
	if date, ok := captureDate(now); ok {
		if d := b.loadLocked(ctx, date); d != nil {
			b.today = d
		}
	}
	return nil
}

// Generation changes whenever a day type gains its first complete day.
func (b *Book) Generation() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.generation
}

// Merge folds one routedetails response into the day it was fetched on and
// returns the response with every departure seen that day, not just the ones
// still to come.
//
// Responses fetched before the service day opens are passed through untouched.
// Between midnight and 04:00 it is not clear which day RTL is describing — the
// tail of yesterday or the whole of today — and filing trips under the wrong
// date would collide trip numbers across days. Nothing is lost by waiting: the
// post-midnight tail was already listed before midnight, and the new day is
// listed whole at 04:00.
func (b *Book) Merge(ctx context.Context, details rtl.RouteDetails, at time.Time) rtl.RouteDetails {
	date, ok := captureDate(at)
	if !ok {
		return details
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	fresh := false
	if b.today == nil || b.today.date != date {
		b.today = b.loadLocked(ctx, date)
		if b.today == nil {
			b.today = &day{
				date:     date,
				firstMs:  at.UnixMilli(),
				complete: minutesIntoServiceDay(at) <= CompleteWithinMin,
				times:    tripTimes{},
			}
			fresh = true
			if !b.today.complete {
				b.log.Info("timetable capture began after the day's first departures; using a stand-in for the morning",
					"serviceDate", date)
			}
		}
	}

	changed := b.today.times.merge(details)
	merged := apply(details, b.today.times)

	if (changed || fresh) && b.store != nil {
		payload, err := json.Marshal(merged)
		if err == nil {
			err = b.store.PutTimetable(ctx, date, payload, b.today.firstMs, b.today.complete)
		}
		if err != nil {
			b.log.Warn("could not store the day's timetable", "serviceDate", date, "err", err)
		}
	}
	if b.today.complete {
		if dayType := store.DayType(date); !b.completeTypes[dayType] {
			b.completeTypes[dayType] = true
			b.generation++
		}
	}
	return merged
}

// For returns the timetable to measure a service date's arrivals against.
//
// The day's own capture when it is complete. Otherwise the nearest complete
// day of the same type (Sun–Thu, Friday, Saturday) — or of any type, failing
// that — with whatever the day's own partial capture saw laid over it, since
// those are its real times. Only when nothing complete exists at all is the
// partial capture returned alone, flagged incomplete. ok is false when there is
// nothing for that date whatsoever, and the caller has only RTL's current
// snapshot to fall back on.
func (b *Book) For(ctx context.Context, serviceDate string) (Timings, Source, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()

	own := b.dayLocked(ctx, serviceDate)
	if own != nil && own.complete {
		return own.times.export(), Source{Date: serviceDate, Own: true, Complete: true}, true
	}

	if stand := b.standInLocked(ctx, serviceDate); stand != nil {
		times := stand.times.clone()
		if own != nil {
			times.overlay(own.times)
		}
		return times.export(), Source{Date: stand.date, Own: false, Complete: true}, true
	}
	if own != nil {
		return own.times.export(), Source{Date: serviceDate, Own: true, Complete: false}, true
	}
	return nil, Source{}, false
}

// Day returns details with serviceDate's whole timetable in place of what RTL
// is listing now, for planning a day other than today: the routes and stops are
// today's, the departures are that day's — its own capture, or the stand-in For
// chooses. ok is false when there is no timetable to give.
//
// Every stop's timings are replaced, including with nothing, rather than merged
// as Merge does: what RTL lists now is today's, and a stop the day's timetable
// has no departures at is a stop that day has none at.
func (b *Book) Day(ctx context.Context, serviceDate string, details rtl.RouteDetails) (rtl.RouteDetails, Source, bool) {
	timings, source, ok := b.For(ctx, serviceDate)
	if !ok {
		return details, Source{}, false
	}
	return replaceTimings(details, timings), source, true
}

// standInLocked picks the complete day nearest in time to serviceDate,
// preferring one of the same day type.
func (b *Book) standInLocked(ctx context.Context, serviceDate string) *day {
	if b.store == nil {
		return nil
	}
	infos, err := b.store.ListTimetables(ctx)
	if err != nil {
		b.log.Warn("could not list stored timetables", "err", err)
		return nil
	}
	target, err := time.Parse("2006-01-02", serviceDate)
	if err != nil {
		return nil
	}
	wantType := store.DayType(serviceDate)

	best, bestSameType := "", ""
	var bestGap, bestSameGap time.Duration
	for _, info := range infos {
		if !info.Complete || info.ServiceDate == serviceDate {
			continue
		}
		when, err := time.Parse("2006-01-02", info.ServiceDate)
		if err != nil {
			continue
		}
		gap := when.Sub(target)
		if gap < 0 {
			gap = -gap
		}
		if best == "" || gap < bestGap {
			best, bestGap = info.ServiceDate, gap
		}
		if store.DayType(info.ServiceDate) == wantType && (bestSameType == "" || gap < bestSameGap) {
			bestSameType, bestSameGap = info.ServiceDate, gap
		}
	}
	if bestSameType != "" {
		best = bestSameType
	}
	if best == "" {
		return nil
	}
	return b.dayLocked(ctx, best)
}

// dayLocked returns a day from memory or the store, or nil.
func (b *Book) dayLocked(ctx context.Context, date string) *day {
	if b.today != nil && b.today.date == date {
		return b.today
	}
	if d, ok := b.cache[date]; ok {
		return d
	}
	return b.loadLocked(ctx, date)
}

// loadLocked reads a stored day into the cache.
func (b *Book) loadLocked(ctx context.Context, date string) *day {
	if b.store == nil {
		return nil
	}
	payload, err := b.store.GetTimetable(ctx, date)
	if err != nil {
		b.log.Warn("could not read a stored timetable", "serviceDate", date, "err", err)
		return nil
	}
	if payload == nil {
		return nil
	}
	var details rtl.RouteDetails
	if err := json.Unmarshal(payload, &details); err != nil {
		b.log.Warn("stored timetable is unreadable", "serviceDate", date, "err", err)
		return nil
	}
	infos, err := b.store.ListTimetables(ctx)
	if err != nil {
		return nil
	}
	d := &day{date: date, times: tripTimes{}}
	for _, info := range infos {
		if info.ServiceDate == date {
			d.firstMs, d.complete = info.FirstMs, info.Complete
		}
	}
	d.times.merge(details)

	if _, ok := b.cache[date]; !ok {
		b.cacheOrder = append(b.cacheOrder, date)
	}
	b.cache[date] = d
	for len(b.cacheOrder) > maxCached {
		delete(b.cache, b.cacheOrder[0])
		b.cacheOrder = b.cacheOrder[1:]
	}
	return d
}

// merge adds every departure in details, reporting whether any was new or
// changed.
func (t tripTimes) merge(details rtl.RouteDetails) bool {
	changed := false
	for _, route := range details.RouteResponse {
		for _, stop := range route.BusRouteStopList {
			if len(stop.Timings) == 0 {
				continue
			}
			if t[route.Code] == nil {
				t[route.Code] = map[string]map[int]string{}
			}
			trips := t[route.Code][stop.Code]
			if trips == nil {
				trips = map[int]string{}
				t[route.Code][stop.Code] = trips
			}
			for _, timing := range stop.Timings {
				if trips[timing.Order] != timing.Timing {
					trips[timing.Order] = timing.Timing
					changed = true
				}
			}
		}
	}
	return changed
}

// overlay copies every departure in other over t.
func (t tripTimes) overlay(other tripTimes) {
	for route, stops := range other {
		if t[route] == nil {
			t[route] = map[string]map[int]string{}
		}
		for stop, trips := range stops {
			if t[route][stop] == nil {
				t[route][stop] = map[int]string{}
			}
			maps.Copy(t[route][stop], trips)
		}
	}
}

func (t tripTimes) clone() tripTimes {
	out := tripTimes{}
	out.overlay(t)
	return out
}

// export converts to the per-stop lists a schedule is built from.
func (t tripTimes) export() Timings {
	out := Timings{}
	for route, stops := range t {
		out[route] = map[string][]rtl.Timing{}
		for stop, trips := range stops {
			out[route][stop] = sortedTimings(trips)
		}
	}
	return out
}

func sortedTimings(trips map[int]string) []rtl.Timing {
	list := make([]rtl.Timing, 0, len(trips))
	for order, timing := range trips {
		list = append(list, rtl.Timing{Order: order, Timing: timing})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Order < list[j].Order })
	return list
}

// apply returns details with each stop's timings replaced by the merged set.
// Copies what it changes, so the caller's response is left as RTL sent it.
func apply(details rtl.RouteDetails, times tripTimes) rtl.RouteDetails {
	out := details
	out.RouteResponse = make([]rtl.Route, len(details.RouteResponse))
	for i, route := range details.RouteResponse {
		out.RouteResponse[i] = route
		perStop := times[route.Code]
		if perStop == nil {
			continue
		}
		stops := make([]rtl.Stop, len(route.BusRouteStopList))
		for j, stop := range route.BusRouteStopList {
			stops[j] = stop
			if trips := perStop[stop.Code]; len(trips) > 0 {
				stops[j].Timings = sortedTimings(trips)
			}
		}
		out.RouteResponse[i].BusRouteStopList = stops
	}
	return out
}

// replaceTimings returns details carrying exactly timings, every stop's own
// set or an empty one. Copies what it changes, as apply does.
func replaceTimings(details rtl.RouteDetails, timings Timings) rtl.RouteDetails {
	out := details
	out.RouteResponse = make([]rtl.Route, len(details.RouteResponse))
	for i, route := range details.RouteResponse {
		out.RouteResponse[i] = route
		perStop := timings[route.Code]
		stops := make([]rtl.Stop, len(route.BusRouteStopList))
		for j, stop := range route.BusRouteStopList {
			stops[j] = stop
			stops[j].Timings = perStop[stop.Code]
			if stops[j].Timings == nil {
				stops[j].Timings = []rtl.Timing{}
			}
		}
		out.RouteResponse[i].BusRouteStopList = stops
	}
	return out
}

// captureDate is the service date a fetch at `at` should be filed under, and
// false between midnight and the service day opening.
func captureDate(at time.Time) (string, bool) {
	male := at.UTC().Add(store.MaleOffset)
	if male.Hour() < store.ServiceDayStartHour {
		return "", false
	}
	return male.Format("2006-01-02"), true
}

// minutesIntoServiceDay is how long after the service day opened `at` falls.
func minutesIntoServiceDay(at time.Time) float64 {
	male := at.UTC().Add(store.MaleOffset)
	opened := time.Date(male.Year(), male.Month(), male.Day(), store.ServiceDayStartHour, 0, 0, 0, time.UTC)
	return male.Sub(opened).Minutes()
}
