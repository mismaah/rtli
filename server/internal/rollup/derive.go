package rollup

import (
	"sort"

	"github.com/mismaah/rtl-improved/server/internal/geo"
)

// Bounds on what a pair of consecutive fixes is allowed to imply.
const (
	// MaxFixOffsetM is how far a recorded position may sit from the route line
	// and still be placed on it. Positions are snapped before recording, so in
	// practice this is metres; the allowance is for a bus genuinely off its
	// route, which track.Snap deliberately leaves where it was reported.
	MaxFixOffsetM = 120.0

	// MaxInterpolateGapMs is the longest silence across which crossings are
	// still attributed. Beyond it the bus may have gone anywhere — including
	// right round the loop — and spreading stops evenly across the gap would be
	// inventing arrival times rather than measuring them.
	//
	// This deliberately loses real arrivals, and it is worth knowing which.
	// Measured on R1's first day: 31 legs were rejected here, and 27 of them had
	// moved under 800 m — a bus laying over at the terminal, median travel -12 m
	// across a median 12.7 minutes. Those legs really do contain a crossing of
	// the stop just past the terminal, which is why that stop records 31
	// arrivals where every other stop on the route records 36-38.
	//
	// Admitting them would cost more than it gained. A bus that stood still for
	// twelve minutes and then drove past the stop in the last thirty seconds
	// gets that arrival placed by linear interpolation most of the way back into
	// the layover — minutes early, and early by a *consistent* amount, which is
	// the one kind of error a median over many samples cannot wash out. Fewer
	// arrivals that are correctly timed beat more that are systematically wrong,
	// because the whole point downstream is correcting predictions by minutes.
	MaxInterpolateGapMs = 5 * 60_000

	// MaxSpeedMps mirrors track.MaxSpeedMps: 108 km/h, above which the movement
	// is a feed glitch and the stops it appears to sweep past were never
	// reached.
	MaxSpeedMps = 30.0

	// MaxSegmentSecs bounds a plausible ride between two adjacent stops. Longer
	// than this and the bus was held somewhere, not riding.
	MaxSegmentSecs = 30 * 60

	// MaxHeadwaySecs bounds a plausible wait. Anything longer is a service gap
	// — a lull, a shift change, the overnight break — and averaging it into a
	// headway would describe a wait no rider actually has.
	MaxHeadwaySecs = 90 * 60
)

// Fix is one recorded position, as read back out of the store.
type Fix struct {
	BusCode string
	AtMs    int64
	Lat     float64
	Lng     float64
}

// Arrival is a bus reaching a stop.
type Arrival struct {
	StopCode string
	BusCode  string
	AtMs     int64
}

// Segment is one observed ride between two adjacent stops.
type Segment struct {
	FromStop string
	ToStop   string
	AtMs     int64 // when the ride began
	Secs     float64
}

// Headway is one observed wait between successive buses at a stop.
type Headway struct {
	StopCode string
	AtMs     int64 // when the wait ended, i.e. when the second bus arrived
	Secs     float64
}

// Arrivals derives when each bus reached each stop.
//
// The method is linear referencing rather than proximity: both the bus and the
// stops are reduced to a distance along the route, and an arrival is the moment
// the bus's distance passes the stop's. Interpolating between the two fixes that
// straddle a stop matters because the recorder is sparse by design — a bus
// covers a median 64 m between fixes and stops are ~100 m apart on the tightest
// route, so asking "was a fix ever near this stop" would miss passes outright
// and time the ones it caught to whenever a fix happened to land.
//
// Fixes need not be sorted; they are grouped by bus and ordered here.
func Arrivals(fixes []Fix, refs []StopRef, line *Line) []Arrival {
	if line == nil || len(refs) == 0 || len(fixes) == 0 {
		return nil
	}

	byBus := make(map[string][]Fix)
	for _, f := range fixes {
		byBus[f.BusCode] = append(byBus[f.BusCode], f)
	}

	var out []Arrival
	for busCode, run := range byBus {
		sort.Slice(run, func(i, j int) bool { return run[i].AtMs < run[j].AtMs })

		prevAlong, prevAt := -1.0, int64(0)
		// Index in refs of this bus's last recorded arrival, so a stop cannot
		// be recorded twice running. A bus laying over at a terminal drifts a
		// few metres back and forth across that stop's position, and each
		// forward twitch re-crosses it: on R1's first day that turned 37 real
		// arrivals at the terminal into 53. A bus works through the stop
		// sequence in order, so the same stop twice in a row is always the
		// artefact and never the bus.
		lastIdx := -1
		for _, f := range run {
			along, ok := line.Locate(geo.LatLng{Lat: f.Lat, Lng: f.Lng}, prevAlong, MaxFixOffsetM)
			if !ok {
				// Too far off the route to place. Drop the fix but keep the
				// previous position, so the bus resumes from where it was
				// rather than restarting its lap.
				continue
			}
			if prevAlong >= 0 {
				for _, c := range crossings(refs, line, prevAlong, prevAt, along, f.AtMs) {
					if c.index == lastIdx {
						continue
					}
					lastIdx = c.index
					out = append(out, Arrival{
						StopCode: refs[c.index].Code, BusCode: busCode, AtMs: c.atMs,
					})
				}
			}
			prevAlong, prevAt = along, f.AtMs
		}
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].AtMs != out[j].AtMs {
			return out[i].AtMs < out[j].AtMs
		}
		return out[i].StopCode < out[j].StopCode
	})
	return out
}

// crossing is one stop passed during a leg, identified by its position in the
// route order so the caller can tell a repeat from real progress.
type crossing struct {
	index int
	atMs  int64
}

// crossings lists the stops passed between two consecutive fixes, timed by where
// in the leg each one fell.
func crossings(refs []StopRef, line *Line, fromAlong float64, fromAt int64,
	toAlong float64, toAt int64) []crossing {

	elapsed := toAt - fromAt
	if elapsed <= 0 || elapsed > MaxInterpolateGapMs {
		return nil
	}
	travelled := line.Forward(fromAlong, toAlong)
	if travelled <= 0 {
		return nil // Stationary, or drifted back inside the jitter allowance.
	}
	if travelled > MaxSpeedMps*float64(elapsed)/1000 {
		return nil // Faster than any bus: a feed glitch, not a run of stops.
	}

	var out []crossing
	for i, ref := range refs {
		reach := line.Forward(fromAlong, ref.AlongM)
		if reach <= 0 || reach > travelled {
			continue
		}
		out = append(out, crossing{
			index: i,
			atMs:  fromAt + int64(float64(elapsed)*reach/travelled),
		})
	}
	// In the order the bus met them, which is what lets the caller reject a
	// repeat of the stop it was already at.
	sort.Slice(out, func(i, j int) bool { return out[i].atMs < out[j].atMs })
	return out
}

// Segments derives how long each ride between adjacent stops took.
//
// Only stops adjacent in the route's own order count. A bus whose arrival at one
// stop went unobserved would otherwise contribute the time for two segments as
// though it were one, which is not a slightly worse measurement but a wrong one.
func Segments(arrivals []Arrival, refs []StopRef) []Segment {
	index := make(map[string]int, len(refs))
	for i, r := range refs {
		index[r.Code] = i
	}

	byBus := make(map[string][]Arrival)
	for _, a := range arrivals {
		byBus[a.BusCode] = append(byBus[a.BusCode], a)
	}

	var out []Segment
	for _, run := range byBus {
		sort.Slice(run, func(i, j int) bool { return run[i].AtMs < run[j].AtMs })
		for i := 1; i < len(run); i++ {
			from, to := run[i-1], run[i]
			fi, okFrom := index[from.StopCode]
			ti, okTo := index[to.StopCode]
			if !okFrom || !okTo || ti != fi+1 {
				continue
			}
			secs := float64(to.AtMs-from.AtMs) / 1000
			if secs <= 0 || secs > MaxSegmentSecs {
				continue
			}
			out = append(out, Segment{
				FromStop: from.StopCode, ToStop: to.StopCode, AtMs: from.AtMs, Secs: secs,
			})
		}
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].AtMs != out[j].AtMs {
			return out[i].AtMs < out[j].AtMs
		}
		return out[i].FromStop < out[j].FromStop
	})
	return out
}

// Headways derives how long a rider waited between buses at each stop.
//
// Two arrivals by the *same* bus are a lap, not a headway: a rider who has just
// watched a bus leave is not served by that same bus coming round again in the
// sense a headway means. Only a different vehicle ends the wait.
func Headways(arrivals []Arrival) []Headway {
	byStop := make(map[string][]Arrival)
	for _, a := range arrivals {
		byStop[a.StopCode] = append(byStop[a.StopCode], a)
	}

	var out []Headway
	for stopCode, run := range byStop {
		sort.Slice(run, func(i, j int) bool { return run[i].AtMs < run[j].AtMs })
		for i := 1; i < len(run); i++ {
			if run[i].BusCode == run[i-1].BusCode {
				continue
			}
			secs := float64(run[i].AtMs-run[i-1].AtMs) / 1000
			if secs <= 0 || secs > MaxHeadwaySecs {
				continue
			}
			out = append(out, Headway{StopCode: stopCode, AtMs: run[i].AtMs, Secs: secs})
		}
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].AtMs != out[j].AtMs {
			return out[i].AtMs < out[j].AtMs
		}
		return out[i].StopCode < out[j].StopCode
	})
	return out
}
