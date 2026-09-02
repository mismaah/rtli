// Package rollup distils raw bus positions into the aggregates that survive
// them: when each bus reached each stop, how long the ride between two stops
// took, and how long a rider waited between buses.
//
// Raw fixes are pruned at store.RawRetention; these outlive them by design, so
// this is the only chance to learn anything from a position before it is gone.
//
// Everything here is pure and time-injected. The job that reads the database and
// writes the results back is in job.go.
package rollup

import (
	"math"

	"github.com/mismaah/rtl-improved/server/internal/geo"
	"github.com/mismaah/rtl-improved/server/internal/rtl"
)

// MaxStopOffsetM is how far a stop may sit from the route line and still be
// considered to be on it.
//
// This is a question about the *shape*, not about stop spacing: adjacent stops
// never compete for a projection, because ResolveStops chooses by the route's
// published order rather than by proximity. So the only job of this number is to
// separate a stop the geometry genuinely covers from one it does not.
//
// Measured against the captured R1 shape, most stops project within 10 m — but
// the loop terminal 11103 sits 36.6 m off, because the shape cuts the corner
// the bus swings around. A threshold under 40 m silently drops it, which is how
// this value was originally set wrong.
const MaxStopOffsetM = 60.0

// samePlaceM collapses candidate projections that are really one spot. The
// nearest-point search yields a local minimum per approach, and a stop sitting
// on a bend can produce two a few metres apart.
const samePlaceM = 100.0

// Line is a route's geometry, flattened and measured, ready for linear
// referencing: every position on the route becomes a single distance along it.
//
// Distances use a local flat projection centred on the route's own first point,
// matching the approach in track.NearestOnPath. Over a Malé route — under 20 km,
// spanning hundredths of a degree — the error is well under a metre.
type Line struct {
	xs, ys []float64
	// cum[i] is the distance from the start of the line to point i.
	cum []float64
	// breaks[i] is true when point i starts a new polyline, so the gap between
	// it and its predecessor is not travel and must not be measured.
	breaks []bool
	scale  float64 // metres per degree of longitude at this latitude
	lat0   float64
}

const (
	metersPerDegLat = 110_574.0
	metersPerDegLng = 111_320.0
)

// NewLine flattens a route's polylines into one measured sequence.
//
// Multiple LineStrings are concatenated rather than treated separately: RTL
// serves one continuous shape per route in practice, and where it does not, a
// bus crossing from one piece to the next is still travelling forwards. The
// break flags keep the jump between pieces out of the distance total.
func NewLine(lines [][]geo.Point) *Line {
	total := 0
	for _, l := range lines {
		total += len(l)
	}
	if total < 2 {
		return nil
	}

	l := &Line{
		xs:     make([]float64, 0, total),
		ys:     make([]float64, 0, total),
		cum:    make([]float64, 0, total),
		breaks: make([]bool, 0, total),
	}
	l.lat0 = lines[0][0][1]
	l.scale = metersPerDegLng * math.Cos(l.lat0*math.Pi/180)

	for _, line := range lines {
		for i, p := range line {
			l.xs = append(l.xs, p[0]*l.scale)
			l.ys = append(l.ys, p[1]*metersPerDegLat)
			l.breaks = append(l.breaks, i == 0)
			n := len(l.cum)
			switch {
			case n == 0 || i == 0:
				// Start of the whole line, or of a disjoint piece: carry the
				// running total across without adding the gap.
				if n == 0 {
					l.cum = append(l.cum, 0)
				} else {
					l.cum = append(l.cum, l.cum[n-1])
				}
			default:
				l.cum = append(l.cum, l.cum[n-1]+math.Hypot(l.xs[n]-l.xs[n-1], l.ys[n]-l.ys[n-1]))
			}
		}
	}
	return l
}

// Length is the total distance along the route, in metres.
func (l *Line) Length() float64 {
	if l == nil || len(l.cum) == 0 {
		return 0
	}
	return l.cum[len(l.cum)-1]
}

// Candidate is one place on the line that a point could correspond to.
type Candidate struct {
	// AlongM is the distance from the start of the line.
	AlongM float64
	// OffsetM is how far the point sits from the line there.
	OffsetM float64
}

// Candidates returns every local minimum of distance from point to the line,
// nearest-first along the route, discarding any beyond maxOffsetM.
//
// Plural, and this is the whole point of the function: a route that passes the
// same place twice — every loop terminal, and every stop with an inbound and an
// outbound twin — gives a stop two equally good projections. Taking the nearest
// silently picks one at random. Which is right is not a geometric question at
// all; it is answered by the stop's position in the route's own order, which is
// what ResolveStops uses.
func (l *Line) Candidates(point geo.LatLng, maxOffsetM float64) []Candidate {
	if l == nil || len(l.cum) < 2 {
		return nil
	}
	px := point.Lng * l.scale
	py := point.Lat * metersPerDegLat

	// Perpendicular distance to each segment, and where along the line its
	// closest point falls.
	dists := make([]float64, 0, len(l.cum)-1)
	alongs := make([]float64, 0, len(l.cum)-1)
	for i := 1; i < len(l.cum); i++ {
		if l.breaks[i] {
			continue // Not a real segment: a jump between disjoint pieces.
		}
		ax, ay := l.xs[i-1], l.ys[i-1]
		dx, dy := l.xs[i]-ax, l.ys[i]-ay
		lengthSq := dx*dx + dy*dy
		var t float64
		if lengthSq != 0 {
			t = math.Max(0, math.Min(1, ((px-ax)*dx+(py-ay)*dy)/lengthSq))
		}
		cx, cy := ax+t*dx, ay+t*dy
		dists = append(dists, math.Hypot(cx-px, cy-py))
		alongs = append(alongs, l.cum[i-1]+t*math.Sqrt(lengthSq))
	}

	var out []Candidate
	for i, d := range dists {
		if d > maxOffsetM {
			continue
		}
		if i > 0 && dists[i-1] < d {
			continue // Still descending towards a nearer approach.
		}
		if i < len(dists)-1 && dists[i+1] < d {
			continue
		}
		// One approach can span several segments at the same distance; keep the
		// first and let the spacing rule absorb the rest.
		if n := len(out); n > 0 && alongs[i]-out[n-1].AlongM <= samePlaceM {
			if d < out[n-1].OffsetM {
				out[n-1] = Candidate{AlongM: alongs[i], OffsetM: d}
			}
			continue
		}
		out = append(out, Candidate{AlongM: alongs[i], OffsetM: d})
	}
	return out
}

// StopRef is a stop pinned to one specific place on the route line.
type StopRef struct {
	Code   string
	Order  int
	AlongM float64
}

// ResolveStops pins each stop to the pass of the route it actually belongs to.
//
// Walking the stops in their published order and always taking the first
// projection *ahead* of the previous stop is what disentangles a loop. Resolved
// independently, R1's stop 18 lands at 145 m — the start of the line, because
// that is where its terminal physically is — and its stop 4 lands on top of stop
// 15, because they are the same shelter served in both directions. Resolved in
// order, 18 lands at 17,937 m of a 17,968 m line and stop 4 at 7,159 m, and the
// whole sequence comes out monotonic, which is the property everything
// downstream relies on.
//
// Stops that cannot be placed are dropped rather than guessed at: a stop with no
// projection within MaxStopOffsetM is not on this geometry, and inventing a
// position for it would put fabricated arrivals into the record.
func ResolveStops(stops []rtl.Stop, line *Line) []StopRef {
	if line == nil {
		return nil
	}

	type located struct {
		stop  rtl.Stop
		cands []Candidate
	}
	var placed []located
	for _, s := range stops {
		lat, lng, ok := s.LatLng()
		if !ok {
			continue
		}
		cands := line.Candidates(geo.LatLng{Lat: lat, Lng: lng}, MaxStopOffsetM)
		if len(cands) == 0 {
			continue
		}
		placed = append(placed, located{stop: s, cands: cands})
	}
	if len(placed) == 0 {
		return nil
	}

	// Seed from the first stop's *best* projection rather than its earliest.
	// With nothing behind it there is no order to appeal to, and the earliest
	// candidate can be a distant graze of the line — on R1 that is a 47 m
	// offset where the true stop is 9 m away.
	first := placed[0].cands[0]
	for _, c := range placed[0].cands[1:] {
		if c.OffsetM < first.OffsetM {
			first = c
		}
	}

	refs := make([]StopRef, 0, len(placed))
	refs = append(refs, StopRef{Code: placed[0].stop.Code, Order: placed[0].stop.Order, AlongM: first.AlongM})
	prev := first.AlongM

	for _, p := range placed[1:] {
		chosen := -1.0
		for _, c := range p.cands {
			if c.AlongM > prev {
				chosen = c.AlongM
				break
			}
		}
		if chosen < 0 {
			// Nothing ahead. The route order and the geometry disagree, which
			// happens when a shape is incomplete. Dropping the stop keeps the
			// sequence monotonic and loses only that stop.
			continue
		}
		refs = append(refs, StopRef{Code: p.stop.Code, Order: p.stop.Order, AlongM: chosen})
		prev = chosen
	}
	return refs
}

// JitterBackM is how far a position may appear to slip backwards along the
// route and still be read as noise rather than as a lap.
//
// A stationary bus wanders a few metres between fixes, and a snapped position
// can land either side of a bend. Anything further back than this is treated as
// having gone forward all the way round instead.
const JitterBackM = 40.0

// Locate returns where along the line a position sits, preferring the least
// forward progress from where the bus already was.
//
// near is the bus's last known distance along the route, or a negative number
// when it has none yet. Forward-preferring rather than nearest, because on a
// loop those differ and only one of them is right: a bus at R1's terminal is
// exactly as close to metre 145 as to metre 17,937, and the answer depends on
// whether it is starting the lap or finishing it. Progress since the last fix
// is the only evidence available, so the candidate requiring the smallest
// forward movement wins, with the end of the line wrapping round to the start.
func (l *Line) Locate(point geo.LatLng, near float64, maxOffsetM float64) (float64, bool) {
	cands := l.Candidates(point, maxOffsetM)
	if len(cands) == 0 {
		return 0, false
	}
	if near < 0 {
		// Nothing to go on: take the closest fit to the line.
		best := cands[0]
		for _, c := range cands[1:] {
			if c.OffsetM < best.OffsetM {
				best = c
			}
		}
		return best.AlongM, true
	}

	best, bestFwd := 0.0, math.Inf(1)
	for _, c := range cands {
		if fwd := l.Forward(near, c.AlongM); fwd < bestFwd {
			best, bestFwd = c.AlongM, fwd
		}
	}
	return best, true
}

// Forward is how far a bus travelled to get from one point on the line to
// another, wrapping at the end. Small backward slips stay negative so a caller
// can tell jitter from a completed lap.
func (l *Line) Forward(from, to float64) float64 {
	delta := to - from
	if delta < -JitterBackM {
		delta += l.Length()
	}
	return delta
}
