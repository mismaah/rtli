package rollup

import (
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/mismaah/rtl-improved/server/internal/rtl"
)

// MaxScheduleSkewMin is how far an arrival may sit from a published departure
// and still be read as that departure running late or early.
//
// It is deliberately wider than any delay worth reporting. The number is not
// trying to decide whether a bus was on time — it is deciding which *trip* an
// arrival belongs to, and on these routes trips are 15 to 20 minutes apart, so
// anything nearer than half a headway is unambiguous and anything past it is a
// coin toss between two trips. Matching the wrong trip does not merely mislabel
// the arrival: it reports a bus 25 minutes late as one 5 minutes early, which is
// worse than not matching it at all.
const MaxScheduleSkewMin = 12.0

// minutesPerDay is the modulus for civil-time arithmetic. Timings are published
// as wall clock with no date, so 23:55 and 00:05 are ten minutes apart.
const minutesPerDay = 24 * 60

// Schedule is a route's published departures, indexed by stop.
//
// Built once per route per rollup pass, because ScheduleFor is called for every
// arrival and re-walking the stop list for each would be quadratic in a route's
// busiest hour.
type Schedule struct {
	byStop map[string][]departure
}

// departure is one published time at one stop, as minutes since Malé midnight.
// Trip is RTL's trip number, shared across every stop on the route.
type departure struct {
	Trip int
	Min  float64
}

// NewSchedule indexes a route's published timings.
//
// Returns nil when the route publishes none, which is the normal case for R10,
// R11, R12 and R15 rather than an error: those routes have no timetable to be
// measured against, and their history is the timetable.
func NewSchedule(stops []rtl.Stop) *Schedule {
	byStop := make(map[string][]departure)
	for _, s := range stops {
		var deps []departure
		for _, t := range s.Timings {
			min, ok := parseClockMinutes(t.Timing)
			if !ok {
				continue
			}
			deps = append(deps, departure{Trip: t.Order, Min: min})
		}
		if len(deps) == 0 {
			continue
		}
		sort.Slice(deps, func(i, j int) bool { return deps[i].Min < deps[j].Min })
		byStop[s.Code] = deps
	}
	if len(byStop) == 0 {
		return nil
	}
	return &Schedule{byStop: byStop}
}

// Match finds the published departure an arrival belongs to.
//
// Nearest in civil time, wrapping at midnight, and only within
// MaxScheduleSkewMin. Returns the trip number, the scheduled minute, and how
// late the bus was — signed, positive for late — or ok=false when nothing
// published is close enough to claim it.
func (s *Schedule) Match(stopCode string, atMs int64) (trip int, schedMin, deltaMin float64, ok bool) {
	if s == nil {
		return 0, 0, 0, false
	}
	deps := s.byStop[stopCode]
	if len(deps) == 0 {
		return 0, 0, 0, false
	}

	actual := maleMinutes(atMs)
	best, bestAbs := departure{}, MaxScheduleSkewMin
	found := false
	for _, d := range deps {
		delta := circularDelta(actual, d.Min)
		if abs := absF(delta); abs < bestAbs {
			best, bestAbs, found = d, abs, true
		}
	}
	if !found {
		return 0, 0, 0, false
	}
	return best.Trip, best.Min, circularDelta(actual, best.Min), true
}

// Annotate labels arrivals with the trip they belong to and how late they were.
//
// Arrivals with no match keep zero values and are reported unmatched, so a route
// with no timetable still records every arrival — the observation is the point,
// and the comparison is a bonus where a timetable exists to make it.
func Annotate(arrivals []Arrival, sched *Schedule) []Arrival {
	if sched == nil {
		return arrivals
	}
	out := make([]Arrival, len(arrivals))
	copy(out, arrivals)
	for i := range out {
		trip, schedMin, deltaMin, ok := sched.Match(out[i].StopCode, out[i].AtMs)
		if !ok {
			continue
		}
		t, sm, dm := trip, schedMin, deltaMin
		out[i].TripOrder, out[i].SchedMin, out[i].DeltaMin = &t, &sm, &dm
	}
	return out
}

// parseClockMinutes reads RTL's "HH:MM:SS" into minutes since midnight. Seconds
// are kept as a fraction rather than dropped: they are almost always zero, and
// truncating them would bias every delta the same direction.
func parseClockMinutes(clock string) (float64, bool) {
	parts := strings.Split(strings.TrimSpace(clock), ":")
	if len(parts) < 2 {
		return 0, false
	}
	h, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, false
	}
	m, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, false
	}
	secs := 0
	if len(parts) > 2 {
		if s, err := strconv.Atoi(parts[2]); err == nil {
			secs = s
		}
	}
	if h < 0 || h > 47 || m < 0 || m > 59 || secs < 0 || secs > 59 {
		return 0, false
	}
	// Hours past 24 are how a timetable spells "after midnight, same service
	// day". Folded into the civil clock, because that is what the arrival's own
	// timestamp is measured on.
	total := float64(h*60+m) + float64(secs)/60
	for total >= minutesPerDay {
		total -= minutesPerDay
	}
	return total, true
}

// maleMinutes is an instant as minutes since Malé midnight.
func maleMinutes(atMs int64) float64 {
	male := time.UnixMilli(atMs).UTC().Add(MaleOffset)
	return float64(male.Hour()*60+male.Minute()) + float64(male.Second())/60
}

// circularDelta is actual minus scheduled, taking the shorter way round the
// clock. Positive is late.
func circularDelta(actual, scheduled float64) float64 {
	delta := actual - scheduled
	for delta > minutesPerDay/2 {
		delta -= minutesPerDay
	}
	for delta < -minutesPerDay/2 {
		delta += minutesPerDay
	}
	return delta
}

func absF(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}
