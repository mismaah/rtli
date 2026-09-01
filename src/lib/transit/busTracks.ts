import { bearingDegrees, haversineMeters, type LatLng } from '@/lib/geo';
import type { LiveBus } from '@/api/rtl';

/**
 * RTL's `livecoordinates` feed gives a position and nothing else — no heading,
 * no speed, no timestamp. Which way a bus is facing therefore has to be inferred
 * by remembering where it was on earlier polls, which is what this does.
 *
 * The awkward part is that a parked bus still jitters by a few metres every poll,
 * and a bearing taken off that jitter spins the arrow at random. So a heading is
 * only recomputed once the bus has travelled clear of that noise, measured from
 * an *anchor* — the last position that established the heading — rather than from
 * the previous poll. The displayed position still follows every reading, so the
 * dot stays live while the arrow stays steady.
 */

/** Movement below this is GPS noise, not travel. Roughly 3x observed jitter. */
export const MIN_MOVE_M = 12;

/**
 * A bus that vanished from the feed for this long may have rounded any number of
 * corners; the heading across such a gap would be a straight line through
 * buildings, so it is dropped rather than guessed.
 */
export const MAX_GAP_MS = 90_000;

/** 108 km/h. Faster than that is a feed glitch, not a bus on Malé's streets. */
export const MAX_SPEED_MPS = 30;

/**
 * How long a heading survives without being reconfirmed by movement.
 *
 * A bus that drops out of the feed for a moment and comes back is almost
 * certainly still on the same trip pointing the same way, so its arrow is kept
 * rather than blanked. One that has been gone for ten minutes is not: it may
 * have turned at a terminal, finished its run, or been swapped for another
 * vehicle, and drawing last-seen direction on it asserts something nobody knows.
 *
 * This is deliberately much longer than `MAX_GAP_MS`, which governs whether a
 * *new* bearing may be computed. Keeping an old heading needs weaker evidence
 * than claiming a fresh one. A bus that is present but parked keeps its heading
 * indefinitely — that path never reaches here.
 */
export const HEADING_EXPIRY_MS = 10 * 60_000;

/** No movement for this long reads as waiting at a stop or parked up. */
export const STOPPED_AFTER_MS = 45_000;

/**
 * How much of a bus's recent path is kept behind it. Twelve confirmed moves is
 * a couple of minutes of city driving — enough for the trail to show which way
 * the bus came without drawing its entire shift across the map.
 */
export const TRAIL_MAX_POINTS = 12;
/** A trail older than this is history, not movement, and stops being drawn. */
export const TRAIL_MAX_AGE_MS = 4 * 60_000;

export interface TrailPoint extends LatLng {
  /** Epoch ms the bus was seen here. */
  at: number;
}

export interface BusTrack extends LatLng {
  busCode: string;
  plateNumber: string;
  /** Compass degrees clockwise from north; null until the bus has moved far enough to tell. */
  heading: number | null;
  /** Metres per second over the last leg of travel; null alongside a null heading. */
  speedMps: number | null;
  /** Epoch ms when this bus was last seen to have genuinely moved. */
  movedAt: number;
  /** Epoch ms of the poll this position came from. */
  updatedAt: number;
  /** Epoch ms this bus first appeared in the feed this session. */
  firstSeenAt: number;
  /** Position the current heading was measured from. */
  anchor: LatLng;
  anchorAt: number;
  /**
   * Where the bus has been, oldest first, excluding where it is now. Only
   * positions it demonstrably reached are kept — the same movement threshold
   * that gates the heading — so a parked bus leaves no smear of jitter behind it.
   */
  trail: TrailPoint[];
}

/**
 * Folds one poll of live positions into the running tracks.
 *
 * Pure and time-injected so the inference is testable without waiting on a real
 * ten-second poll. Buses missing from `buses` are dropped: RTL stops reporting a
 * bus once it goes out of service.
 */
export function updateTracks(
  previous: ReadonlyMap<string, BusTrack>,
  buses: readonly LiveBus[],
  now: number,
): Map<string, BusTrack> {
  const next = new Map<string, BusTrack>();

  for (const bus of buses) {
    if (!Number.isFinite(bus.latitude) || !Number.isFinite(bus.longitude)) continue;

    const position: LatLng = { lat: bus.latitude, lng: bus.longitude };
    const prior = previous.get(bus.busCode);

    if (!prior) {
      next.set(bus.busCode, {
        ...position,
        busCode: bus.busCode,
        plateNumber: bus.plateNumber,
        heading: null,
        speedMps: null,
        movedAt: now,
        updatedAt: now,
        firstSeenAt: now,
        anchor: position,
        anchorAt: now,
        trail: [],
      });
      continue;
    }

    const moved = haversineMeters(prior.anchor, position);
    const elapsedMs = now - prior.anchorAt;

    // Still within the jitter radius: the bus has not demonstrably gone anywhere,
    // so the last known heading stands and the anchor is left where it is.
    if (moved < MIN_MOVE_M) {
      next.set(bus.busCode, {
        ...prior,
        ...position,
        plateNumber: bus.plateNumber || prior.plateNumber,
        updatedAt: now,
        trail: prune(prior.trail, now),
      });
      continue;
    }

    const speedMps = elapsedMs > 0 ? (moved / elapsedMs) * 1000 : null;
    const trustworthy = speedMps !== null && elapsedMs <= MAX_GAP_MS && speedMps <= MAX_SPEED_MPS;

    next.set(bus.busCode, {
      ...position,
      busCode: bus.busCode,
      plateNumber: bus.plateNumber || prior.plateNumber,
      // A stale or impossible jump re-anchors without claiming to know a
      // heading. The one already on screen is kept — but only while it is still
      // evidence of anything; across a long silence it is dropped rather than
      // presented as current.
      heading: trustworthy
        ? bearingDegrees(prior.anchor, position)
        : elapsedMs <= HEADING_EXPIRY_MS
          ? prior.heading
          : null,
      speedMps: trustworthy ? speedMps : null,
      movedAt: now,
      updatedAt: now,
      firstSeenAt: prior.firstSeenAt,
      anchor: position,
      anchorAt: now,
      // A jump the feed cannot account for is not a path the bus drove, so the
      // trail restarts from where it reappeared rather than drawing the leap.
      trail: trustworthy
        ? prune([...prior.trail, { ...prior.anchor, at: prior.anchorAt }], now)
        : [],
    });
  }

  return next;
}

/** Drops trail points that have aged out, then the oldest beyond the cap. */
function prune(trail: TrailPoint[], now: number): TrailPoint[] {
  const fresh = trail.filter((p) => now - p.at <= TRAIL_MAX_AGE_MS);
  return fresh.length > TRAIL_MAX_POINTS ? fresh.slice(fresh.length - TRAIL_MAX_POINTS) : fresh;
}

/** True while the bus has not cleared the jitter radius for a while. */
export function isStopped(track: BusTrack, now: number): boolean {
  return now - track.movedAt >= STOPPED_AFTER_MS;
}

export function formatSpeed(speedMps: number): string {
  return `${Math.round(speedMps * 3.6)} km/h`;
}
