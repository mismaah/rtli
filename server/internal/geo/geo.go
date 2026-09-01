// Package geo is a faithful port of the geometry helpers in src/lib/geo.ts.
//
// "Faithful" is the operative word: the client and this server both infer bus
// headings and simplify route shapes, and if the two implementations disagree a
// bus would visibly jump the moment a client fell back from the server to
// calling RTL directly. The cross-language golden tests exist to hold these
// identical.
package geo

import "math"

const earthRadiusM = 6_371_000

// LatLng is a position. Field order matches the TS interface, not GeoJSON.
type LatLng struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

// HaversineMeters is great-circle distance between two points.
func HaversineMeters(a, b LatLng) float64 {
	const rad = math.Pi / 180
	dLat := (b.Lat - a.Lat) * rad
	dLng := (b.Lng - a.Lng) * rad
	s := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(a.Lat*rad)*math.Cos(b.Lat*rad)*math.Sin(dLng/2)*math.Sin(dLng/2)
	return 2 * earthRadiusM * math.Asin(math.Min(1, math.Sqrt(s)))
}

// BearingDegrees is the initial bearing from a to b, clockwise from north.
//
// RTL's feed reports position only, so a bus's direction is inferred from where
// it was on an earlier reading. Callers must gate this on a meaningful
// distance — over a few metres of GPS jitter the answer is noise.
func BearingDegrees(a, b LatLng) float64 {
	const rad = math.Pi / 180
	dLng := (b.Lng - a.Lng) * rad
	lat1 := a.Lat * rad
	lat2 := b.Lat * rad
	y := math.Sin(dLng) * math.Cos(lat2)
	x := math.Cos(lat1)*math.Sin(lat2) - math.Sin(lat1)*math.Cos(lat2)*math.Cos(dLng)
	return math.Mod(math.Mod(math.Atan2(y, x)/rad, 360)+360, 360)
}

// DefaultSimplifyEpsilon matches the client's default in simplifyLine.
const DefaultSimplifyEpsilon = 1e-5

// Point is a [lng, lat] pair, in GeoJSON order.
type Point = [2]float64

// SimplifyLine is Douglas–Peucker over [lng, lat] pairs.
//
// R2's raw geometry alone is 374 KB. At the zoom levels this app uses the detail
// is invisible, so simplifying keeps both rendering and mobile data cheap — and
// doing it here means every client stops paying for it on the phone.
func SimplifyLine(points []Point, epsilon float64) []Point {
	if len(points) <= 2 {
		return points
	}

	maxDist, index := 0.0, 0
	start, end := points[0], points[len(points)-1]
	for i := 1; i < len(points)-1; i++ {
		if d := perpendicularDistance(points[i], start, end); d > maxDist {
			maxDist, index = d, i
		}
	}

	if maxDist <= epsilon {
		return []Point{start, end}
	}

	left := SimplifyLine(points[:index+1], epsilon)
	right := SimplifyLine(points[index:], epsilon)
	out := make([]Point, 0, len(left)-1+len(right))
	out = append(out, left[:len(left)-1]...)
	return append(out, right...)
}

func perpendicularDistance(p, a, b Point) float64 {
	dx, dy := b[0]-a[0], b[1]-a[1]
	if dx == 0 && dy == 0 {
		return math.Hypot(p[0]-a[0], p[1]-a[1])
	}
	t := ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / (dx*dx + dy*dy)
	clamped := math.Max(0, math.Min(1, t))
	return math.Hypot(p[0]-(a[0]+clamped*dx), p[1]-(a[1]+clamped*dy))
}
