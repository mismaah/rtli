package track

import (
	"math"

	"github.com/mismaah/rtl-improved/server/internal/geo"
	"github.com/mismaah/rtl-improved/server/internal/rtl"
)

// Inference thresholds. These mirror src/lib/transit/busTracks.ts exactly; see
// the commentary there for why each is the value it is.
const (
	// MinMoveM is movement below which a reading is GPS noise, not travel.
	// Roughly 3x observed jitter.
	MinMoveM = 12.0
	// MaxGapMs: a bus that vanished from the feed for this long may have
	// rounded any number of corners, so a heading across the gap would be a
	// straight line through buildings.
	MaxGapMs = 90_000
	// MaxSpeedMps is 108 km/h — faster is a feed glitch, not a bus in Malé.
	MaxSpeedMps = 30.0
	// HeadingExpiryMs is how long a heading survives without being reconfirmed
	// by movement. A bus gone for a moment is almost certainly still on the same
	// trip pointing the same way; one gone for ten minutes may have turned at a
	// terminal, finished its run, or been swapped out, and drawing its
	// last-seen direction asserts something nobody knows. Deliberately far
	// longer than MaxGapMs: keeping an old heading needs weaker evidence than
	// claiming a fresh one. A bus that is present but parked keeps its heading
	// indefinitely — that path never reaches here.
	HeadingExpiryMs = 10 * 60_000
	// StoppedAfterMs of no movement reads as waiting at a stop or parked up.
	StoppedAfterMs = 45_000
	// TrailMaxPoints is a couple of minutes of city driving.
	TrailMaxPoints = 12
	// TrailMaxAgeMs past which a trail is history, not movement.
	TrailMaxAgeMs = 4 * 60_000
)

// TrailPoint is somewhere a bus was confirmed to have been.
type TrailPoint struct {
	geo.LatLng
	At int64 `json:"at"`
}

// Track is everything known about one bus. Heading and SpeedMps are inferred,
// never reported, and are nil until the bus has moved far enough to tell.
type Track struct {
	geo.LatLng
	BusCode     string       `json:"busCode"`
	PlateNumber string       `json:"plateNumber"`
	Heading     *float64     `json:"heading"`
	SpeedMps    *float64     `json:"speedMps"`
	MovedAt     int64        `json:"movedAt"`
	UpdatedAt   int64        `json:"updatedAt"`
	FirstSeenAt int64        `json:"firstSeenAt"`
	Anchor      geo.LatLng   `json:"anchor"`
	AnchorAt    int64        `json:"anchorAt"`
	Trail       []TrailPoint `json:"trail"`
	// OffsetM is how far this bus was from its route before correction. Not on
	// the client's type; exposed so a persistently-off bus is diagnosable.
	OffsetM float64 `json:"offsetM"`
}

// Update folds one poll of live positions into the running tracks.
//
// Pure and time-injected, like its TS counterpart. Buses absent from buses are
// dropped: RTL stops reporting a vehicle once it goes out of service.
func Update(previous map[string]*Track, buses []rtl.Bus, now int64) map[string]*Track {
	next := make(map[string]*Track, len(buses))

	for _, bus := range buses {
		if !isFinite(bus.Latitude) || !isFinite(bus.Longitude) {
			continue
		}
		position := geo.LatLng{Lat: bus.Latitude, Lng: bus.Longitude}
		prior, seen := previous[bus.BusCode]

		if !seen {
			next[bus.BusCode] = &Track{
				LatLng:      position,
				BusCode:     bus.BusCode,
				PlateNumber: bus.PlateNumber,
				MovedAt:     now,
				UpdatedAt:   now,
				FirstSeenAt: now,
				Anchor:      position,
				AnchorAt:    now,
				Trail:       []TrailPoint{},
			}
			continue
		}

		moved := geo.HaversineMeters(prior.Anchor, position)
		elapsedMs := now - prior.AnchorAt

		// Inside the jitter radius the bus has not demonstrably gone anywhere,
		// so the last known heading stands and the anchor stays put.
		if moved < MinMoveM {
			updated := *prior
			updated.LatLng = position
			updated.PlateNumber = orPrior(bus.PlateNumber, prior.PlateNumber)
			updated.UpdatedAt = now
			updated.Trail = prune(prior.Trail, now)
			next[bus.BusCode] = &updated
			continue
		}

		var speed *float64
		if elapsedMs > 0 {
			v := moved / float64(elapsedMs) * 1000
			speed = &v
		}
		trustworthy := speed != nil && elapsedMs <= MaxGapMs && *speed <= MaxSpeedMps

		updated := &Track{
			LatLng:      position,
			BusCode:     bus.BusCode,
			PlateNumber: orPrior(bus.PlateNumber, prior.PlateNumber),
			// A stale or impossible jump re-anchors without claiming a heading.
			// The one already on screen is kept — but only while it is still
			// evidence of anything; across a long silence it is dropped rather
			// than presented as current.
			Heading:     expiredHeading(prior.Heading, elapsedMs),
			MovedAt:     now,
			UpdatedAt:   now,
			FirstSeenAt: prior.FirstSeenAt,
			Anchor:      position,
			AnchorAt:    now,
			// A jump the feed cannot account for is not a path the bus drove,
			// so the trail restarts rather than drawing the leap.
			Trail: []TrailPoint{},
		}
		if trustworthy {
			heading := geo.BearingDegrees(prior.Anchor, position)
			updated.Heading = &heading
			updated.SpeedMps = speed
			updated.Trail = prune(
				append(append([]TrailPoint{}, prior.Trail...),
					TrailPoint{LatLng: prior.Anchor, At: prior.AnchorAt}),
				now)
		}
		next[bus.BusCode] = updated
	}

	return next
}

// expiredHeading keeps a heading only while the silence since it was last
// confirmed is short enough for it to still mean something.
func expiredHeading(heading *float64, elapsedMs int64) *float64 {
	if elapsedMs > HeadingExpiryMs {
		return nil
	}
	return heading
}

// prune drops trail points that have aged out, then the oldest beyond the cap.
func prune(trail []TrailPoint, now int64) []TrailPoint {
	fresh := make([]TrailPoint, 0, len(trail))
	for _, p := range trail {
		if now-p.At <= TrailMaxAgeMs {
			fresh = append(fresh, p)
		}
	}
	if len(fresh) > TrailMaxPoints {
		fresh = fresh[len(fresh)-TrailMaxPoints:]
	}
	return fresh
}

// IsStopped reports whether the bus has not cleared the jitter radius for a while.
func IsStopped(t *Track, now int64) bool {
	return now-t.MovedAt >= StoppedAfterMs
}

func orPrior(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

// isFinite mirrors Number.isFinite: NaN and both infinities are rejected, so a
// garbled coordinate is skipped rather than poisoning a bus's track.
func isFinite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}
