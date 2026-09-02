package rollup

import (
	"math"
	"testing"

	"github.com/mismaah/rtl-improved/server/internal/geo"
)

// A straight 1 km line running north, with stops every 250 m, so that distance
// along the route and arrival times can be reasoned about by hand.
func straightLine(t *testing.T) (*Line, []StopRef) {
	t.Helper()
	// 0.0009 degrees of latitude is ~100 m.
	const per100m = 0.000904
	pts := make([]geo.Point, 0, 11)
	for i := 0; i <= 10; i++ {
		pts = append(pts, geo.Point{73.5, 4.17 + float64(i)*per100m})
	}
	line := NewLine([][]geo.Point{pts})
	if line == nil {
		t.Fatal("no line")
	}
	refs := []StopRef{
		{Code: "A", Order: 1, AlongM: 250},
		{Code: "B", Order: 2, AlongM: 500},
		{Code: "C", Order: 3, AlongM: 750},
	}
	return line, refs
}

// at returns a position d metres along the straight test line.
func at(line *Line, d float64) (float64, float64) {
	return 4.17 + (d/100)*0.000904, 73.5
}

func TestArrivalsInterpolateBetweenStraddlingFixes(t *testing.T) {
	line, refs := straightLine(t)

	// One bus, 0 m at t=0 and 1000 m at t=100 s: 10 m/s, so stop B at 500 m
	// must be timed at 50 s even though no fix landed anywhere near it.
	lat0, lng0 := at(line, 0)
	lat1, lng1 := at(line, 1000)
	fixes := []Fix{
		{BusCode: "B1", AtMs: 0, Lat: lat0, Lng: lng0},
		{BusCode: "B1", AtMs: 100_000, Lat: lat1, Lng: lng1},
	}

	got := Arrivals(fixes, refs, line)
	if len(got) != 3 {
		t.Fatalf("got %d arrivals, want 3 (one per stop)", len(got))
	}
	want := map[string]int64{"A": 25_000, "B": 50_000, "C": 75_000}
	for _, a := range got {
		if math.Abs(float64(a.AtMs-want[a.StopCode])) > 1_500 {
			t.Errorf("%s timed at %d ms, want ~%d", a.StopCode, a.AtMs, want[a.StopCode])
		}
	}
}

// The layover artefact: a parked bus drifting back and forth across a stop
// re-crosses it on every forward twitch.
func TestArrivalsIgnoreARepeatOfTheSameStop(t *testing.T) {
	line, refs := straightLine(t)

	var fixes []Fix
	// Creep across stop B at 500 m, wobbling either side of it.
	for i, d := range []float64{480, 495, 505, 495, 510, 500, 515} {
		lat, lng := at(line, d)
		fixes = append(fixes, Fix{BusCode: "B1", AtMs: int64(i) * 10_000, Lat: lat, Lng: lng})
	}

	got := Arrivals(fixes, refs, line)
	if len(got) != 1 {
		t.Fatalf("got %d arrivals for one bus edging past one stop, want 1: %+v", len(got), got)
	}
	if got[0].StopCode != "B" {
		t.Errorf("recorded stop %s, want B", got[0].StopCode)
	}
}

func TestArrivalsRejectALegAcrossALongSilence(t *testing.T) {
	line, refs := straightLine(t)

	lat0, lng0 := at(line, 0)
	lat1, lng1 := at(line, 1000)
	fixes := []Fix{
		{BusCode: "B1", AtMs: 0, Lat: lat0, Lng: lng0},
		{BusCode: "B1", AtMs: MaxInterpolateGapMs + 1, Lat: lat1, Lng: lng1},
	}

	if got := Arrivals(fixes, refs, line); len(got) != 0 {
		t.Errorf("attributed %d arrivals across a silence longer than the cap", len(got))
	}
}

func TestArrivalsRejectAnImpossiblyFastLeg(t *testing.T) {
	line, refs := straightLine(t)

	// 1000 m in 2 s is 500 m/s. The stops were not passed; the feed glitched.
	lat0, lng0 := at(line, 0)
	lat1, lng1 := at(line, 1000)
	fixes := []Fix{
		{BusCode: "B1", AtMs: 0, Lat: lat0, Lng: lng0},
		{BusCode: "B1", AtMs: 2_000, Lat: lat1, Lng: lng1},
	}

	if got := Arrivals(fixes, refs, line); len(got) != 0 {
		t.Errorf("attributed %d arrivals to a 500 m/s leg", len(got))
	}
}

func TestSegmentsOnlyPairAdjacentStops(t *testing.T) {
	_, refs := straightLine(t)

	// B was never observed, so A -> C spans two segments and must be dropped
	// rather than recorded as one long ride.
	arrivals := []Arrival{
		{StopCode: "A", BusCode: "B1", AtMs: 0},
		{StopCode: "C", BusCode: "B1", AtMs: 200_000},
	}
	if got := Segments(arrivals, refs); len(got) != 0 {
		t.Fatalf("recorded %d segments across a missed stop, want 0: %+v", len(got), got)
	}

	arrivals = []Arrival{
		{StopCode: "A", BusCode: "B1", AtMs: 0},
		{StopCode: "B", BusCode: "B1", AtMs: 100_000},
	}
	got := Segments(arrivals, refs)
	if len(got) != 1 || got[0].Secs != 100 {
		t.Fatalf("got %+v, want one A->B segment of 100 s", got)
	}
	if got[0].AtMs != 0 {
		t.Errorf("segment timed at %d, want the moment the ride began", got[0].AtMs)
	}
}

// A bus coming round again is a lap, not a headway: nobody waiting at the stop
// was served by the bus they just watched leave.
func TestHeadwaysNeedADifferentBus(t *testing.T) {
	sameBus := []Arrival{
		{StopCode: "A", BusCode: "B1", AtMs: 0},
		{StopCode: "A", BusCode: "B1", AtMs: 600_000},
	}
	if got := Headways(sameBus); len(got) != 0 {
		t.Errorf("recorded %d headways from one bus lapping, want 0", len(got))
	}

	twoBuses := []Arrival{
		{StopCode: "A", BusCode: "B1", AtMs: 0},
		{StopCode: "A", BusCode: "B2", AtMs: 600_000},
	}
	got := Headways(twoBuses)
	if len(got) != 1 || got[0].Secs != 600 {
		t.Fatalf("got %+v, want one 600 s headway", got)
	}
	if got[0].AtMs != 600_000 {
		t.Errorf("headway timed at %d, want the moment the wait ended", got[0].AtMs)
	}
}

func TestHeadwaysDropAServiceGap(t *testing.T) {
	arrivals := []Arrival{
		{StopCode: "A", BusCode: "B1", AtMs: 0},
		{StopCode: "A", BusCode: "B2", AtMs: int64(MaxHeadwaySecs+1) * 1000},
	}
	if got := Headways(arrivals); len(got) != 0 {
		t.Errorf("recorded %d headways across a service gap, want 0", len(got))
	}
}
