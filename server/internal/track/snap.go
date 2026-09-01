// Package track infers what RTL's live feed does not report.
//
// This is a port of src/lib/transit/snapToRoute.ts and busTracks.ts. Both are
// pure and time-injected on the client, which is what makes porting them safe —
// but the two implementations must stay in step, because a client that falls
// back from this server to calling RTL directly switches from one to the other
// mid-session, and a bus must not visibly jump when it does. The golden tests in
// track_golden_test.go exist to hold them identical.
package track

import (
	"math"

	"github.com/mismaah/rtl-improved/server/internal/geo"
)

// How far a reported position may be corrected onto the route.
//
// Within FullSnapM the nearest point on the route is taken as the truth; the
// correction tapers to nothing by NoSnapM; past that the reading stands. A bus
// 200 m off its route is not suffering GPS error — it is on a diversion, running
// out of service, or the shape is incomplete — and moving it onto the line would
// invent a fact rather than clean one up.
const (
	FullSnapM = 40.0
	NoSnapM   = 120.0
)

const (
	metersPerDegLat = 110_574.0
	metersPerDegLng = 111_320.0
)

// SnapResult is a corrected position and how far it was moved.
type SnapResult struct {
	geo.LatLng
	// OffsetM is how far the reported position was from the route.
	OffsetM float64
	// MovedM is how far it was actually shifted, after tapering.
	MovedM float64
}

// NearestOnPath returns the closest point on any line to point, or ok=false when
// there is no geometry.
//
// Distances use a local flat projection centred on the point, accurate to well
// under a metre over the tens of metres that matter here, and avoiding a
// haversine per segment.
func NearestOnPath(point geo.LatLng, lines [][]geo.Point) (SnapResult, bool) {
	scaleLng := metersPerDegLng * math.Cos(point.Lat*math.Pi/180)
	toX := func(lng float64) float64 { return (lng - point.Lng) * scaleLng }
	toY := func(lat float64) float64 { return (lat - point.Lat) * metersPerDegLat }

	best := math.Inf(1)
	bestLat, bestLng := point.Lat, point.Lng

	for _, line := range lines {
		if len(line) < 2 {
			continue
		}
		ax, ay := toX(line[0][0]), toY(line[0][1])
		for i := 1; i < len(line); i++ {
			bx, by := toX(line[i][0]), toY(line[i][1])
			dx, dy := bx-ax, by-ay
			lengthSq := dx*dx + dy*dy
			// The projection's origin is the bus itself, so the distance to a
			// point on the segment is just that point's own magnitude.
			var t float64
			if lengthSq != 0 {
				t = math.Max(0, math.Min(1, -(ax*dx+ay*dy)/lengthSq))
			}
			px, py := ax+t*dx, ay+t*dy
			if distSq := px*px + py*py; distSq < best {
				best = distSq
				bestLng = point.Lng + px/scaleLng
				bestLat = point.Lat + py/metersPerDegLat
			}
			ax, ay = bx, by
		}
	}

	if math.IsInf(best, 1) {
		return SnapResult{}, false
	}
	offset := math.Sqrt(best)
	return SnapResult{LatLng: geo.LatLng{Lat: bestLat, Lng: bestLng}, OffsetM: offset, MovedM: offset}, true
}

// Snap corrects a reported position towards the route as far as it deserves.
//
// A point with no geometry to snap to is returned unchanged, so a route whose
// shape has not loaded simply behaves as it did before.
func Snap(point geo.LatLng, lines [][]geo.Point, fullSnapM, noSnapM float64) SnapResult {
	nearest, ok := NearestOnPath(point, lines)
	if !ok {
		return SnapResult{LatLng: point}
	}

	offset := nearest.OffsetM
	var pull float64
	switch {
	case offset <= fullSnapM:
		pull = 1
	case offset >= noSnapM:
		pull = 0
	default:
		pull = (noSnapM - offset) / (noSnapM - fullSnapM)
	}

	if pull <= 0 {
		return SnapResult{LatLng: point, OffsetM: offset}
	}
	if pull >= 1 {
		return nearest
	}
	return SnapResult{
		LatLng: geo.LatLng{
			Lat: point.Lat + (nearest.Lat-point.Lat)*pull,
			Lng: point.Lng + (nearest.Lng-point.Lng)*pull,
		},
		OffsetM: offset,
		MovedM:  offset * pull,
	}
}
