package geo

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

// Values cross-checked against the TS implementation in src/lib/geo.ts.
func TestHaversineMeters(t *testing.T) {
	tests := []struct {
		name string
		a, b LatLng
		want float64
	}{
		{"same point", LatLng{4.1755, 73.5093}, LatLng{4.1755, 73.5093}, 0},
		// Malé terminal to a Hulhumalé stop, across the link road.
		{"male to hulhumale", LatLng{4.169366, 73.504676}, LatLng{4.224989, 73.544342}, 7589.7209},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Tight: these are reference values taken from the TS
			// implementation, and the two must not drift apart.
			got := HaversineMeters(tt.a, tt.b)
			if math.Abs(got-tt.want) > 1e-3 {
				t.Errorf("HaversineMeters = %.4f, want %.4f", got, tt.want)
			}
		})
	}
}

func TestBearingDegrees(t *testing.T) {
	origin := LatLng{4.1755, 73.5093}
	tests := []struct {
		name string
		to   LatLng
		want float64
	}{
		{"due north", LatLng{4.2755, 73.5093}, 0},
		{"due east", LatLng{4.1755, 73.6093}, 90},
		{"due south", LatLng{4.0755, 73.5093}, 180},
		{"due west", LatLng{4.1755, 73.4093}, 270},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := BearingDegrees(origin, tt.to)
			if math.Abs(got-tt.want) > 0.5 {
				t.Errorf("BearingDegrees = %.2f, want %.0f", got, tt.want)
			}
		})
	}
}

// The result must always be normalized into [0, 360).
func TestBearingIsNormalized(t *testing.T) {
	for _, to := range []LatLng{{4.0, 73.4}, {4.3, 73.6}, {4.1, 73.9}, {3.9, 73.1}} {
		got := BearingDegrees(LatLng{4.1755, 73.5093}, to)
		if got < 0 || got >= 360 {
			t.Errorf("BearingDegrees to %+v = %f, outside [0,360)", to, got)
		}
	}
}

func TestSimplifyLineKeepsEndpoints(t *testing.T) {
	line := []Point{{0, 0}, {1, 0.0000001}, {2, 0}, {3, 0.0000001}, {4, 0}}
	got := SimplifyLine(line, DefaultSimplifyEpsilon)
	if len(got) != 2 {
		t.Fatalf("a near-straight line simplified to %d points, want 2", len(got))
	}
	if got[0] != line[0] || got[1] != line[len(line)-1] {
		t.Errorf("endpoints not preserved: got %v", got)
	}
}

func TestSimplifyLineKeepsRealCorners(t *testing.T) {
	// A right-angle turn is exactly the detail that must survive.
	line := []Point{{0, 0}, {0.5, 0}, {1, 0}, {1, 0.5}, {1, 1}}
	got := SimplifyLine(line, DefaultSimplifyEpsilon)
	if len(got) != 3 {
		t.Fatalf("simplified to %d points, want 3 (both ends plus the corner)", len(got))
	}
	if got[1] != (Point{1, 0}) {
		t.Errorf("corner = %v, want [1 0]", got[1])
	}
}

func TestSimplifyLineShortInputUntouched(t *testing.T) {
	for _, line := range [][]Point{nil, {{1, 1}}, {{1, 1}, {2, 2}}} {
		if got := SimplifyLine(line, DefaultSimplifyEpsilon); len(got) != len(line) {
			t.Errorf("SimplifyLine(%v) = %v, want unchanged", line, got)
		}
	}
}

// The real R1 geometry, to prove the payload actually shrinks and stays valid.
func TestSimplifyRealRoadShape(t *testing.T) {
	raw, err := os.ReadFile("../../../test/fixtures/roadshape-r1.json")
	if err != nil {
		t.Skipf("fixture unavailable: %v", err)
	}
	var response struct {
		RoadShape json.RawMessage `json:"roadShape"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	source := response.RoadShape
	if len(source) == 0 {
		source = raw // The fixture may already be a bare FeatureCollection.
	}

	before := len(Polylines(source))
	if before == 0 {
		t.Fatal("fixture yielded no polylines")
	}

	out, err := SimplifyFeatureCollection(source, DefaultSimplifyEpsilon)
	if err != nil {
		t.Fatalf("SimplifyFeatureCollection: %v", err)
	}
	if len(out) >= len(source) {
		t.Errorf("simplified payload is %d bytes, not smaller than %d", len(out), len(source))
	}
	if after := len(Polylines(out)); after != before {
		t.Errorf("line count changed from %d to %d; simplification must not drop lines", before, after)
	}
	t.Logf("roadshape %d -> %d bytes (%.0f%% smaller), %d lines preserved",
		len(source), len(out), 100*(1-float64(len(out))/float64(len(source))), before)
}
