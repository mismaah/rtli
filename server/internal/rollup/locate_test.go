package rollup

import (
	"encoding/json"
	"math"
	"os"
	"strconv"
	"testing"

	"github.com/mismaah/rtl-improved/server/internal/geo"
	"github.com/mismaah/rtl-improved/server/internal/rtl"
)

const fixtureDir = "../../../test/fixtures/"

// r1 loads the real captured geometry and stop list for route 133 (R1).
func r1(t *testing.T) (*Line, []rtl.Stop) {
	t.Helper()

	shapeRaw, err := os.ReadFile(fixtureDir + "roadshape-r1.json")
	if err != nil {
		t.Fatalf("read roadshape: %v", err)
	}
	line := NewLine(geo.Polylines(shapeRaw))
	if line == nil {
		t.Fatal("no geometry")
	}

	detailsRaw, err := os.ReadFile(fixtureDir + "routedetails.json")
	if err != nil {
		t.Fatalf("read routedetails: %v", err)
	}
	var details rtl.RouteDetails
	if err := json.Unmarshal(detailsRaw, &details); err != nil {
		t.Fatalf("parse routedetails: %v", err)
	}
	for _, route := range details.RouteResponse {
		if route.Code == "133" {
			return line, route.BusRouteStopList
		}
	}
	t.Fatal("route 133 not in fixture")
	return nil, nil
}

func TestLineLengthMatchesTheCapturedShape(t *testing.T) {
	line, _ := r1(t)
	if got := line.Length(); math.Abs(got-17968) > 50 {
		t.Errorf("R1 length = %.0f m, want ~17968", got)
	}
}

// The property everything downstream depends on. An arrival is derived from a
// bus's distance along the route crossing a stop's, so a stop sequence that
// doubles back would emit arrivals in the wrong order — or emit an entire lap's
// worth at once.
func TestResolveStopsIsMonotonicAlongTheRoute(t *testing.T) {
	line, stops := r1(t)
	refs := ResolveStops(stops, line)

	if len(refs) != len(stops) {
		t.Fatalf("resolved %d of %d stops", len(refs), len(stops))
	}
	for i := 1; i < len(refs); i++ {
		if refs[i].AlongM <= refs[i-1].AlongM {
			t.Errorf("stop %s (order %d) at %.0f m is not ahead of %s at %.0f m",
				refs[i].Code, refs[i].Order, refs[i].AlongM, refs[i-1].Code, refs[i-1].AlongM)
		}
	}
}

// R1 is a loop: its first and last stops are the same shelter, and stops 4 and
// 15 are the inbound and outbound sides of another. Projected independently
// each pair collapses onto one place — 11103 lands at 145 m, the *start* of the
// line, and 106 lands on top of 11106. Only the route order separates them.
func TestResolveStopsSeparatesTheLoopTerminal(t *testing.T) {
	line, stops := r1(t)
	refs := ResolveStops(stops, line)

	along := map[string]float64{}
	for _, r := range refs {
		along[r.Code] = r.AlongM
	}

	// The terminal pair: 103 opens the loop, 11103 closes it.
	if got := along["103"]; got > 500 {
		t.Errorf("stop 103 at %.0f m, want near the start of the line", got)
	}
	if got := along["11103"]; got < line.Length()-500 {
		t.Errorf("stop 11103 at %.0f m, want near the end of the %.0f m line", got, line.Length())
	}

	// The two-sided pair, ~3.8 km apart along the route despite being metres
	// apart on the ground.
	if got := along["11106"] - along["106"]; got < 3000 {
		t.Errorf("106 and 11106 resolved %.0f m apart along the route, want them on different passes", got)
	}
}

// Taking the nearest projection is the mistake this whole file exists to avoid.
// If Candidates ever collapses to one answer, ResolveStops silently loses the
// only evidence it has.
func TestCandidatesFindsBothPassesOfARevisitedPlace(t *testing.T) {
	line, stops := r1(t)

	var target rtl.Stop
	for _, s := range stops {
		if s.Code == "106" {
			target = s
		}
	}
	lat, lng, ok := target.LatLng()
	if !ok {
		t.Fatal("stop 106 has unusable coordinates")
	}

	cands := line.Candidates(geo.LatLng{Lat: lat, Lng: lng}, MaxStopOffsetM)
	if len(cands) < 2 {
		t.Fatalf("got %d candidates for a stop the route passes twice, want at least 2", len(cands))
	}
	for i := 1; i < len(cands); i++ {
		if cands[i].AlongM <= cands[i-1].AlongM {
			t.Errorf("candidates are not ordered along the route: %v", cands)
		}
	}
}

// A stop nowhere near the route is dropped, not pinned to the closest bit of
// line that happens to exist.
func TestResolveStopsDropsAStopOffTheRoute(t *testing.T) {
	line, stops := r1(t)

	stray := rtl.Stop{Code: "STRAY", Order: 99, Latitude: "4.30", Longitude: "73.60"}
	refs := ResolveStops(append(append([]rtl.Stop{}, stops...), stray), line)

	for _, r := range refs {
		if r.Code == "STRAY" {
			t.Errorf("a stop %.0f m off the route was placed at %.0f m", 0.0, r.AlongM)
		}
	}
}

// Locate has to pick a lap, and the bus's last known position is the only thing
// that says which.
func TestLocatePrefersThePassNearestTheBus(t *testing.T) {
	line, stops := r1(t)

	var target rtl.Stop
	for _, s := range stops {
		if s.Code == "106" {
			target = s
		}
	}
	lat, lng, _ := target.LatLng()
	point := geo.LatLng{Lat: lat, Lng: lng}

	cands := line.Candidates(point, MaxStopOffsetM)
	early, late := cands[0].AlongM, cands[len(cands)-1].AlongM

	if got, ok := line.Locate(point, early-200, MaxStopOffsetM); !ok || math.Abs(got-early) > 1 {
		t.Errorf("a bus just short of the first pass located at %.0f m, want %.0f", got, early)
	}
	if got, ok := line.Locate(point, late-200, MaxStopOffsetM); !ok || math.Abs(got-late) > 1 {
		t.Errorf("a bus just short of the second pass located at %.0f m, want %.0f", got, late)
	}
}

// A loop whose geometry runs a little past the point it started from, which is
// what a terminal looks like when the shape covers the bus pulling in beyond
// where it pulled out. The first stop then has two projections — one at the
// start of the line, one at the very end — and the end is the nearer of the two.
//
// This is the shape that had six of fifteen live routes resolving a single stop
// each. Seeding the walk from the nearest projection anchors it past every
// remaining stop, and because the walk is monotonic and cannot wrap, all of them
// are then dropped.
func overshootingLoop() (*Line, []rtl.Stop) {
	const lat0, lng0 = 4.17, 73.5
	lngScale := metersPerDegLng * math.Cos(lat0*math.Pi/180)
	at := func(x, y float64) geo.Point {
		return geo.Point{lng0 + x/lngScale, lat0 + y/metersPerDegLat}
	}
	stop := func(code string, order int, x, y float64) rtl.Stop {
		p := at(x, y)
		return rtl.Stop{
			Code:      code,
			Order:     order,
			Longitude: strconv.FormatFloat(p[0], 'f', -1, 64),
			Latitude:  strconv.FormatFloat(p[1], 'f', -1, 64),
		}
	}

	line := NewLine([][]geo.Point{{
		at(0, 0), at(0, 400), at(400, 400), at(400, 0), at(0, 0),
		at(0, -20), // Past the start, so the end of the line is the nearer fit.
	}})
	stops := []rtl.Stop{
		stop("TERM", 1, 0, -15),
		stop("B", 2, 0, 200),
		stop("C", 3, 200, 400),
		stop("D", 4, 400, 200),
	}
	return line, stops
}

func TestResolveStopsSurvivesATerminalNearestTheEnd(t *testing.T) {
	line, stops := overshootingLoop()

	// The premise: the terminal really is nearer the end of the line than the
	// start. Without this the test would pass for the wrong reason.
	lat, lng, _ := stops[0].LatLng()
	cands := line.Candidates(geo.LatLng{Lat: lat, Lng: lng}, MaxStopOffsetM)
	if len(cands) < 2 {
		t.Fatalf("terminal has %d projections, want both ends of the loop", len(cands))
	}
	nearest := cands[0]
	for _, c := range cands[1:] {
		if c.OffsetM < nearest.OffsetM {
			nearest = c
		}
	}
	if nearest.AlongM < line.Length()/2 {
		t.Fatalf("terminal's nearest projection is at %.0f m of %.0f; the fixture no longer "+
			"reproduces the bug", nearest.AlongM, line.Length())
	}

	refs := ResolveStops(stops, line)
	if len(refs) != len(stops) {
		t.Fatalf("resolved %d of %d stops; seeding from the nearest projection "+
			"anchors the walk past the rest", len(refs), len(stops))
	}
	for i, ref := range refs {
		if ref.Code != stops[i].Code {
			t.Errorf("ref %d is %s, want %s", i, ref.Code, stops[i].Code)
		}
		if i > 0 && ref.AlongM <= refs[i-1].AlongM {
			t.Errorf("%s at %.0f m does not advance on %s at %.0f m",
				ref.Code, ref.AlongM, refs[i-1].Code, refs[i-1].AlongM)
		}
	}
}

// Coverage decides the seed; the tighter fit only breaks ties. On R1 both of the
// terminal's projections place all 18 stops, and the 9 m one is the true stop
// while the 47 m one is a graze of the line on the far carriageway.
func TestResolveStopsStillPrefersTheTighterFitOnATie(t *testing.T) {
	line, stops := r1(t)
	refs := ResolveStops(stops, line)
	if len(refs) != len(stops) {
		t.Fatalf("resolved %d of %d R1 stops", len(refs), len(stops))
	}

	lat, lng, _ := stops[0].LatLng()
	best := math.Inf(1)
	for _, c := range line.Candidates(geo.LatLng{Lat: lat, Lng: lng}, MaxStopOffsetM) {
		best = math.Min(best, c.OffsetM)
	}
	gotOffset := math.Inf(1)
	for _, c := range line.Candidates(geo.LatLng{Lat: lat, Lng: lng}, MaxStopOffsetM) {
		if math.Abs(c.AlongM-refs[0].AlongM) < 1 {
			gotOffset = c.OffsetM
		}
	}
	if math.Abs(gotOffset-best) > 0.5 {
		t.Errorf("seeded R1 at a %.1f m projection when a %.1f m one placed as many stops",
			gotOffset, best)
	}
}
