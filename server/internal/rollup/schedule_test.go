package rollup

import (
	"testing"
	"time"

	"github.com/mismaah/rtl-improved/server/internal/rtl"
)

// male builds an instant from a Malé wall clock, which is what every timing in
// the published timetable is expressed in.
func male(hour, minute int) int64 {
	t := time.Date(2026, 9, 7, hour, minute, 0, 0, time.UTC).Add(-MaleOffset)
	return t.UnixMilli()
}

func timetable() []rtl.Stop {
	return []rtl.Stop{{
		Code: "A",
		Timings: []rtl.Timing{
			{Order: 1, Timing: "06:00:00"},
			{Order: 2, Timing: "06:20:00"},
			{Order: 3, Timing: "23:55:00"},
		},
	}}
}

func TestScheduleMatchesTheNearestTrip(t *testing.T) {
	sched := NewSchedule(timetable())
	if sched == nil {
		t.Fatal("NewSchedule returned nil for a route that publishes timings")
	}

	trip, schedMin, delta, ok := sched.Match("A", male(6, 3))
	if !ok {
		t.Fatal("an arrival three minutes after a published departure went unmatched")
	}
	if trip != 1 {
		t.Errorf("matched trip %d, want 1", trip)
	}
	if schedMin != 6*60 {
		t.Errorf("scheduled minute %v, want %v", schedMin, 6*60)
	}
	if delta != 3 {
		t.Errorf("delta %v, want 3 minutes late", delta)
	}

	// Early is negative, and the nearer trip wins.
	_, _, delta, ok = sched.Match("A", male(6, 18))
	if !ok || delta != -2 {
		t.Errorf("got delta %v ok=%v, want -2 against the 06:20 trip", delta, ok)
	}
}

// An arrival past midnight is minutes late against a departure before it, not
// most of a day early. Getting this wrong would put a wildly wrong delta into
// the record for every late-night trip.
func TestScheduleWrapsAtMidnight(t *testing.T) {
	sched := NewSchedule(timetable())
	trip, _, delta, ok := sched.Match("A", male(0, 2))
	if !ok {
		t.Fatal("an arrival at 00:02 went unmatched against a 23:55 departure")
	}
	if trip != 3 {
		t.Errorf("matched trip %d, want 3", trip)
	}
	if delta != 7 {
		t.Errorf("delta %v, want 7 minutes late", delta)
	}
}

// Beyond the skew bound there is no telling which trip an arrival belongs to,
// and guessing reports a very late bus as a slightly early one.
func TestScheduleDeclinesADistantArrival(t *testing.T) {
	sched := NewSchedule(timetable())
	if _, _, _, ok := sched.Match("A", male(12, 0)); ok {
		t.Error("matched an arrival hours from any published departure")
	}
	if _, _, _, ok := sched.Match("B", male(6, 0)); ok {
		t.Error("matched an arrival at a stop with no published timings")
	}
}

// The four routes this whole exercise is for publish no timetable at all. They
// must still record arrivals; they simply have nothing to be late against.
func TestScheduleAbsentForAnUntimetabledRoute(t *testing.T) {
	sched := NewSchedule([]rtl.Stop{{Code: "A"}})
	if sched != nil {
		t.Fatal("NewSchedule built a schedule from a route with no timings")
	}

	arrivals := []Arrival{{StopCode: "A", BusCode: "B1", AtMs: male(6, 0)}}
	got := Annotate(arrivals, sched)
	if len(got) != 1 {
		t.Fatalf("Annotate returned %d arrivals, want 1", len(got))
	}
	if got[0].DeltaMin != nil || got[0].SchedMin != nil || got[0].TripOrder != nil {
		t.Error("an arrival on an untimetabled route was labelled late")
	}
}

func TestAnnotateLabelsMatchedArrivals(t *testing.T) {
	sched := NewSchedule(timetable())
	arrivals := []Arrival{
		{StopCode: "A", BusCode: "B1", AtMs: male(6, 3)},
		{StopCode: "A", BusCode: "B1", AtMs: male(12, 0)},
	}
	got := Annotate(arrivals, sched)

	if got[0].DeltaMin == nil || *got[0].DeltaMin != 3 {
		t.Errorf("first arrival delta = %v, want 3", got[0].DeltaMin)
	}
	if got[0].TripOrder == nil || *got[0].TripOrder != 1 {
		t.Errorf("first arrival trip = %v, want 1", got[0].TripOrder)
	}
	// Unmatched arrivals stay in the record, unlabelled. Dropping them would
	// lose the headway and segment observations derived from the same crossing.
	if got[1].DeltaMin != nil {
		t.Errorf("second arrival delta = %v, want nil", got[1].DeltaMin)
	}
}

// Seconds are kept rather than truncated: truncating would bias every delta the
// same direction, which is exactly the error a median cannot wash out.
func TestParseClockKeepsSeconds(t *testing.T) {
	min, ok := parseClockMinutes("06:30:30")
	if !ok || min != 390.5 {
		t.Errorf("parseClockMinutes(06:30:30) = %v, %v; want 390.5, true", min, ok)
	}
	// A timetable spelling "after midnight" as hour 24.
	if min, ok := parseClockMinutes("24:10:00"); !ok || min != 10 {
		t.Errorf("parseClockMinutes(24:10:00) = %v, %v; want 10, true", min, ok)
	}
	for _, bad := range []string{"", "6", "aa:00:00", "06:xx:00", "99:00:00"} {
		if _, ok := parseClockMinutes(bad); ok {
			t.Errorf("parseClockMinutes(%q) accepted", bad)
		}
	}
}
