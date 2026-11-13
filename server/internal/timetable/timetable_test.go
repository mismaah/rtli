package timetable

import (
	"testing"
	"time"

	"github.com/mismaah/rtl-improved/server/internal/rtl"
	"github.com/mismaah/rtl-improved/server/internal/store"
)

// male builds an instant from Malé wall-clock time.
func male(date string, hour, minute int) time.Time {
	day, err := time.Parse("2006-01-02", date)
	if err != nil {
		panic(err)
	}
	return day.Add(time.Duration(hour)*time.Hour + time.Duration(minute)*time.Minute - store.MaleOffset)
}

// details is one route with one stop listing the given trips, as RTL would
// return them: only departures still to come.
func details(trips map[int]string) rtl.RouteDetails {
	timings := make([]rtl.Timing, 0, len(trips))
	for order, at := range trips {
		timings = append(timings, rtl.Timing{Order: order, Timing: at})
	}
	return rtl.RouteDetails{RouteResponse: []rtl.Route{{
		Code: "133",
		BusRouteStopList: []rtl.Stop{
			{Code: "A", Order: 1, Timings: timings},
			{Code: "B", Order: 2},
		},
	}}}
}

func openStore(t *testing.T) *store.DB {
	t.Helper()
	db, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func orders(timings []rtl.Timing) []int {
	out := make([]int, len(timings))
	for i, timing := range timings {
		out[i] = timing.Order
	}
	return out
}

// The bug this package exists for: a later fetch no longer lists the morning,
// and the day must not forget it.
func TestMergeKeepsDeparturesThatHaveLeft(t *testing.T) {
	book := New(openStore(t), nil)
	ctx := t.Context()

	book.Merge(ctx, details(map[int]string{1: "05:00:00", 2: "07:00:00", 3: "09:00:00"}), male("2026-11-15", 4, 3))
	served := book.Merge(ctx, details(map[int]string{3: "09:00:00"}), male("2026-11-15", 8, 0))

	got := orders(served.RouteResponse[0].BusRouteStopList[0].Timings)
	if len(got) != 3 || got[0] != 1 || got[2] != 3 {
		t.Fatalf("served trips = %v, want [1 2 3]", got)
	}

	timings, source, ok := book.For(ctx, "2026-11-15")
	if !ok || !source.Own || !source.Complete {
		t.Fatalf("source = %+v ok=%v, want own and complete", source, ok)
	}
	if got := orders(timings["133"]["A"]); len(got) != 3 {
		t.Errorf("rollup timings = %v, want all three trips", got)
	}
}

func TestMergeLeavesTheCallersResponseAlone(t *testing.T) {
	book := New(nil, nil)
	ctx := t.Context()
	book.Merge(ctx, details(map[int]string{1: "05:00:00", 2: "07:00:00"}), male("2026-11-15", 4, 3))

	later := details(map[int]string{2: "07:00:00"})
	book.Merge(ctx, later, male("2026-11-15", 6, 0))
	if n := len(later.RouteResponse[0].BusRouteStopList[0].Timings); n != 1 {
		t.Errorf("caller's response now lists %d trips, want the 1 RTL sent", n)
	}
}

func TestCaptureStartedLateIsIncomplete(t *testing.T) {
	book := New(openStore(t), nil)
	ctx := t.Context()
	book.Merge(ctx, details(map[int]string{30: "07:20:00"}), male("2026-11-15", 7, 15))

	_, source, ok := book.For(ctx, "2026-11-15")
	if !ok || source.Complete {
		t.Fatalf("source = %+v, want an incomplete own capture", source)
	}
	if book.Generation() != 0 {
		t.Errorf("generation = %d, want 0 with nothing complete", book.Generation())
	}
}

// Before 04:00 it is unclear which day RTL is describing, so nothing is filed.
func TestMergeBeforeServiceDayPassesThrough(t *testing.T) {
	db := openStore(t)
	book := New(db, nil)
	ctx := t.Context()
	in := details(map[int]string{40: "00:20:00"})
	out := book.Merge(ctx, in, male("2026-11-15", 0, 10))

	if len(out.RouteResponse[0].BusRouteStopList[0].Timings) != 1 {
		t.Error("response was altered before the service day opened")
	}
	stored, err := db.ListTimetables(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 0 {
		t.Errorf("stored %d days from an overnight fetch, want none", len(stored))
	}
}

func TestRestartResumesTodaysCapture(t *testing.T) {
	db := openStore(t)
	ctx := t.Context()

	first := New(db, nil)
	first.Merge(ctx, details(map[int]string{1: "05:00:00", 2: "07:00:00"}), male("2026-11-15", 4, 2))

	restarted := New(db, nil)
	if err := restarted.Load(ctx, male("2026-11-15", 10, 0)); err != nil {
		t.Fatal(err)
	}
	served := restarted.Merge(ctx, details(map[int]string{2: "07:00:00"}), male("2026-11-15", 10, 0))
	if got := orders(served.RouteResponse[0].BusRouteStopList[0].Timings); len(got) != 2 {
		t.Fatalf("after restart served %v, want the morning trip kept", got)
	}
	_, source, _ := restarted.For(ctx, "2026-11-15")
	if !source.Complete {
		t.Error("restart turned a complete day incomplete")
	}
	if restarted.Generation() == 0 {
		t.Error("a stored complete day did not register on load")
	}
}

// A day captured late is measured against the nearest complete day of its own
// type, with its own late capture laid over the top.
func TestStandInPrefersSameDayType(t *testing.T) {
	db := openStore(t)
	ctx := t.Context()
	book := New(db, nil)

	// Thursday 12th and Friday 13th complete, with different trip 1 times.
	book.Merge(ctx, details(map[int]string{1: "05:00:00", 2: "06:00:00"}), male("2026-11-12", 4, 1))
	book.Merge(ctx, details(map[int]string{1: "08:00:00", 2: "09:00:00"}), male("2026-11-13", 4, 1))
	// Sunday 15th captured from 07:15 only, seeing trip 2 run late.
	book.Merge(ctx, details(map[int]string{2: "06:30:00"}), male("2026-11-15", 7, 15))

	timings, source, ok := book.For(ctx, "2026-11-15")
	if !ok {
		t.Fatal("no timetable for a day with a capture and stand-ins")
	}
	if source.Own || source.Date != "2026-11-12" {
		t.Fatalf("stand-in = %+v, want Thursday 2026-11-12 (same day type), not Friday", source)
	}
	trips := timings["133"]["A"]
	if len(trips) != 2 || trips[0].Timing != "05:00:00" || trips[1].Timing != "06:30:00" {
		t.Errorf("timings = %+v, want Thursday's trip 1 and the day's own trip 2", trips)
	}
}

func TestNothingKnownForADay(t *testing.T) {
	book := New(openStore(t), nil)
	if _, _, ok := book.For(t.Context(), "2026-09-14"); ok {
		t.Error("returned a timetable with nothing stored")
	}
}

// The rollup re-derives history when this moves, so it must move once per day
// type gaining its first complete day — not every day.
func TestGenerationMovesOncePerDayType(t *testing.T) {
	book := New(openStore(t), nil)
	ctx := t.Context()
	merge := func(date string) {
		book.Merge(ctx, details(map[int]string{1: "05:00:00"}), male(date, 4, 1))
	}

	merge("2026-11-15") // Sunday
	merge("2026-11-16") // Monday: same type
	if g := book.Generation(); g != 1 {
		t.Fatalf("generation = %d after two working days, want 1", g)
	}
	merge("2026-11-20") // Friday
	merge("2026-11-21") // Saturday
	merge("2026-11-27") // another Friday
	if g := book.Generation(); g != 3 {
		t.Errorf("generation = %d with all three types complete, want 3", g)
	}
}
