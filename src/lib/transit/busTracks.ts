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
 * The box outside which a reported position is a feed fault, not a bus.
 *
 * RTL's tracker occasionally emits (0, 0). One such reading reached the live
 * feed on 2026-09-02 and was published unchallenged, putting a bus in the Gulf
 * of Guinea for a frame — 8,195 km from its route, which is also what it wrote
 * into the recorder's offset column. Snapping cannot help here: past NO_SNAP_M
 * the reading is deliberately left alone, and there is no position to correct
 * anyway, only an absence dressed as one. So it is dropped instead, and the bus
 * simply holds its last known place until the next real fix.
 *
 * Deliberately the whole country rather than the served area — observed
 * operations sit inside 4.16–4.24 N, 73.48–73.55 E, but a genuine route
 * extension must never be silently discarded as implausible. This is a guard
 * against garbage, not a service-area check.
 */
export const SERVICE_BOUNDS = {
  minLat: -1,
  maxLat: 8,
  minLng: 72,
  maxLng: 74.5,
} as const;

/**
 * True when a reading is a real coordinate somewhere it could plausibly be.
 *
 * An exact zero is rejected on either axis, separately from the bounds. The
 * bounds alone cannot catch it: the Maldives straddles the equator, so latitude
 * 0 is genuinely in the country and (0, 73.5) would pass. But a coordinate that
 * is exactly 0.000000 is not a fix — it is an unset field, the same absence
 * that produces (0, 0) — and no real GPS reading lands on it.
 */
export function isPlausibleFix(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 || lng === 0) return false;
  return (
    lat >= SERVICE_BOUNDS.minLat &&
    lat <= SERVICE_BOUNDS.maxLat &&
    lng >= SERVICE_BOUNDS.minLng &&
    lng <= SERVICE_BOUNDS.maxLng
  );
}

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

/**
 * The same inference, already done by the backend for this bus.
 *
 * The server watches every bus continuously, so it knows where one has been
 * even when this tab has only just started looking at the route. A client that
 * re-derives everything from its own first poll must instead wait for the bus
 * to travel before it can draw anything, which is why a trail used to restart
 * from nothing on every route change.
 */
export interface InferredTrack {
  heading: number | null;
  speedMps: number | null;
  movedAt: number;
  updatedAt: number;
  firstSeenAt: number;
  anchor: LatLng;
  anchorAt: number;
  trail: TrailPoint[];
}

/** A live position, optionally carrying the backend's own inference for it. */
export interface TrackedBus extends LiveBus {
  inferred?: InferredTrack;
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
  buses: readonly TrackedBus[],
  now: number,
): Map<string, BusTrack> {
  const next = new Map<string, BusTrack>();

  for (const bus of buses) {
    if (!isPlausibleFix(bus.latitude, bus.longitude)) continue;

    const position: LatLng = { lat: bus.latitude, lng: bus.longitude };
    const prior = previous.get(bus.busCode);

    // The backend has been watching this bus continuously, including well
    // before this tab tuned in, so whenever its inference rides along it is
    // taken as given rather than blended with a local guess. Blending was the
    // subtle bug: the poll fires the instant a route is selected and the stream
    // takes a moment to open, so a track with no history existed by the time
    // the snapshot arrived, and its trail was discarded as "already known".
    // Local inference is what happens when there is no stream, not a second
    // opinion on one.
    if (!prior || bus.inferred) {
      next.set(bus.busCode, adopt(bus, position, now));
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

/**
 * A track built from the backend's own inference, or a blank one when a bus
 * arrives without it.
 *
 * The server's timestamps are rebased onto this clock first: the two machines
 * agree on elapsed time but not on the epoch, and a few minutes of skew either
 * way would otherwise age the whole trail out on arrival or hold it long past
 * its life. The position stays the one this client snapped, so a bus never
 * jumps between the two snappings' answers.
 */
function adopt(bus: TrackedBus, position: LatLng, now: number): BusTrack {
  const base: BusTrack = {
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
  };
  const inferred = bus.inferred;
  if (!inferred) return base;

  const skew = now - inferred.updatedAt;
  return {
    ...base,
    heading: inferred.heading,
    speedMps: inferred.speedMps,
    movedAt: inferred.movedAt + skew,
    firstSeenAt: inferred.firstSeenAt + skew,
    // The anchor is what the heading was measured from, so it has to come
    // across with it; the position on screen stays the one this client snapped.
    anchor: inferred.anchor,
    anchorAt: inferred.anchorAt + skew,
    trail: prune(
      inferred.trail.map((p) => ({ ...p, at: p.at + skew })),
      now,
    ),
  };
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
