package track

import (
	"encoding/json"
	"math"
	"os"
	"testing"

	"github.com/mismaah/rtl-improved/server/internal/geo"
	"github.com/mismaah/rtl-improved/server/internal/rtl"
)

// This is the load-bearing test of the whole port.
//
// The same golden file is asserted against by test/trackGolden.test.ts on the
// TypeScript side. A client that falls back from this server to calling RTL
// directly switches from the Go inference to the TS one mid-session, so any
// divergence shows up to a rider as a bus jumping on the map. Holding both to
// one fixture turns that class of bug into a build failure.
//
// Regenerate deliberately, never casually:
//   UPDATE_GOLDEN=1 npx vitest run test/trackGolden.test.ts

const fixtureDir = "../../../test/fixtures/"

type goldenTrack struct {
	BusCode     string   `json:"busCode"`
	Lat         float64  `json:"lat"`
	Lng         float64  `json:"lng"`
	Heading     *float64 `json:"heading"`
	SpeedMps    *float64 `json:"speedMps"`
	MovedAt     int64    `json:"movedAt"`
	UpdatedAt   int64    `json:"updatedAt"`
	FirstSeenAt int64    `json:"firstSeenAt"`
	AnchorLat   float64  `json:"anchorLat"`
	AnchorLng   float64  `json:"anchorLng"`
	AnchorAt    int64    `json:"anchorAt"`
	Trail       []struct {
		Lat float64 `json:"lat"`
		Lng float64 `json:"lng"`
		At  int64   `json:"at"`
	} `json:"trail"`
}

type goldenFrame struct {
	At     int64         `json:"at"`
	Tracks []goldenTrack `json:"tracks"`
}

func loadJSON[T any](t *testing.T, name string) T {
	t.Helper()
	raw, err := os.ReadFile(fixtureDir + name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	var out T
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode %s: %v", name, err)
	}
	return out
}

// round mirrors Number.toFixed on the TS side so the two serialize identically.
func round(v float64, places int) float64 {
	scale := math.Pow(10, float64(places))
	return math.Round(v*scale) / scale
}

func roundPtr(v *float64, places int) *float64 {
	if v == nil {
		return nil
	}
	r := round(*v, places)
	return &r
}

func TestGoPortMatchesTypeScriptGolden(t *testing.T) {
	sequence := loadJSON[struct {
		Polls []struct {
			At    int64     `json:"at"`
			Buses []rtl.Bus `json:"buses"`
		} `json:"polls"`
	}](t, "track-sequence.json")

	// The fixture may be a bare FeatureCollection or wrapped in the API's
	// {"roadShape": ...} envelope; accept either, as the TS test does.
	shapeRaw, err := os.ReadFile(fixtureDir + "roadshape-r1.json")
	if err != nil {
		t.Fatalf("read roadshape fixture: %v", err)
	}
	var wrapper struct {
		RoadShape json.RawMessage `json:"roadShape"`
	}
	shape := json.RawMessage(shapeRaw)
	if err := json.Unmarshal(shapeRaw, &wrapper); err == nil && len(wrapper.RoadShape) > 0 {
		shape = wrapper.RoadShape
	}

	golden := loadJSON[struct {
		Frames []goldenFrame `json:"frames"`
	}](t, "track-golden.json")

	lines := geo.Polylines(shape)
	if len(lines) == 0 {
		t.Fatal("fixture yielded no polylines to snap against")
	}
	if len(sequence.Polls) != len(golden.Frames) {
		t.Fatalf("sequence has %d polls but golden has %d frames", len(sequence.Polls), len(golden.Frames))
	}

	tracks := map[string]*Track{}
	for i, poll := range sequence.Polls {
		// Snap before inferring, exactly as useTrackedBuses does on the client.
		snapped := make([]rtl.Bus, 0, len(poll.Buses))
		for _, bus := range poll.Buses {
			s := Snap(geo.LatLng{Lat: bus.Latitude, Lng: bus.Longitude}, lines, FullSnapM, NoSnapM)
			bus.Latitude, bus.Longitude = s.Lat, s.Lng
			snapped = append(snapped, bus)
		}
		tracks = Update(tracks, snapped, poll.At)

		want := golden.Frames[i]
		if want.At != poll.At {
			t.Fatalf("frame %d: golden at=%d, sequence at=%d", i, want.At, poll.At)
		}
		if len(tracks) != len(want.Tracks) {
			t.Fatalf("frame %d (at=%d): %d tracks, want %d", i, poll.At, len(tracks), len(want.Tracks))
		}

		for _, expected := range want.Tracks {
			got, ok := tracks[expected.BusCode]
			if !ok {
				t.Fatalf("frame %d: bus %s missing from Go tracks", i, expected.BusCode)
			}
			compareTrack(t, i, expected, got)
		}
	}
}

func compareTrack(t *testing.T, frame int, want goldenTrack, got *Track) {
	t.Helper()
	where := func(field string) string {
		return "frame " + itoa(frame) + " bus " + want.BusCode + " " + field
	}

	if r := round(got.Lat, 9); r != want.Lat {
		t.Errorf("%s: lat = %v, want %v", where("lat"), r, want.Lat)
	}
	if r := round(got.Lng, 9); r != want.Lng {
		t.Errorf("%s: lng = %v, want %v", where("lng"), r, want.Lng)
	}
	if !equalPtr(roundPtr(got.Heading, 6), want.Heading) {
		t.Errorf("%s: heading = %v, want %v", where("heading"), fmtPtr(got.Heading), fmtPtr(want.Heading))
	}
	if !equalPtr(roundPtr(got.SpeedMps, 6), want.SpeedMps) {
		t.Errorf("%s: speedMps = %v, want %v", where("speed"), fmtPtr(got.SpeedMps), fmtPtr(want.SpeedMps))
	}
	if got.MovedAt != want.MovedAt {
		t.Errorf("%s: movedAt = %d, want %d", where("movedAt"), got.MovedAt, want.MovedAt)
	}
	if got.UpdatedAt != want.UpdatedAt {
		t.Errorf("%s: updatedAt = %d, want %d", where("updatedAt"), got.UpdatedAt, want.UpdatedAt)
	}
	if got.FirstSeenAt != want.FirstSeenAt {
		t.Errorf("%s: firstSeenAt = %d, want %d", where("firstSeenAt"), got.FirstSeenAt, want.FirstSeenAt)
	}
	if r := round(got.Anchor.Lat, 9); r != want.AnchorLat {
		t.Errorf("%s: anchor.lat = %v, want %v", where("anchor"), r, want.AnchorLat)
	}
	if r := round(got.Anchor.Lng, 9); r != want.AnchorLng {
		t.Errorf("%s: anchor.lng = %v, want %v", where("anchor"), r, want.AnchorLng)
	}
	if got.AnchorAt != want.AnchorAt {
		t.Errorf("%s: anchorAt = %d, want %d", where("anchorAt"), got.AnchorAt, want.AnchorAt)
	}

	if len(got.Trail) != len(want.Trail) {
		t.Fatalf("%s: trail has %d points, want %d", where("trail"), len(got.Trail), len(want.Trail))
	}
	for j, p := range want.Trail {
		if r := round(got.Trail[j].Lat, 9); r != p.Lat {
			t.Errorf("%s[%d]: lat = %v, want %v", where("trail"), j, r, p.Lat)
		}
		if r := round(got.Trail[j].Lng, 9); r != p.Lng {
			t.Errorf("%s[%d]: lng = %v, want %v", where("trail"), j, r, p.Lng)
		}
		if got.Trail[j].At != p.At {
			t.Errorf("%s[%d]: at = %d, want %d", where("trail"), j, got.Trail[j].At, p.At)
		}
	}
}

func equalPtr(a, b *float64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func fmtPtr(v *float64) string {
	if v == nil {
		return "null"
	}
	return ftoa(*v)
}
