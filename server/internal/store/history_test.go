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

// A ride is measured whole, from one bus's arrival at each end. The point is
// that it is not the sum of the legs along the way: leg times are right-skewed,
// so summing per-leg medians drops the holds every real ride accumulates some of.
func TestHistoryMeasuresWholeRides(t *testing.T) {
	db := openTest(t)

	// Five passes, A→B→C. Each leg is usually quick and occasionally held, and
	// the holds never fall on the same leg twice — so every leg's median is 60 s
	// while no run actually took 120 s end to end.
	legs := [][2]int64{{60, 300}, {300, 60}, {60, 60}, {60, 300}, {300, 60}}
	var arrivals []Arrival
	for i, pair := range legs {
		start := at(1, 8) + int64(i)*3_600_000
		for stop, offset := range map[string]int64{
			"A": 0, "B": pair[0] * 1000, "C": (pair[0] + pair[1]) * 1000,
		} {
			arrivals = append(arrivals, Arrival{
				RouteCode: "133", StopCode: stop, BusCode: "C1", AtMs: start + offset,
			})
		}
	}
	if err := db.ReplaceAggregates(t.Context(), "133", at(2, 0), at(0, 0),
		arrivals, nil, nil); err != nil {
		t.Fatalf("ReplaceAggregates: %v", err)
	}

	route := historyOf(t, db).Routes["133"]
	if route == nil {
		t.Fatal("no history for 133")
	}
	if got := route.RideSecs["A>B"]; got != 60 {
		t.Errorf("A>B = %v s, want the leg median 60", got)
	}
	if got := route.RideSecs["B>C"]; got != 60 {
		t.Errorf("B>C = %v s, want the leg median 60", got)
	}
	// The whole ride, which no sum of the two legs above would have found.
	if got := route.RideSecs["A>C"]; got != 360 {
		t.Errorf("A>C = %v s, want 360 — the legs summed would say 120", got)
	}
}

// Going round again is a lap, not a ride. The repeat is what ends a run, which
// is also why the route's own stop order is never needed here.
func TestHistoryRideStopsAtTheLap(t *testing.T) {
	db := openTest(t)

	var arrivals []Arrival
	for lap := 0; lap < MinSamples; lap++ {
		start := at(1, 9) + int64(lap)*3_600_000
		for i, stop := range []string{"A", "B", "A", "B"} {
			arrivals = append(arrivals, Arrival{
				RouteCode: "133", StopCode: stop, BusCode: "C1",
				AtMs: start + int64(i)*60_000,
			})
		}
	}
	if err := db.ReplaceAggregates(t.Context(), "133", at(2, 0), at(0, 0),
		arrivals, nil, nil); err != nil {
		t.Fatalf("ReplaceAggregates: %v", err)
	}

	route := historyOf(t, db).Routes["133"]
	if got := route.RideSecs["A>B"]; got != 60 {
		t.Errorf("A>B = %v s, want 60 — one hop, not a lap and a hop", got)
	}
	// B→A only ever happens by going round, so it is not a ride anyone takes.
	if _, ok := route.RideSecs["B>A"]; ok {
		t.Errorf("served B>A, which is a lap: %v", route.RideSecs["B>A"])
	}
}

// A bus that fell silent long enough to have done something else did not ride
// across that silence, so the pair spanning it is not a measurement.
func TestHistoryRideRejectsLongSilences(t *testing.T) {
	db := openTest(t)

	var arrivals []Arrival
	for i := 0; i < MinSamples; i++ {
		start := at(1, 10) + int64(i)*(4*3_600_000)
		arrivals = append(arrivals,
			Arrival{RouteCode: "133", StopCode: "A", BusCode: "C1", AtMs: start},
			Arrival{RouteCode: "133", StopCode: "B", BusCode: "C1",
				AtMs: start + (MaxRideGapSecs+60)*1000},
		)
	}
	if err := db.ReplaceAggregates(t.Context(), "133", at(2, 0), at(0, 0),
		arrivals, nil, nil); err != nil {
		t.Fatalf("ReplaceAggregates: %v", err)
	}

	if route := historyOf(t, db).Routes["133"]; route != nil {
		if _, ok := route.RideSecs["A>B"]; ok {
			t.Errorf("served a ride across a %d-minute silence", MaxRideGapSecs/60)
		}
	}
}

// A rider turning up at random waits sum(h²)/2·sum(h), not half the median
// gap: they are far more likely to land in the 64-minute gap than in any of the
// short ones.
func TestHistoryWaitIsWhatARiderExperiences(t *testing.T) {
	db := openTest(t)
	var headways []Headway
	for _, mins := range []float64{2, 3, 3, 4, 64} {
		headways = append(headways, Headway{RouteCode: "122", StopCode: "A", AtMs: at(1, 8), Secs: mins * 60})
	}
	if err := db.ReplaceAggregates(t.Context(), "122", at(2, 0), at(0, 0), nil, nil, headways); err != nil {
		t.Fatalf("ReplaceAggregates: %v", err)
	}
	route := historyOf(t, db).Routes["122"]
	if route == nil || route.WaitMin == nil {
		t.Fatal("no wait for a route with five headways")
	}
	// (4+9+9+16+4096) / (2·76) = 27.2
	if *route.WaitMin != 27.2 {
		t.Errorf("waitMin = %v, want 27.2", *route.WaitMin)
	}
	if route.WaitByHour["8"] != 27.2 {
		t.Errorf("waitByHour[8] = %v, want 27.2", route.WaitByHour["8"])
	}
}

func matchedArrivals(code string, deltas []float64, atMs int64) []Arrival {
	out := make([]Arrival, 0, len(deltas))
	for i, delta := range deltas {
		d := delta
		trip := i
		out = append(out, Arrival{RouteCode: code, StopCode: "A", BusCode: "C1",
			AtMs: atMs + int64(i)*60000, TripOrder: &trip, DeltaMin: &d})
	}
	return out
}

// The early tail is what a rider has to allow for. A route that never runs
// early needs no margin at all.
func TestHistoryEarlinessIsTheEarlyTail(t *testing.T) {
	db := openTest(t)
	var spread []float64
	for d := -10; d <= 10; d++ {
		spread = append(spread, float64(d))
	}
	late := make([]float64, 21)
	for i := range late {
		late[i] = 3
	}
	if err := db.ReplaceAggregates(t.Context(), "133", at(2, 0), at(0, 0),
		matchedArrivals("133", spread, at(1, 8)), nil, nil); err != nil {
		t.Fatalf("ReplaceAggregates: %v", err)
	}
	if err := db.ReplaceAggregates(t.Context(), "124", at(2, 0), at(0, 0),
		matchedArrivals("124", late, at(1, 8)), nil, nil); err != nil {
		t.Fatalf("ReplaceAggregates: %v", err)
	}

	summary := historyOf(t, db)
	// 21 values -10..10: the 15th percentile is rank 3, which is -7.
	if r := summary.Routes["133"]; r == nil || r.EarlyMin == nil || *r.EarlyMin != 7 {
		t.Errorf("133 earlyMin = %v, want 7", r.EarlyMin)
	} else if r.EarlyByHour["8"] != 7 {
		t.Errorf("133 earlyByHour[8] = %v, want 7", r.EarlyByHour["8"])
	}
	if r := summary.Routes["124"]; r == nil || r.EarlyMin == nil || *r.EarlyMin != 0 {
		t.Errorf("124 earlyMin = %v, want 0 for a route always late", r.EarlyMin)
	}
}

// Activity is what tells a route that has stopped for the evening, or never
// runs, from one that is merely infrequent.
func TestHistoryActivityShares(t *testing.T) {
	db := openTest(t)
	var busy, rare []Arrival
	for day := 2; day <= 5; day++ {
		busy = append(busy, Arrival{RouteCode: "133", StopCode: "A", BusCode: "C1", AtMs: at(day, 8)})
	}
	rare = append(rare, Arrival{RouteCode: "121", StopCode: "A", BusCode: "C9", AtMs: at(3, 8)})
	// Today is not a whole day and must not count.
	busy = append(busy, Arrival{RouteCode: "133", StopCode: "A", BusCode: "C1", AtMs: time.Now().UnixMilli() - 1000})

	for code, arrivals := range map[string][]Arrival{"133": busy, "121": rare} {
		if err := db.ReplaceAggregates(t.Context(), code, at(10, 0), time.Now().UnixMilli()+1, arrivals, nil, nil); err != nil {
			t.Fatalf("ReplaceAggregates: %v", err)
		}
	}

	summary := historyOf(t, db)
	if summary.Days != 4 {
		t.Fatalf("days = %d, want the 4 whole days observed", summary.Days)
	}
	total := 0
	for _, n := range summary.DayTypeDays {
		total += n
	}
	if total != 4 {
		t.Errorf("dayTypeDays sum to %d, want 4", total)
	}
	busyRoute, rareRoute := summary.Routes["133"], summary.Routes["121"]
	if busyRoute == nil || busyRoute.ActiveDays != 4 || busyRoute.ActiveByHour["8"] != 1 {
		t.Errorf("133 = %+v, want active all 4 days at 08:00", busyRoute)
	}
	if rareRoute == nil || rareRoute.ActiveDays != 1 || rareRoute.ActiveByHour["8"] != 0.25 {
		t.Errorf("121 = %+v, want active 1 day of 4", rareRoute)
	}
}

// Friday and the working week are kept apart: pooled, they describe neither.
func TestHistorySplitsByDayType(t *testing.T) {
	db := openTest(t)
	friday, weekday := -1, -1
	for d := 1; d <= 8; d++ {
		switch DayType(ServiceDateAt(at(d, 9))) {
		case DayTypeFriday:
			if friday < 0 {
				friday = d
			}
		case DayTypeWeek:
			if weekday < 0 {
				weekday = d
			}
		}
	}
	var headways []Headway
	for i := 0; i < 5; i++ {
		headways = append(headways,
			Headway{RouteCode: "145", StopCode: "A", AtMs: at(friday, 9) + int64(i), Secs: 600},
			Headway{RouteCode: "145", StopCode: "A", AtMs: at(weekday, 9) + int64(i), Secs: 1800})
	}
	if err := db.ReplaceAggregates(t.Context(), "145", at(10, 0), at(0, 0), nil, nil, headways); err != nil {
		t.Fatalf("ReplaceAggregates: %v", err)
	}
	route := historyOf(t, db).Routes["145"]
	if route == nil || route.DayTypes == nil {
		t.Fatal("no day-type split")
	}
	if got := route.DayTypes[DayTypeFriday].HeadwayByHour["9"]; got != 10 {
		t.Errorf("Friday headway = %v, want 10", got)
	}
	if got := route.DayTypes[DayTypeWeek].HeadwayByHour["9"]; got != 30 {
		t.Errorf("working-day headway = %v, want 30", got)
	}
}

func TestServiceDateRollsBackBeforeFourAm(t *testing.T) {
	// 00:30 Malé on the 14th is still the 13th's service day.
	atMs := time.Date(2026, 11, 13, 19, 30, 0, 0, time.UTC).UnixMilli()
	if got := ServiceDateAt(atMs); got != "2026-11-13" {
		t.Errorf("ServiceDateAt(00:30 Malé 14th) = %s, want 2026-11-13", got)
	}
	if DayType("2026-11-13") != DayTypeFriday || DayType("2026-11-14") != DayTypeSaturday || DayType("2026-11-15") != DayTypeWeek {
		t.Error("day types misclassified")
	}
}
