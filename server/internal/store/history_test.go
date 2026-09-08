package store

import (
	"testing"
	"time"
)

// at builds an instant at a given Malé hour, some days back, so a test can put
// observations in the hour buckets History groups by.
func at(daysAgo, hour int) int64 {
	t := time.Now().UTC().Add(MaleOffset).Truncate(24 * time.Hour)
	t = t.AddDate(0, 0, -daysAgo).Add(time.Duration(hour) * time.Hour)
	return t.Add(-MaleOffset).UnixMilli()
}

func historyOf(t *testing.T, db *DB) *HistorySummary {
	t.Helper()
	now := time.Now()
	got, err := db.History(t.Context(), now.AddDate(0, 0, -28).UnixMilli(), now.UnixMilli())
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	return got
}

// The median, not the mean. Waits bunch and then gap, so a mean sits between the
// two modes and describes neither.
func TestHistoryHeadwayIsAMedian(t *testing.T) {
	db := openTest(t)

	var headways []Headway
	// Four short waits and one very long one. Mean 15.2 min, median 3.
	for _, mins := range []float64{2, 3, 3, 4, 64} {
		headways = append(headways, Headway{
			RouteCode: "133", StopCode: "A", AtMs: at(1, 8), Secs: mins * 60,
		})
	}
	if err := db.ReplaceAggregates(t.Context(), "133", at(2, 0), at(0, 0),
		nil, nil, headways); err != nil {
		t.Fatalf("ReplaceAggregates: %v", err)
	}

	route := historyOf(t, db).Routes["133"]
	if route == nil || route.HeadwayMin == nil {
		t.Fatal("no headway for a route with five observations")
	}
	if *route.HeadwayMin != 3 {
		t.Errorf("headwayMin = %v, want the median 3 rather than the mean 15.2", *route.HeadwayMin)
	}
	if route.HeadwaySamples != 5 {
		t.Errorf("headwaySamples = %d, want 5", route.HeadwaySamples)
	}
	if route.HeadwayIsLap {
		t.Error("different-bus waits were reported as laps")
	}
}

// A route worked by one bus at a time has no different-bus waits at all. The lap
// is the wait a rider actually has, so it is served — flagged, so a consumer
// that cares can tell.
func TestHistoryFallsBackToLaps(t *testing.T) {
	db := openTest(t)

	var headways []Headway
	for i := 0; i < 6; i++ {
		headways = append(headways, Headway{
			RouteCode: "130", StopCode: "A", AtMs: at(1, 9), Secs: 2400, SameBus: true,
		})
	}
	// One handover between vehicles, far too few to stand on its own.
	headways = append(headways, Headway{
		RouteCode: "130", StopCode: "A", AtMs: at(1, 9), Secs: 300,
	})
	if err := db.ReplaceAggregates(t.Context(), "130", at(2, 0), at(0, 0),
		nil, nil, headways); err != nil {
		t.Fatalf("ReplaceAggregates: %v", err)
	}

	route := historyOf(t, db).Routes["130"]
	if route == nil || route.HeadwayMin == nil {
		t.Fatal("a one-bus route was left with no measured wait at all")
	}
	if !route.HeadwayIsLap {
		t.Error("a lap-derived wait was not flagged as one")
	}
	if *route.HeadwayMin != 40 {
		t.Errorf("headwayMin = %v, want the 40 minute lap", *route.HeadwayMin)
	}
}

// A thin bucket is one bus's afternoon, not a measurement. The consumer's own
// assumption beats a confident wrong number, so nothing is served.
func TestHistoryWithholdsThinBuckets(t *testing.T) {
	db := openTest(t)

	if err := db.ReplaceAggregates(t.Context(), "145", at(2, 0), at(0, 0), nil,
		[]Segment{{RouteCode: "145", FromStop: "A", ToStop: "B", AtMs: at(1, 7), Secs: 90}},
		[]Headway{{RouteCode: "145", StopCode: "A", AtMs: at(1, 7), Secs: 600}}); err != nil {
		t.Fatalf("ReplaceAggregates: %v", err)
	}

	got := historyOf(t, db)
	if route := got.Routes["145"]; route != nil {
		if route.HeadwayMin != nil {
			t.Errorf("served a headway from one observation: %v", *route.HeadwayMin)
		}
		if len(route.SegmentSecs) != 0 {
			t.Errorf("served segments from one observation: %v", route.SegmentSecs)
		}
	}
}

func TestHistorySummarisesSegmentsAndLateness(t *testing.T) {
	db := openTest(t)

	var segments []Segment
	var arrivals []Arrival
	for i := 0; i < MinSamples; i++ {
		segments = append(segments, Segment{
			RouteCode: "133", FromStop: "A", ToStop: "B", AtMs: at(1, 7), Secs: 120,
		})
		trip, sched, delta := 1, 420.0, 4.0
		arrivals = append(arrivals, Arrival{
			RouteCode: "133", StopCode: "A", BusCode: "C1", AtMs: at(1, 7) + int64(i),
			TripOrder: &trip, SchedMin: &sched, DeltaMin: &delta,
		})
	}
	if err := db.ReplaceAggregates(t.Context(), "133", at(2, 0), at(0, 0),
		arrivals, segments, nil); err != nil {
		t.Fatalf("ReplaceAggregates: %v", err)
	}

	route := historyOf(t, db).Routes["133"]
	if route == nil {
		t.Fatal("no history for 133")
	}
	if got := route.SegmentSecs["A>B"]; got != 120 {
		t.Errorf("segment A>B = %v s, want 120", got)
	}
	if route.LatenessSamples != MinSamples {
		t.Errorf("latenessSamples = %d, want %d", route.LatenessSamples, MinSamples)
	}
	if got := route.LatenessByHour["7"]; got != 4 {
		t.Errorf("lateness at 07:00 = %v, want 4 minutes late", got)
	}
}

// An unmatched arrival contributes nothing to lateness. A route with no
// timetable must not be reported as running exactly on time.
func TestHistoryIgnoresUnmatchedArrivals(t *testing.T) {
	db := openTest(t)

	var arrivals []Arrival
	for i := 0; i < MinSamples; i++ {
		arrivals = append(arrivals, Arrival{
			RouteCode: "122", StopCode: "A", BusCode: "C1", AtMs: at(1, 7) + int64(i),
		})
	}
	if err := db.ReplaceAggregates(t.Context(), "122", at(2, 0), at(0, 0),
		arrivals, nil, nil); err != nil {
		t.Fatalf("ReplaceAggregates: %v", err)
	}

	if route := historyOf(t, db).Routes["122"]; route != nil && len(route.LatenessByHour) > 0 {
		t.Errorf("an untimetabled route was reported late/early: %v", route.LatenessByHour)
	}
}

func TestMedian(t *testing.T) {
	if got := median([]float64{5, 1, 3}); got != 3 {
		t.Errorf("median of odd sample = %v, want 3", got)
	}
	if got := median([]float64{1, 2, 3, 4}); got != 2.5 {
		t.Errorf("median of even sample = %v, want 2.5", got)
	}
	if got := median(nil); got != 0 {
		t.Errorf("median of nothing = %v, want 0", got)
	}
}

// The same leg is a different ride at the evening peak than it is late at
// night, and an arrival predicted minutes out is where that difference shows.
// Hours thin enough to be one bus's evening are withheld, and the pooled median
// is still served for the consumer to fall back to.
func TestHistorySplitsSegmentsByHour(t *testing.T) {
	db := openTest(t)

	var segments []Segment
	for i := 0; i < MinSamples; i++ {
		segments = append(segments,
			Segment{RouteCode: "133", FromStop: "A", ToStop: "B", AtMs: at(1, 7), Secs: 300},
			Segment{RouteCode: "133", FromStop: "A", ToStop: "B", AtMs: at(1, 23), Secs: 100},
		)
	}
	// One lonely ride in a third hour: a bucket, but not a measurement.
	segments = append(segments,
		Segment{RouteCode: "133", FromStop: "A", ToStop: "B", AtMs: at(1, 14), Secs: 999})

	if err := db.ReplaceAggregates(t.Context(), "133", at(2, 0), at(0, 0),
		nil, segments, nil); err != nil {
		t.Fatalf("ReplaceAggregates: %v", err)
	}

	route := historyOf(t, db).Routes["133"]
	if route == nil {
		t.Fatal("no history for 133")
	}

	byHour := route.SegmentSecsByHour["A>B"]
	if got := byHour["7"]; got != 300 {
		t.Errorf("A>B at 07:00 = %v s, want 300", got)
	}
	if got := byHour["23"]; got != 100 {
		t.Errorf("A>B at 23:00 = %v s, want 100", got)
	}
	if _, ok := byHour["14"]; ok {
		t.Errorf("served 14:00 from a single ride: %v", byHour["14"])
	}
	// The pooled median still covers every hour that has no bucket of its own.
	// Eleven rides, so it is the sixth of them and not a blend of the two peaks:
	// pooling answers "usually", which is exactly why an hourly figure is worth
	// serving beside it.
	if got := route.SegmentSecs["A>B"]; got != 300 {
		t.Errorf("pooled A>B = %v s, want 300", got)
	}
}
