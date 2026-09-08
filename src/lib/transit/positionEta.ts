/**
 * When the next bus actually reaches a stop, worked out from where the buses are.
 *
 * RTL publishes an ETA per stop, and for the stop immediately ahead of a bus it
 * is real. Everything downstream of that bus is not: the feed projects one
 * vehicle forward around the whole loop and attributes every stop on the way to
 * it, ignoring the buses already standing between it and those stops. Measured
 * on R2 over fourteen consecutive polls, Flat No. 147 read "23 Minutes" on every
 * one of them while the bus that was going to serve it closed from 2.4 km to
 * 0.5 km, and Centro Mall read "26 Minutes" with a bus parked six metres away.
 * The number never counts down, and the `vehicleCode` beside it flips between
 * whichever buses the engine currently associates with that stretch.
 *
 * So the arrival is derived here instead, from three things the app already
 * holds: the route's geometry, the live positions snapped onto it, and the
 * median stop-to-stop times the backend has measured from weeks of watching.
 * The whole computation is one idea — put every bus and every stop on the same
 * ruler, in minutes rather than metres, and read off the gap.
 *
 * What this deliberately does not model is dwell at a terminal. A bus laying
 * over at the end of its loop is standing still with its next departure fixed by
 * the timetable, not by how fast it can drive; `plan.ts` still has the timetable
 * for that, and a reading from here is only ever offered as one more opinion for
 * it to weigh.
 */
import { type LatLng } from '@/lib/geo';
import { ESTIMATED_BUS_SPEED_KMH } from './buildGraph';
import { alongCandidates, bearingAt, type ShapePath } from './routeShape';
import type { BusTrack } from './busTracks';
import type { LiveEta, Route, StopCode } from './types';

/**
 * How far off the line a fix may sit and still be placed on it.
 *
 * Wider than the tolerance used for stops, which sit a known pavement's width
 * from the road. A bus is wherever its tracker last said, and `snapToRoute` has
 * already declined to correct anything beyond `NO_SNAP_M` — past that it is on a
 * diversion or out of service, and guessing where it is on the loop would be
 * inventing the very fact this module exists to establish.
 */
export const BUS_OFFSET_M = 100;

/**
 * A bus this close past a stop is treated as being at it rather than a lap away.
 *
 * Without it the estimate has a cliff exactly where riders stand: a fix landing
 * a few metres beyond the stop flips from "arriving" to the better part of an
 * hour, on nothing more than snapping error. Kept tight — at 25 m the reading is
 * genuinely ambiguous, and much wider than that would start hiding a bus the
 * rider has really missed behind one they cannot catch.
 */
export const AT_STOP_M = 25;

/**
 * A bus that has not moved for this long is not approaching anything.
 *
 * Out-of-service vehicles keep reporting a position, and one parked near a stop
 * would otherwise claim that stop forever at two minutes out, permanently hiding
 * the bus genuinely on its way. The threshold sits above a terminal layover on
 * these routes and well above traffic: `isStopped` calls forty-five seconds
 * stopped, which is a bus at a red light, and that must not disqualify it.
 */
export const PARKED_AFTER_MS = 12 * 60_000;

/**
 * How far a candidate's road direction may differ from the bus's own heading.
 *
 * Only ever used to choose between two passes down one street, so the question
 * is which way the bus is pointing, not how precisely — anything under a right
 * angle is the same direction of travel.
 */
const MAX_HEADING_DIFF_DEG = 90;

/**
 * How far past its own start a circuit of the stops may close.
 *
 * Not zero, because a route's last stop is routinely the opposite pole of its
 * first — R4 ends at Amin Avenue Opp having started at Amin Avenue, and the
 * geometry passes both at the same point — so the stops legitimately span the
 * entire lap and then a few metres more. Nothing near a real second lap, which
 * is what this is here to reject.
 */
const CIRCUIT_SLACK_M = 30;

/** Bounds on a speed inferred from a route's own measurements, in m/s. */
const MIN_INFERRED_MPS = 1.5;
const MAX_INFERRED_MPS = 16;

/**
 * A route's loop, measured twice: once in metres and once in minutes.
 *
 * Both rulers start at the route's first stop and run forward around the loop,
 * so a position is a single number on each and the conversion between them is
 * interpolation within whichever segment it falls in. Building it is the
 * expensive half of this module — it walks the geometry — and it changes only
 * when the shape or the measurements do, so callers hold onto it.
 */
export interface RouteProgress {
  /** Raw distance along the shape at which the route's first stop sits. */
  originM: number;
  /** Metres from the first stop to each stop, index-aligned to `route.stops`. */
  alongM: number[];
  /** Minutes from the first stop to each stop, index-aligned to `route.stops`. */
  minuteAt: number[];
  /** Metres round the whole loop, back to the first stop. */
  lapM: number;
  /** Minutes round the whole loop, back to the first stop. */
  lapMin: number;
  /** True where `minuteAt` rests on measured or published times rather than an assumed speed. */
  timed: boolean;
  /** Hour of the Malé day the ride times were resolved for. */
  hour: number;
}

/**
 * Places a route's stops on its geometry and puts a clock against them.
 *
 * Returns null when the two cannot be reconciled — a shape that arrives in
 * pieces, a stop nowhere near the line, or stops that span more than one lap of
 * it. There is no partial answer worth having: an ETA read off a ruler that does
 * not fit the route would be confidently wrong, which is precisely the failure
 * being corrected here.
 *
 * `points` carries each stop's coordinates in the route's own stop order, which
 * the caller resolves through the graph.
 */
export function routeProgress(
  route: Route,
  path: ShapePath,
  points: readonly LatLng[],
  maleMinutes: number,
): RouteProgress | null {
  if (route.stops.length < 2 || points.length !== route.stops.length) return null;

  const placement = placeStops(path, points);
  if (!placement) return null;

  const { originM, alongM } = placement;
  const lapM = path.length;
  const hour = hourOf(maleMinutes);

  const mps = inferredSpeedMps(route, alongM, lapM, hour);
  const minuteAt = [0];
  let timed = false;

  for (let i = 1; i < alongM.length; i++) {
    const segment = segmentMinutes(route, i - 1, i, alongM[i] - alongM[i - 1], mps, hour);
    minuteAt.push(minuteAt[i - 1] + segment.minutes);
    timed ||= segment.timed;
  }

  // The closing leg back to the first stop is in no timetable — it is the gap
  // between a route's last stop and its first, which no trip ever rides in one
  // go — so it is always covered at the route's own inferred speed.
  const last = alongM.length - 1;
  const closing = segmentMinutes(route, last, 0, lapM - alongM[last], mps, hour);

  return {
    originM,
    alongM,
    minuteAt,
    lapM,
    lapMin: minuteAt[last] + closing.minutes,
    timed,
    hour,
  };
}

/** Which hour of the Malé day a time falls in. */
export function hourOf(maleMinutes: number): number {
  return Math.floor(((maleMinutes % 1440) + 1440) % 1440 / 60);
}

/**
 * Every stop's place on the loop, in metres from the first of them.
 *
 * `stopOffsets` in `routeShape` answers a neighbouring question — where the
 * stops sit on the *line* — and is free to run a trailing stop onto the next lap
 * if that fits its geometry marginally better, which is harmless when cutting an
 * arc out to draw it and fatal here: a stop a lap out of place makes every bus
 * behind it appear an hour away. This walks the loop instead. Each stop takes
 * the candidate the smallest step forward from the one before, which is the only
 * assignment a bus could actually drive, and the whole sequence must close
 * inside a single circuit.
 *
 * The route's first stop is the one with no predecessor to be measured from, so
 * every candidate for it is tried and the tightest resulting circuit wins.
 */
function placeStops(
  path: ShapePath,
  points: readonly LatLng[],
): { originM: number; alongM: number[] } | null {
  const lapM = path.length;
  const columns = points.map((point) => alongCandidates(path, point));
  if (columns.some((column) => column.length === 0)) return null;

  let best: { originM: number; alongM: number[]; total: number } | null = null;

  for (const start of columns[0]) {
    const alongM = [0];
    let cursor = 0;
    let closed = true;

    for (let i = 1; i < columns.length && closed; i++) {
      let step = Infinity;
      for (const candidate of columns[i]) {
        const forward = wrap(wrap(candidate.along - start.along, lapM) - cursor, lapM);
        if (forward < step) step = forward;
      }
      cursor += step;
      // A circuit that has to lap itself to reach every stop in order is not the
      // route; it is the wrong pass chosen somewhere back down the line.
      if (cursor > lapM + CIRCUIT_SLACK_M) closed = false;
      else alongM.push(cursor);
    }

    if (closed && (!best || cursor < best.total)) {
      best = { originM: start.along, alongM, total: cursor };
    }
  }

  return best ? { originM: best.originM, alongM: best.alongM } : null;
}

/** One stop-to-stop leg, and whether its duration was observed or assumed. */
interface Segment {
  minutes: number;
  timed: boolean;
}

/**
 * How long the leg from stop `from` to stop `to` takes, at hour `hour`.
 *
 * Four sources, in descending order of how much they know. The recorder's
 * median *for this hour* is the best of them: it is what the buses actually did
 * on this leg at this time of day, dwell and congestion included, and the
 * evening peak on a Malé street is a different road from the same street at
 * midnight. Its all-day median comes next, then the timetable — what the buses
 * are meant to do, which is still a real observation of the road. Distance over
 * an inferred speed is the last resort and the only one of the four that knows
 * nothing about this particular leg.
 */
function segmentMinutes(
  route: Route,
  from: number,
  to: number,
  meters: number,
  mps: number,
  hour: number,
): Segment {
  const observed = measuredSegmentMinutes(route, segmentKey(route, from, to), hour);
  if (observed != null) return { minutes: observed, timed: true };

  const scheduled = scheduledSegmentMinutes(route, from, to);
  if (scheduled != null) return { minutes: scheduled, timed: true };

  return { minutes: meters / mps / 60, timed: false };
}

/**
 * What the recorder measured for one leg, preferring the hour asked about.
 *
 * An hour with too few rides behind it is not served at all, so a missing bucket
 * is the ordinary case on a quiet route or a quiet hour and falls straight
 * through to the pooled median rather than being treated as a measurement of
 * zero.
 */
function measuredSegmentMinutes(route: Route, key: string, hour: number): number | null {
  const hourly = route.measured?.segmentMinByHour?.[key]?.[String(hour)];
  if (typeof hourly === 'number' && hourly > 0) return hourly;

  const pooled = route.measured?.segmentMin?.[key];
  return typeof pooled === 'number' && pooled > 0 ? pooled : null;
}

function segmentKey(route: Route, from: number, to: number): string {
  return `${route.stops[from].stopCode}>${route.stops[to].stopCode}`;
}

/**
 * The median published ride between two adjacent stops, or null.
 *
 * `elapsed` rather than `times`, so a leg the timetable gave an impossible
 * duration comes back as the repaired one the planner already rides on. Legs
 * that run backwards are the loop closing on itself, which no single trip does.
 */
function scheduledSegmentMinutes(route: Route, from: number, to: number): number | null {
  if (to <= from) return null;

  const durations: number[] = [];
  for (const trip of route.trips) {
    const a = trip.elapsed[from];
    const b = trip.elapsed[to];
    if (a == null || b == null || b <= a) continue;
    durations.push(b - a);
  }
  if (durations.length === 0) return null;

  durations.sort((x, y) => x - y);
  return durations[durations.length >> 1];
}

/**
 * The route's own average speed, for the legs nothing has measured.
 *
 * Taken from the legs that *are* known rather than from a network-wide constant,
 * because the two ends of this network do not drive alike: R2's bridge crossing
 * runs at three times the speed of its Malé streets, and a single figure for
 * both would be wrong at both. Clamped, so one bad measurement cannot produce a
 * speed no bus reaches.
 */
function inferredSpeedMps(
  route: Route,
  alongM: readonly number[],
  lapM: number,
  hour: number,
): number {
  let meters = 0;
  let minutes = 0;

  for (let i = 1; i < alongM.length; i++) {
    const known =
      measuredSegmentMinutes(route, segmentKey(route, i - 1, i), hour) ??
      scheduledSegmentMinutes(route, i - 1, i);
    if (known == null || known <= 0) continue;
    meters += alongM[i] - alongM[i - 1];
    minutes += known;
  }

  if (meters <= 0 || minutes <= 0 || meters > lapM) return (ESTIMATED_BUS_SPEED_KMH * 1000) / 3600;
  return Math.min(MAX_INFERRED_MPS, Math.max(MIN_INFERRED_MPS, meters / (minutes * 60)));
}

/** Where a bus sits on the loop, and how it was placed there. */
export interface BusPlacement {
  busCode: string;
  /** Metres round the loop from the route's first stop. */
  along: number;
  /** Minute-position on the same loop. */
  atMinute: number;
}

export interface PositionEtas {
  /** The soonest bus at each stop the route serves. */
  etas: Map<StopCode, LiveEta>;
  /**
   * Where each bus was placed this read, keyed by bus code.
   *
   * Fed back on the next read so a bus on a street the loop runs down twice
   * stays on the pass it was already on, rather than jumping between the two
   * carriageways as its heading wobbles.
   */
  placed: Map<string, number>;
}

const NOTHING: PositionEtas = { etas: new Map(), placed: new Map() };

/**
 * Estimated arrivals for every stop on one route, from its live buses.
 *
 * Each bus is put on the loop, converted to a minute-position, and then offered
 * to every stop ahead of it; a stop keeps the soonest bus that reaches it. A bus
 * that has just passed a stop is a lap away from it, which is the whole point —
 * it is exactly the fact RTL's feed loses, and the reason a bus six metres from
 * Centro Mall could be quoted at twenty-six minutes.
 *
 * `now` is epoch milliseconds, for judging which fixes are still worth anything;
 * `nowMinutes` is minutes since Malé midnight, which is the clock the planner
 * works in and what `expectedAt` is stamped against.
 */
export function positionEtas(
  route: Route,
  progress: RouteProgress,
  path: ShapePath,
  tracks: readonly BusTrack[],
  nowMinutes: number,
  now: number,
  previous?: ReadonlyMap<string, number>,
): PositionEtas {
  if (tracks.length === 0) return NOTHING;

  const placed = new Map<string, number>();
  const buses: BusPlacement[] = [];

  for (const track of tracks) {
    // An out-of-service bus reports its parking space indefinitely. Counting one
    // would let it hold the stop it is nearest and hide the bus really coming.
    if (now - track.movedAt >= PARKED_AFTER_MS) continue;

    const along = placeOnLoop(path, progress, track, previous?.get(track.busCode));
    if (along == null) continue;

    placed.set(track.busCode, along);
    buses.push({ busCode: track.busCode, along, atMinute: minuteOf(progress, along) });
  }

  if (buses.length === 0) return { etas: new Map(), placed };

  const etas = new Map<StopCode, LiveEta>();

  for (let i = 0; i < route.stops.length; i++) {
    const stopCode = route.stops[i].stopCode;
    let best: LiveEta | null = null;
    let bestMinutes = Infinity;

    for (const bus of buses) {
      const minutes = minutesUntil(progress, bus, i);
      if (minutes >= bestMinutes) continue;
      bestMinutes = minutes;
      best = {
        minutes: minutes < 1 ? 0 : Math.round(minutes),
        vehicleCode: bus.busCode,
        kind: minutes < 1 ? 'arriving' : 'due',
        expectedAt: nowMinutes + minutes,
        source: 'position',
      };
    }

    if (best) etas.set(stopCode, best);
  }

  return { etas, placed };
}

/**
 * How long until `bus` reaches the stop at `index`, in minutes.
 *
 * Read on the minute ruler rather than the metre one, so the answer already
 * carries what the recorder knows about this stretch of road: R2's bridge
 * crossing is fourteen minutes of its fifty-minute loop across a third of its
 * distance, and dividing metres by an average would put a bus on the bridge
 * minutes out of place.
 */
function minutesUntil(progress: RouteProgress, bus: BusPlacement, index: number): number {
  const target = progress.alongM[index];
  const ahead = wrap(target - bus.along, progress.lapM);

  // Just past the stop: within the noise of snapping, so it is at it rather than
  // a lap short of it.
  if (progress.lapM - ahead <= AT_STOP_M) return 0;

  const minutes = progress.minuteAt[index] - bus.atMinute;
  return minutes < 0 ? minutes + progress.lapMin : minutes;
}

/** The minute-position of a distance round the loop. */
function minuteOf(progress: RouteProgress, along: number): number {
  const { alongM, minuteAt, lapM, lapMin } = progress;

  let i = alongM.length - 1;
  while (i > 0 && alongM[i] > along) i--;

  const isClosing = i === alongM.length - 1;
  const spanM = (isClosing ? lapM : alongM[i + 1]) - alongM[i];
  const spanMin = (isClosing ? lapMin : minuteAt[i + 1]) - minuteAt[i];
  if (spanM <= 0) return minuteAt[i];

  return minuteAt[i] + ((along - alongM[i]) / spanM) * spanMin;
}

/**
 * Puts one bus on the loop, in metres from the route's first stop.
 *
 * The hard case is a street the route runs down twice. Geometry alone cannot
 * separate the two passes — they are the same metres of line — so the bus's own
 * heading decides, and where there is no heading yet the pass it was on last
 * time does.
 *
 * Where neither can, the bus is left unplaced rather than guessed at. The two
 * passes are half a loop apart, so a coin flip between them is not a small
 * error: it is the difference between a bus arriving in three minutes and one
 * that has just left. This costs at most the first poll of a route — a heading
 * appears as soon as the bus has moved twelve metres, and arrives with the very
 * first frame when the backend's stream is feeding it — and in exchange no stop
 * is ever quoted a bus that is really on the other carriageway.
 */
function placeOnLoop(
  path: ShapePath,
  progress: RouteProgress,
  track: BusTrack,
  previous: number | undefined,
): number | null {
  const candidates = alongCandidates(path, track, BUS_OFFSET_M);
  if (candidates.length === 0) return null;

  const loop = (c: { along: number }) => wrap(c.along - progress.originM, progress.lapM);
  if (candidates.length === 1) return loop(candidates[0]);

  if (track.heading !== null) {
    let best: { along: number } | null = null;
    let bestDiff = MAX_HEADING_DIFF_DEG;
    for (const candidate of candidates) {
      const diff = angleBetween(bearingAt(path, candidate.along), track.heading);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = candidate;
      }
    }
    if (best) return loop(best);
  }

  if (previous != null) {
    // The pass it was already on: the one it has advanced onto by the least,
    // since a bus moves a block between polls and not most of a loop.
    let best = candidates[0];
    let bestAdvance = Infinity;
    for (const candidate of candidates) {
      const advance = wrap(loop(candidate) - previous, progress.lapM);
      if (advance < bestAdvance) {
        bestAdvance = advance;
        best = candidate;
      }
    }
    return loop(best);
  }

  return null;
}

/** Smallest angle between two compass bearings, in degrees. */
function angleBetween(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

/** A distance round a loop, brought back into `[0, length)`. */
function wrap(value: number, length: number): number {
  return ((value % length) + length) % length;
}
