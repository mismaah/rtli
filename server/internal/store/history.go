package store

import (
	"context"
	"fmt"
	"sort"
)

// MinSamples is the fewest observations a bucket needs before it is served.
//
// Below this a median is not a measurement, it is one bus's afternoon. The
// consumer's own assumption is a better answer than a confident wrong number,
// and it already has one — the point of publishing sample counts alongside every
// figure is that a thin bucket can be declined rather than silently trusted.
const MinSamples = 5

// MinQuantileSamples is the floor for a tail figure. A median of five is a
// rough middle; the 15th percentile of five is one bus.
const MinQuantileSamples = 20

// EarlyQuantile is the share of buses a rider standing at the stop by the
// served buffer would still miss by turning up then. At 0.15 the buffer on R1
// and R2 comes out around six and a half minutes, which is what it takes: a
// quarter of their buses reach a stop five minutes or more ahead of the
// timetable.
const EarlyQuantile = 0.15

// Bounds on a whole ride, from one bus's arrival at one stop to its arrival at
// another in the same pass.
const (
	// MinRideSecs mirrors rollup.MinSegmentSecs: two stops are ~100 m apart at
	// the tightest and no bus covers that in under ten seconds.
	MinRideSecs = 10

	// MaxRideSecs bounds a ride at comfortably longer than the longest loop in
	// the network (R7, ~67 minutes) and far short of a vehicle's shift, so a run
	// that somehow ran together across a silence cannot be mistaken for a ride.
	MaxRideSecs = 120 * 60

	// MaxRideGapSecs is the longest silence a single run may contain.
	//
	// Generous on purpose: an unobserved arrival in the middle of a pass leaves
	// a gap of two hops rather than one, and the ride across it is still a real
	// measurement. What this rejects is a bus that went quiet long enough to
	// have done something else entirely. A terminal layover does not need to be
	// caught here — it falls at the repeat that already ends a run.
	MaxRideGapSecs = 20 * 60
)

// HistorySummary is what the recorded history says about how the network
// actually runs, reduced to what a planner can use.
//
// Everything here is a median rather than a mean. Bus waits are not symmetric:
// on R6 the mean headway reads 14.7 minutes while individual waits run from 2.1
// to 75, because buses bunch and then leave a gap. A mean sits between the two
// modes and describes neither, and it is the long waits that decide whether an
// itinerary is worth suggesting.
type HistorySummary struct {
	// GeneratedAtMs is when this was computed, not when the data ends.
	GeneratedAtMs int64 `json:"generatedAtMs"`
	// FromMs is the oldest observation included.
	FromMs int64 `json:"fromMs"`
	// Routes is keyed by route code ("133"), not route number ("R1").
	Routes map[string]*RouteHistory `json:"routes"`
	// Days is how many whole service days the recorder observed in the
	// window, which is what the activity shares below are fractions of. A
	// route missing from Routes on a server with plenty of Days is a route that
	// was not seen running at all.
	Days int `json:"days"`
	// DayTypeDays splits Days by day type: "week", "fri", "sat".
	DayTypeDays map[string]int `json:"dayTypeDays,omitempty"`
}

// DayTypeHistory is a route's figures for one day type — Sun–Thu, Friday or
// Saturday — on the same terms as the pooled ones on RouteHistory.
type DayTypeHistory struct {
	ActiveDays     int                `json:"activeDays"`
	ActiveByHour   map[string]float64 `json:"activeByHour,omitempty"`
	HeadwayByHour  map[string]float64 `json:"headwayByHour,omitempty"`
	WaitByHour     map[string]float64 `json:"waitByHour,omitempty"`
	LatenessByHour map[string]float64 `json:"latenessByHour,omitempty"`
	EarlyByHour    map[string]float64 `json:"earlyByHour,omitempty"`
}

// RouteHistory is one route's measured behaviour.
type RouteHistory struct {
	// HeadwayMin is the median wait across the route's stops, or nil when too
	// little was observed to say. Consumers should fall back to their own
	// assumption rather than treating a missing value as zero.
	HeadwayMin *float64 `json:"headwayMin,omitempty"`
	// HeadwaySamples is how many waits that median came from.
	HeadwaySamples int `json:"headwaySamples"`
	// HeadwayIsLap marks a route where the wait had to be measured as the time
	// for one bus to come round again, because the route is worked by a single
	// vehicle and no two consecutive arrivals are different buses. It is still
	// the wait a rider has; it is just not a headway in the usual sense.
	HeadwayIsLap bool `json:"headwayIsLap,omitempty"`

	// HeadwayByHour is the median wait in each hour of the Malé day, for the
	// hours with enough observations. Keys are "0".."23".
	HeadwayByHour map[string]float64 `json:"headwayByHour,omitempty"`

	// LatenessByHour is the median signed minutes by which this route ran late
	// against its own published timetable, per hour. Positive is late. Absent
	// for the routes that publish no timetable, which is the whole point of the
	// headway figures above.
	LatenessByHour map[string]float64 `json:"latenessByHour,omitempty"`
	// LatenessSamples is how many matched arrivals fed LatenessByHour.
	LatenessSamples int `json:"latenessSamples"`

	// WaitMin is the average wait for a rider who turns up at random, in
	// minutes: sum(h²) / 2·sum(h) over the observed gaps h. Not half the
	// median gap. Riders are more likely to arrive during a long gap than a
	// short one, so uneven service makes the real wait longer than an even
	// headway would suggest — on R10 7.5 minutes against 5.8 from the average
	// gap, and more against the median.
	WaitMin    *float64           `json:"waitMin,omitempty"`
	WaitByHour map[string]float64 `json:"waitByHour,omitempty"`

	// EarlyMin is how many minutes ahead of its timetable this route runs at
	// the EarlyQuantile — the margin a rider needs to be at the stop by to
	// catch all but that share of buses. Zero when it does not run early.
	// Absent for routes with no timetable or too few matched arrivals.
	EarlyMin    *float64           `json:"earlyMin,omitempty"`
	EarlyByHour map[string]float64 `json:"earlyByHour,omitempty"`

	// ActiveDays is how many of the summary's Days this route was seen
	// arriving at a stop at all.
	ActiveDays int `json:"activeDays"`
	// ActiveByHour is the share of Days on which the route was seen in each
	// hour of the Malé day, 0–1. An hour that is absent was never seen. This is
	// what says R12 has stopped by 19:00 and R11 is not running at all — which
	// neither its missing timetable nor a headway can say.
	ActiveByHour map[string]float64 `json:"activeByHour,omitempty"`

	// DayTypes holds the same hourly figures per day type, keyed "week", "fri"
	// and "sat", for the types observed.
	DayTypes map[string]*DayTypeHistory `json:"dayTypes,omitempty"`

	// SegmentSecs is the median ride between adjacent stops, keyed
	// "fromStop>toStop". This is what replaces assuming an average speed: a
	// stretch through Malé and a stretch of the Hulhumalé link road are not the
	// same road, and a single km/h figure for the network cannot say so.
	SegmentSecs map[string]float64 `json:"segmentSecs,omitempty"`

	// RideSecs is the median time to ride from one stop to another, keyed
	// "fromStop>toStop" for every ordered pair a bus was observed covering in
	// one pass — not just adjacent ones.
	//
	// This is the figure a journey planner wants, and it is deliberately not the
	// sum of the SegmentSecs along the way. Summing per-leg medians understates
	// a typical end-to-end ride, because leg times are right-skewed: a hop is
	// usually quick and occasionally held, and the median of each leg discards
	// the holds that any real ride accumulates some of. Measured whole, from one
	// bus's own arrival at each end, the skew is carried rather than dropped.
	//
	// Every ordered pair means ~1,960 entries across the network, which is ~35 KB
	// of the summary's ~42 KB and by far the largest thing in it. That is worth
	// it for something fetched once a session and cached, but it is why these are
	// not also split by hour: the same table per hour would be a payload no
	// client should be asked to carry.
	RideSecs map[string]float64 `json:"rideSecs,omitempty"`

	// SegmentSecsByHour is the same median resolved by hour of the Malé day,
	// keyed "fromStop>toStop" then "0".."23", for the buckets with enough
	// observations to mean anything.
	//
	// The same road is not the same ride at 08:00 and at 23:00, and a consumer
	// predicting an arrival minutes out is exactly who that difference is
	// material to. Sparse by construction: an hour a route barely runs in
	// simply has no entry, and SegmentSecs above is what the consumer falls
	// back to. That fallback is why this can be added without weakening
	// anything — a thin bucket is absent rather than noisy.
	SegmentSecsByHour map[string]map[string]float64 `json:"segmentSecsByHour,omitempty"`
}

// History summarises every observation at or after fromMs.
//
// One pass over the aggregates, medians computed in Go: SQLite has no median,
// and the alternative — a window function per bucket — is more SQL than the few
// tens of thousands of rows involved can justify.
func (db *DB) History(ctx context.Context, fromMs, nowMs int64) (*HistorySummary, error) {
	out := &HistorySummary{
		GeneratedAtMs: nowMs,
		FromMs:        fromMs,
		Routes:        map[string]*RouteHistory{},
	}

	route := func(code string) *RouteHistory {
		if r, ok := out.Routes[code]; ok {
			return r
		}
		r := &RouteHistory{}
		out.Routes[code] = r
		return r
	}

	dayType := func(code, kind string) *DayTypeHistory {
		r := route(code)
		if r.DayTypes == nil {
			r.DayTypes = map[string]*DayTypeHistory{}
		}
		d, ok := r.DayTypes[kind]
		if !ok {
			d = &DayTypeHistory{}
			r.DayTypes[kind] = d
		}
		return d
	}

	// Headways. Different-bus waits and same-bus laps are collected separately
	// and never mixed: a route with both is a route where the laps are lapping
	// past other buses, and only the real waits describe a rider's experience.
	waits := map[string]*samples{}
	laps := map[string]*samples{}

	rows, err := db.sql.QueryContext(ctx, `
		SELECT route_code, at_ms, hour, secs, same_bus
		FROM headway_obs WHERE at_ms >= ?`, fromMs)
	if err != nil {
		return nil, fmt.Errorf("history headways: %w", err)
	}
	for rows.Next() {
		var code string
		var atMs int64
		var hour int
		var secs float64
		var sameBus bool
		if err := rows.Scan(&code, &atMs, &hour, &secs, &sameBus); err != nil {
			rows.Close()
			return nil, fmt.Errorf("history headways: %w", err)
		}
		into := waits
		if sameBus {
			into = laps
		}
		if into[code] == nil {
			into[code] = newSamples()
		}
		into[code].add(DayType(ServiceDateAt(atMs)), hour, secs)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("history headways: %w", err)
	}

	for code := range union(waits, laps) {
		set, isLap := waits[code], false
		if set.size() < MinSamples && laps[code].size() >= MinSamples {
			set, isLap = laps[code], true
		}
		if set.size() < MinSamples {
			continue
		}
		r := route(code)
		minutes := median(set.all) / 60
		r.HeadwayMin = &minutes
		r.HeadwaySamples = len(set.all)
		r.HeadwayIsLap = isLap
		r.HeadwayByHour = hourlyMedians(set.byHour, 1.0/60)
		wait := round1(expectedWait(set.all) / 60)
		r.WaitMin = &wait
		r.WaitByHour = hourlyReduce(set.byHour, MinSamples, func(v []float64) float64 { return expectedWait(v) / 60 })
		for kind, byHour := range set.byType {
			headway := hourlyMedians(byHour, 1.0/60)
			waitByHour := hourlyReduce(byHour, MinSamples, func(v []float64) float64 { return expectedWait(v) / 60 })
			if headway == nil && waitByHour == nil {
				continue
			}
			d := dayType(code, kind)
			d.HeadwayByHour, d.WaitByHour = headway, waitByHour
		}
	}

	// Lateness against the published timetable: the median, which says how
	// late a bus typically is, and the early tail, which says how soon a rider
	// has to be there not to miss it.
	lateness := map[string]*samples{}
	rows, err = db.sql.QueryContext(ctx, `
		SELECT route_code, at_ms, hour, delta_min
		FROM stop_arrival WHERE at_ms >= ? AND delta_min IS NOT NULL`, fromMs)
	if err != nil {
		return nil, fmt.Errorf("history lateness: %w", err)
	}
	for rows.Next() {
		var code string
		var atMs int64
		var hour int
		var delta float64
		if err := rows.Scan(&code, &atMs, &hour, &delta); err != nil {
			rows.Close()
			return nil, fmt.Errorf("history lateness: %w", err)
		}
		if lateness[code] == nil {
			lateness[code] = newSamples()
		}
		lateness[code].add(DayType(ServiceDateAt(atMs)), hour, delta)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("history lateness: %w", err)
	}
	for code, set := range lateness {
		if set.size() < MinSamples {
			continue
		}
		r := route(code)
		r.LatenessByHour = hourlyMedians(set.byHour, 1)
		r.LatenessSamples = set.size()
		if set.size() >= MinQuantileSamples {
			early := earliness(set.all)
			r.EarlyMin = &early
		}
		r.EarlyByHour = hourlyReduce(set.byHour, MinQuantileSamples, earliness)
		for kind, byHour := range set.byType {
			late := hourlyMedians(byHour, 1)
			early := hourlyReduce(byHour, MinQuantileSamples, earliness)
			if late == nil && early == nil {
				continue
			}
			d := dayType(code, kind)
			d.LatenessByHour, d.EarlyByHour = late, early
		}
	}

	// When each route runs at all.
	if err := db.activity(ctx, fromMs, nowMs, out, route, dayType); err != nil {
		return nil, err
	}

	// Ride times between adjacent stops, pooled across the day and again per
	// hour of it. The pooled figure is the one that is nearly always there; the
	// hourly one resolves the congestion the pooled figure averages away, on
	// the routes and hours busy enough to have measured it. Both are served,
	// because a consumer that finds no bucket for the hour it is asking about
	// still needs an answer.
	segments := map[string]map[string][]float64{}
	segmentsByHour := map[string]map[string]map[int][]float64{}
	rows, err = db.sql.QueryContext(ctx, `
		SELECT route_code, from_stop, to_stop, hour, secs
		FROM segment_obs WHERE at_ms >= ?`, fromMs)
	if err != nil {
		return nil, fmt.Errorf("history segments: %w", err)
	}
	for rows.Next() {
		var code, from, to string
		var hour int
		var secs float64
		if err := rows.Scan(&code, &from, &to, &hour, &secs); err != nil {
			rows.Close()
			return nil, fmt.Errorf("history segments: %w", err)
		}
		if segments[code] == nil {
			segments[code] = map[string][]float64{}
			segmentsByHour[code] = map[string]map[int][]float64{}
		}
		key := from + ">" + to
		segments[code][key] = append(segments[code][key], secs)
		if segmentsByHour[code][key] == nil {
			segmentsByHour[code][key] = map[int][]float64{}
		}
		segmentsByHour[code][key][hour] = append(segmentsByHour[code][key][hour], secs)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("history segments: %w", err)
	}
	for code, pairs := range segments {
		out := map[string]float64{}
		hourly := map[string]map[string]float64{}
		for key, values := range pairs {
			if len(values) < MinSamples {
				continue
			}
			out[key] = round1(median(values))
			// Only for a pair whose pooled median is already trusted: an hour
			// resolved off a stop pair the route as a whole barely observed is
			// precision without accuracy.
			if byHour := hourlyMedians(segmentsByHour[code][key], 1); byHour != nil {
				hourly[key] = byHour
			}
		}
		if len(out) > 0 {
			route(code).SegmentSecs = out
			if len(hourly) > 0 {
				route(code).SegmentSecsByHour = hourly
			}
		}
	}

	// Whole rides, from the arrivals themselves rather than from the per-leg
	// aggregates. Nothing extra is stored for this: stop_arrival already records
	// which bus reached which stop when, and a run of one bus's arrivals with no
	// stop repeated is one pass along the route.
	rides, err := db.rideMedians(ctx, fromMs)
	if err != nil {
		return nil, err
	}
	for code, medians := range rides {
		route(code).RideSecs = medians
	}

	return out, nil
}

// rideArrival is one bus reaching one stop, which is all a run is made of.
type rideArrival struct {
	stopCode string
	atMs     int64
}

// rideMedians measures every ride a bus was seen to complete in one pass.
func (db *DB) rideMedians(ctx context.Context, fromMs int64) (map[string]map[string]float64, error) {
	rows, err := db.sql.QueryContext(ctx, `
		SELECT route_code, bus_code, stop_code, at_ms
		FROM stop_arrival WHERE at_ms >= ?
		ORDER BY route_code, bus_code, at_ms`, fromMs)
	if err != nil {
		return nil, fmt.Errorf("history rides: %w", err)
	}
	defer rows.Close()

	// Grouped by route and then by bus, which is the order the query returns, so
	// each bus's arrivals arrive already sorted into the runs they belong to.
	byRoute := map[string]map[string][]rideArrival{}
	for rows.Next() {
		var code, bus, stop string
		var atMs int64
		if err := rows.Scan(&code, &bus, &stop, &atMs); err != nil {
			return nil, fmt.Errorf("history rides: %w", err)
		}
		if byRoute[code] == nil {
			byRoute[code] = map[string][]rideArrival{}
		}
		byRoute[code][bus] = append(byRoute[code][bus], rideArrival{stopCode: stop, atMs: atMs})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("history rides: %w", err)
	}

	out := map[string]map[string]float64{}
	for code, byBus := range byRoute {
		observed := map[string][]float64{}
		for _, arrivals := range byBus {
			collectRides(arrivals, observed)
		}

		medians := map[string]float64{}
		for key, values := range observed {
			if len(values) < MinSamples {
				continue
			}
			medians[key] = round1(median(values))
		}
		if len(medians) > 0 {
			out[code] = medians
		}
	}
	return out, nil
}

// collectRides splits one bus's arrivals into runs and records every ride each
// run covers, accumulating into `into`.
//
// A run ends where the bus starts round again — the first stop it calls at
// twice — or where it fell silent for longer than a run can plausibly contain.
// Splitting on the repeat is what keeps a lap out of the measurements without
// needing to know the route's stop order at all: a bus that reaches the same
// stop twice has been round, whatever order the stops are published in.
//
// A terminal layover falls between runs rather than inside one, because a route
// lays over at the end of its loop and that is exactly where the repeat cuts. So
// these are rides a rider could actually take, not a vehicle's whole shift.
func collectRides(arrivals []rideArrival, into map[string][]float64) {
	run := make([]rideArrival, 0, 24)

	flush := func() {
		for i := 0; i < len(run); i++ {
			for j := i + 1; j < len(run); j++ {
				secs := float64(run[j].atMs-run[i].atMs) / 1000
				if secs < MinRideSecs || secs > MaxRideSecs {
					continue
				}
				key := run[i].stopCode + ">" + run[j].stopCode
				into[key] = append(into[key], secs)
			}
		}
		run = run[:0]
	}

	seen := map[string]bool{}
	for _, arrival := range arrivals {
		gap := int64(0)
		if len(run) > 0 {
			gap = arrival.atMs - run[len(run)-1].atMs
		}
		if seen[arrival.stopCode] || gap > MaxRideGapSecs*1000 {
			flush()
			seen = map[string]bool{}
		}
		seen[arrival.stopCode] = true
		run = append(run, arrival)
	}
	flush()
}

// samples collects one route's observations pooled, per hour, and per day
// type and hour.
type samples struct {
	all    []float64
	byHour map[int][]float64
	byType map[string]map[int][]float64
}

func newSamples() *samples {
	return &samples{byHour: map[int][]float64{}, byType: map[string]map[int][]float64{}}
}

func (s *samples) add(dayType string, hour int, value float64) {
	s.all = append(s.all, value)
	s.byHour[hour] = append(s.byHour[hour], value)
	if s.byType[dayType] == nil {
		s.byType[dayType] = map[int][]float64{}
	}
	s.byType[dayType][hour] = append(s.byType[dayType][hour], value)
}

// size tolerates a nil set, which is what a route with only laps has for
// waits and vice versa.
func (s *samples) size() int {
	if s == nil {
		return 0
	}
	return len(s.all)
}

// activity fills in how many days each route ran and in which hours.
//
// Read from the arrivals at hour resolution — one row per route per clock hour
// it was seen in, a few thousand rows for four weeks — so this is cheap beside
// the passes above. Only whole service days count: the first day of the window
// is cut off partway, and today has not finished, and either would read as a
// route that stopped early.
func (db *DB) activity(ctx context.Context, fromMs, nowMs int64, out *HistorySummary,
	route func(string) *RouteHistory, dayType func(string, string) *DayTypeHistory) error {

	rows, err := db.sql.QueryContext(ctx, `
		SELECT DISTINCT route_code, at_ms / 3600000
		FROM stop_arrival WHERE at_ms >= ?`, fromMs)
	if err != nil {
		return fmt.Errorf("history activity: %w", err)
	}
	type slot struct {
		date string
		hour int
	}
	seen := map[string]map[slot]bool{}
	dates := map[string]bool{}
	firstDate, today := ServiceDateAt(fromMs), ServiceDateAt(nowMs)
	firstIsWhole := ServiceDateAt(fromMs-1) != firstDate
	for rows.Next() {
		var code string
		var hourIndex int64
		if err := rows.Scan(&code, &hourIndex); err != nil {
			rows.Close()
			return fmt.Errorf("history activity: %w", err)
		}
		mid := hourIndex*3600000 + 1800000
		date := ServiceDateAt(mid)
		if date == today || (date == firstDate && !firstIsWhole) {
			continue
		}
		_, hour := maleBucket(mid)
		if seen[code] == nil {
			seen[code] = map[slot]bool{}
		}
		seen[code][slot{date, hour}] = true
		dates[date] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("history activity: %w", err)
	}

	out.Days = len(dates)
	typeDays := map[string]int{}
	for date := range dates {
		typeDays[DayType(date)]++
	}
	if len(typeDays) > 0 {
		out.DayTypeDays = typeDays
	}

	for code, slots := range seen {
		activeDates := map[string]bool{}
		byHour := map[int]int{}
		byTypeHour := map[string]map[int]int{}
		typeDates := map[string]map[string]bool{}
		for s := range slots {
			kind := DayType(s.date)
			activeDates[s.date] = true
			byHour[s.hour]++
			if byTypeHour[kind] == nil {
				byTypeHour[kind] = map[int]int{}
				typeDates[kind] = map[string]bool{}
			}
			byTypeHour[kind][s.hour]++
			typeDates[kind][s.date] = true
		}
		r := route(code)
		r.ActiveDays = len(activeDates)
		r.ActiveByHour = shares(byHour, out.Days)
		for kind, hours := range byTypeHour {
			d := dayType(code, kind)
			d.ActiveDays = len(typeDates[kind])
			d.ActiveByHour = shares(hours, typeDays[kind])
		}
	}
	return nil
}

// shares turns per-hour day counts into fractions of total, to two places.
func shares(counts map[int]int, total int) map[string]float64 {
	if total == 0 || len(counts) == 0 {
		return nil
	}
	out := make(map[string]float64, len(counts))
	for hour, n := range counts {
		out[fmt.Sprintf("%d", hour)] = float64(int64(float64(n)/float64(total)*100+0.5)) / 100
	}
	return out
}

// expectedWait is the mean wait for a passenger arriving at random across a
// sequence of gaps: sum(h²) / 2·sum(h). Units are those of the gaps.
func expectedWait(gaps []float64) float64 {
	var sum, squares float64
	for _, h := range gaps {
		sum += h
		squares += h * h
	}
	if sum <= 0 {
		return 0
	}
	return squares / (2 * sum)
}

// earliness is how far ahead of the timetable the EarlyQuantile of arrivals
// ran, in minutes, as a non-negative number.
func earliness(deltas []float64) float64 {
	q := quantile(deltas, EarlyQuantile)
	if q >= 0 {
		return 0
	}
	return round1(-q)
}

// quantile sorts in place and interpolates linearly between ranks.
func quantile(values []float64, q float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sort.Float64s(values)
	pos := q * float64(len(values)-1)
	lower := int(pos)
	if lower >= len(values)-1 {
		return values[len(values)-1]
	}
	frac := pos - float64(lower)
	return values[lower] + frac*(values[lower+1]-values[lower])
}

// hourlyReduce is hourlyMedians with any reduction and floor.
func hourlyReduce(byHour map[int][]float64, floor int, reduce func([]float64) float64) map[string]float64 {
	out := map[string]float64{}
	for hour, values := range byHour {
		if len(values) < floor {
			continue
		}
		out[fmt.Sprintf("%d", hour)] = round1(reduce(values))
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// hourlyMedians reduces per-hour observations to medians, dropping the hours
// with too few to mean anything and scaling the result (seconds to minutes, or
// not at all).
func hourlyMedians(byHour map[int][]float64, scale float64) map[string]float64 {
	if len(byHour) == 0 {
		return nil
	}
	out := map[string]float64{}
	for hour, values := range byHour {
		if len(values) < MinSamples {
			continue
		}
		out[fmt.Sprintf("%d", hour)] = round1(median(values) * scale)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// median sorts in place and returns the middle value, averaging the two middle
// values of an even-sized sample.
func median(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sort.Float64s(values)
	mid := len(values) / 2
	if len(values)%2 == 1 {
		return values[mid]
	}
	return (values[mid-1] + values[mid]) / 2
}

// round1 keeps one decimal place. These are minutes and seconds derived from
// interpolated timestamps; more precision than this is noise, and it is noise
// that would be re-serialised to every client on every fetch.
func round1(v float64) float64 {
	return float64(int64(v*10+copySign(0.5, v))) / 10
}

func copySign(magnitude, sign float64) float64 {
	if sign < 0 {
		return -magnitude
	}
	return magnitude
}

func union[V any](a, b map[string]V) map[string]struct{} {
	out := make(map[string]struct{}, len(a)+len(b))
	for k := range a {
		out[k] = struct{}{}
	}
	for k := range b {
		out[k] = struct{}{}
	}
	return out
}
