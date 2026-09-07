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

	// SegmentSecs is the median ride between adjacent stops, keyed
	// "fromStop>toStop". This is what replaces assuming an average speed: a
	// stretch through Malé and a stretch of the Hulhumalé link road are not the
	// same road, and a single km/h figure for the network cannot say so.
	SegmentSecs map[string]float64 `json:"segmentSecs,omitempty"`
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

	// Headways. Different-bus waits and same-bus laps are collected separately
	// and never mixed: a route with both is a route where the laps are lapping
	// past other buses, and only the real waits describe a rider's experience.
	waits := map[string][]float64{}
	laps := map[string][]float64{}
	waitsByHour := map[string]map[int][]float64{}
	lapsByHour := map[string]map[int][]float64{}

	rows, err := db.sql.QueryContext(ctx, `
		SELECT route_code, hour, secs, same_bus
		FROM headway_obs WHERE at_ms >= ?`, fromMs)
	if err != nil {
		return nil, fmt.Errorf("history headways: %w", err)
	}
	for rows.Next() {
		var code string
		var hour int
		var secs float64
		var sameBus bool
		if err := rows.Scan(&code, &hour, &secs, &sameBus); err != nil {
			rows.Close()
			return nil, fmt.Errorf("history headways: %w", err)
		}
		into, byHour := waits, waitsByHour
		if sameBus {
			into, byHour = laps, lapsByHour
		}
		into[code] = append(into[code], secs)
		if byHour[code] == nil {
			byHour[code] = map[int][]float64{}
		}
		byHour[code][hour] = append(byHour[code][hour], secs)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("history headways: %w", err)
	}

	for code := range union(waits, laps) {
		r := route(code)
		samples, byHour, isLap := waits[code], waitsByHour[code], false
		if len(samples) < MinSamples && len(laps[code]) >= MinSamples {
			samples, byHour, isLap = laps[code], lapsByHour[code], true
		}
		if len(samples) < MinSamples {
			continue
		}
		minutes := median(samples) / 60
		r.HeadwayMin = &minutes
		r.HeadwaySamples = len(samples)
		r.HeadwayIsLap = isLap
		r.HeadwayByHour = hourlyMedians(byHour, 1.0/60)
	}

	// Lateness against the published timetable.
	lateness := map[string]map[int][]float64{}
	counts := map[string]int{}
	rows, err = db.sql.QueryContext(ctx, `
		SELECT route_code, hour, delta_min
		FROM stop_arrival WHERE at_ms >= ? AND delta_min IS NOT NULL`, fromMs)
	if err != nil {
		return nil, fmt.Errorf("history lateness: %w", err)
	}
	for rows.Next() {
		var code string
		var hour int
		var delta float64
		if err := rows.Scan(&code, &hour, &delta); err != nil {
			rows.Close()
			return nil, fmt.Errorf("history lateness: %w", err)
		}
		if lateness[code] == nil {
			lateness[code] = map[int][]float64{}
		}
		lateness[code][hour] = append(lateness[code][hour], delta)
		counts[code]++
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("history lateness: %w", err)
	}
	for code, byHour := range lateness {
		if counts[code] < MinSamples {
			continue
		}
		r := route(code)
		r.LatenessByHour = hourlyMedians(byHour, 1)
		r.LatenessSamples = counts[code]
	}

	// Ride times between adjacent stops. Not split by hour: a stop pair in one
	// hour on one route is a handful of rides at best, and MinSamples would
	// reject nearly all of it. Congestion is carried by LatenessByHour instead,
	// which pools every stop on the route and so has the samples to resolve it.
	segments := map[string]map[string][]float64{}
	rows, err = db.sql.QueryContext(ctx, `
		SELECT route_code, from_stop, to_stop, secs
		FROM segment_obs WHERE at_ms >= ?`, fromMs)
	if err != nil {
		return nil, fmt.Errorf("history segments: %w", err)
	}
	for rows.Next() {
		var code, from, to string
		var secs float64
		if err := rows.Scan(&code, &from, &to, &secs); err != nil {
			rows.Close()
			return nil, fmt.Errorf("history segments: %w", err)
		}
		if segments[code] == nil {
			segments[code] = map[string][]float64{}
		}
		key := from + ">" + to
		segments[code][key] = append(segments[code][key], secs)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("history segments: %w", err)
	}
	for code, pairs := range segments {
		out := map[string]float64{}
		for key, values := range pairs {
			if len(values) < MinSamples {
				continue
			}
			out[key] = round1(median(values))
		}
		if len(out) > 0 {
			route(code).SegmentSecs = out
		}
	}

	return out, nil
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
