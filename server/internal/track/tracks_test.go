package track

import (
	"math"
	"testing"

	"github.com/mismaah/rtl-improved/server/internal/rtl"
)

const start int64 = 1_000_000

// ~11.1 m per 0.0001° of latitude.
func bus(lat float64) []rtl.Bus {
	return []rtl.Bus{{BusCode: "B1", PlateNumber: "B1", Latitude: lat, Longitude: 73.5093}}
}

// These mirror the "bus tracks" cases in test/transit.test.ts. Both
// implementations must agree, and the golden fixture only covers the data it
// happens to contain — these pin the edges it does not reach.

func TestFirstSightingClaimsNoDirection(t *testing.T) {
	tracks := Update(nil, bus(4.1755), start)
	got := tracks["B1"]
	if got.Heading != nil || got.SpeedMps != nil {
		t.Errorf("a bus seen once has heading %v speed %v, want both nil", got.Heading, got.SpeedMps)
	}
}

func TestJitterDoesNotMoveTheAnchor(t *testing.T) {
	tracks := Update(nil, bus(4.1755), start)
	anchorAt := tracks["B1"].AnchorAt
	// ~5.5 m — under MinMoveM.
	tracks = Update(tracks, bus(4.17555), start+10_000)

	got := tracks["B1"]
	if got.AnchorAt != anchorAt {
		t.Errorf("anchor moved on sub-threshold jitter: %d -> %d", anchorAt, got.AnchorAt)
	}
	if got.Heading != nil {
		t.Error("jitter produced a heading")
	}
	if got.UpdatedAt != start+10_000 {
		t.Errorf("updatedAt = %d, want the latest reading", got.UpdatedAt)
	}
}

func TestHeadingKeptAcrossABriefGap(t *testing.T) {
	tracks := Update(nil, bus(4.1755), start)
	tracks = Update(tracks, bus(4.1764), start+10_000)
	heading := tracks["B1"].Heading
	if heading == nil {
		t.Fatal("no heading after a real move")
	}

	// Longer than MaxGapMs so no new bearing is claimed, but well inside
	// HeadingExpiryMs, so the one already on screen still stands.
	tracks = Update(tracks, bus(4.1773), start+10_000+MaxGapMs+1)

	got := tracks["B1"]
	if got.Heading == nil || *got.Heading != *heading {
		t.Errorf("heading = %v, want the retained %v", got.Heading, heading)
	}
	if got.SpeedMps != nil {
		t.Error("a speed was claimed across an untrustworthy gap")
	}
}

// Overnight the bus may have turned at a terminal, finished its run, or been
// swapped out. Last night's direction is not this morning's.
func TestHeadingDroppedAfterLongSilence(t *testing.T) {
	tracks := Update(nil, bus(4.1755), start)
	tracks = Update(tracks, bus(4.1764), start+10_000)
	if tracks["B1"].Heading == nil {
		t.Fatal("no heading after a real move")
	}

	tracks = Update(tracks, bus(4.1773), start+10_000+HeadingExpiryMs+1)

	got := tracks["B1"]
	if got.Heading != nil {
		t.Errorf("heading = %v after a long silence, want nil", *got.Heading)
	}
	if got.SpeedMps != nil {
		t.Error("a speed was claimed across a long silence")
	}
	// Still the same bus, still where the feed puts it.
	if got.FirstSeenAt != start {
		t.Errorf("firstSeenAt = %d, want %d", got.FirstSeenAt, start)
	}
	if got.Lat != 4.1773 {
		t.Errorf("lat = %v, want the reported 4.1773", got.Lat)
	}
	if len(got.Trail) != 0 {
		t.Errorf("trail has %d points, want none across an unaccountable gap", len(got.Trail))
	}
}

func TestParkedBusKeepsHeadingIndefinitely(t *testing.T) {
	tracks := Update(nil, bus(4.1755), start)
	tracks = Update(tracks, bus(4.1764), start+10_000)
	heading := tracks["B1"].Heading

	// Reporting continuously but never moving: hours later it still points the
	// way it last went, rather than snapping back to north.
	at := start + 10_000
	for range 200 {
		at += 60_000
		tracks = Update(tracks, bus(4.1764), at)
	}

	got := tracks["B1"]
	if got.Heading == nil || *got.Heading != *heading {
		t.Errorf("a present-but-parked bus lost its heading: %v", got.Heading)
	}
	if !IsStopped(got, at) {
		t.Error("a bus that has not moved for hours is not reported stopped")
	}
}

func TestImpossibleJumpKeepsHeadingButNotSpeed(t *testing.T) {
	tracks := Update(nil, bus(4.1755), start)
	tracks = Update(tracks, bus(4.1764), start+10_000)
	heading := tracks["B1"].Heading

	// 5 km in one second: a feed glitch, not a bus.
	tracks = Update(tracks, bus(4.22), start+11_000)

	got := tracks["B1"]
	if got.Heading == nil || *got.Heading != *heading {
		t.Errorf("heading = %v, want the retained %v", got.Heading, heading)
	}
	if got.SpeedMps != nil {
		t.Errorf("speed = %v, want nil for an impossible jump", *got.SpeedMps)
	}
}

func TestBusMissingFromFeedIsDropped(t *testing.T) {
	tracks := Update(nil, bus(4.1755), start)
	tracks = Update(tracks, []rtl.Bus{}, start+10_000)
	if len(tracks) != 0 {
		t.Errorf("%d tracks survived an empty feed, want 0", len(tracks))
	}
}

func TestNonFiniteCoordinatesAreSkipped(t *testing.T) {
	nan := math.NaN()
	tracks := Update(nil, []rtl.Bus{{BusCode: "B1", Latitude: nan, Longitude: 73.5}}, start)
	if len(tracks) != 0 {
		t.Errorf("a bus with a NaN coordinate was tracked")
	}
}

// A coordinate that cannot be a bus in the Maldives is dropped rather than
// tracked. RTL's feed emitted (0, 0) in production on 2026-09-02; snapped, it
// reported an 8,195 km offset and put the bus in the Gulf of Guinea for a frame.
//
// Mirrors "rejects an implausible reading outright" in test/transit.test.ts.
func TestUpdateRejectsImplausibleFix(t *testing.T) {
	tests := []struct {
		name     string
		lat, lng float64
	}{
		{"null island", 0, 0},
		{"latitude only", 4.1755, 0},
		{"longitude only", 0, 73.5093},
		{"far west", 4.1755, 0.5},
		{"far north", 60.0, 73.5093},
		{"NaN", math.NaN(), 73.5093},
		{"Inf", 4.1755, math.Inf(1)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			bad := []rtl.Bus{{BusCode: "B1", PlateNumber: "B1", Latitude: tt.lat, Longitude: tt.lng}}
			if got := Update(nil, bad, 1_000_000); len(got) != 0 {
				t.Errorf("tracked %d buses, want none", len(got))
			}
		})
	}
}

// A bus already being tracked keeps its last real position across a bad reading
// rather than teleporting to it and re-anchoring there.
func TestUpdateDropsBadFixWithoutDisturbingTheTrack(t *testing.T) {
	tracks := Update(nil, bus(4.1755), start)
	tracks = Update(tracks, bus(4.1764), start+10_000)
	good := tracks["B1"]

	bad := []rtl.Bus{{BusCode: "B1", PlateNumber: "B1", Latitude: 0, Longitude: 0}}
	tracks = Update(tracks, bad, start+20_000)

	// The bus is absent for this poll, which is the same thing that happens
	// when RTL stops reporting it: the caller keeps the prior track.
	if _, present := tracks["B1"]; present {
		t.Fatal("a bus with only a bad reading was tracked")
	}
	if good.Lat != 4.1764 {
		t.Errorf("prior track was mutated: lat = %v, want 4.1764", good.Lat)
	}
}

// The bounds are a garbage filter, not a service-area check: every position the
// fleet was actually observed at must pass.
func TestPlausibleBoundsAdmitObservedOperations(t *testing.T) {
	// Range of all 37,303 fixes recorded on 2026-09-02.
	corners := []struct{ lat, lng float64 }{
		{4.16896261027325, 73.4832148107506},
		{4.23446885129297, 73.5495485357263},
	}
	for _, c := range corners {
		if !IsPlausibleFix(c.lat, c.lng) {
			t.Errorf("IsPlausibleFix(%v, %v) = false, want true", c.lat, c.lng)
		}
	}
}
