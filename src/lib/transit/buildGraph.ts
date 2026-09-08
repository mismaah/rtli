import type { RouteDetailsResponse, RawRoute } from '@/api/rtl';
import { haversineMeters, walkMeters, walkSeconds } from '@/lib/geo';
import { parseClock, serviceDate } from '@/lib/time';
import type { Route, RouteStop, Stop, StopCode, TransitGraph, Trip, WalkTransfer } from './types';

/**
 * Two stops closer than this are treated as walkable interchange.
 * Safe against accidentally bridging water: the closest Villimalé stop is
 * 1560 m from anything else, and Malé to Hulhumalé/airport is 1772 m.
 */
export const MAX_TRANSFER_WALK_M = 600;

/**
 * R10, R11, R12 and R15 return an empty `timings` array on every stop — they are
 * frequency-based city minibuses with no published timetable. Times for these are
 * synthesised and always surfaced to the user as estimates.
 */
export const DEFAULT_HEADWAY_MIN = 15;
/** Assumed average bus speed for synthesised frequency-route times. */
export const ESTIMATED_BUS_SPEED_KMH = 18;
/** Roads bend around blocks, so a ride is longer than the crow flies. */
export const ROAD_DETOUR_FACTOR = 1.2;

/**
 * Above this a leg was not driven by a bus, and the timetable rows either side
 * of it do not belong to the same trip.
 *
 * The Sinamalé bridge is the fastest road in the country and RTL's own honest
 * crossings sit around 25 km/h door to door; 45 leaves generous room above that
 * while still catching the misjoins, which imply 60 to 200 km/h.
 */
export const MAX_PLAUSIBLE_BUS_KMH = 45;
/**
 * Times are published to the minute, so a leg is allowed a whole minute of
 * rounding before it counts as impossible. Villimalé times several 80 m hops at
 * zero minutes; without this every one of them reads as infinitely fast.
 */
const MINUTE_ROUNDING_GRACE = 1;
/**
 * How much longer than the distance allows a realigned leg may come out.
 *
 * Shifting by a trip adds a whole headway, so on a half-hourly route it turns a
 * 2-minute leg into 32 — no more true than the 2 was. Measured against the same
 * distance-and-speed estimate `repairLegs` falls back on: the realignments that
 * are right land at or under it (R8's bridge at 0.65 of it, R7's at 0.79, R2's
 * at 0.95), and the ones that have merely absorbed a headway land far above
 * (R9's airport leg at 1.9, R3's at 2.9). Rejecting one leaves the leg to
 * `repairLegs`, which cannot overshoot by a headway.
 */
const MAX_REALIGNED_OVERSHOOT = 1.5;
/**
 * Trips to look either side of when a stop's numbering is out of step. Every
 * misalignment observed across the 15 Greater Malé routes is a single trip.
 */
const MAX_ALIGNMENT_SHIFT = 1;

const DEFAULT_ROUTE_COLOR = '#2563eb';

function clean(value: string | null | undefined): string {
  // Several names carry trailing tabs, e.g. "Villimale Hospital\t", "Carnival ".
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function toCoord(value: string | number | null | undefined): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pivots RTL's per-stop `timings` into whole trips.
 *
 * `timings[].order` is very nearly a trip number shared across every stop — on
 * R1 grouping by it reconstructs the whole timetable, trip 28 running stop 1 @
 * 12:30 through stop 18 @ 13:40. On six of the fifteen routes, though, one stop
 * is numbered a trip out of step with its neighbours, and reading the rows off
 * at face value joins a bus leaving Hulhumalé to the one that reached Malé two
 * minutes later. `alignTripNumbering` puts the numbering back in step; whatever
 * survives that is left to `repairLegs`, which cannot invent a departure time
 * but can refuse to believe a duration.
 */
function buildTrips(
  raw: RawRoute,
  routeStops: RouteStop[],
  stops: Map<StopCode, Stop>,
): Trip[] {
  const byStop = pivotTimings(raw, routeStops);
  const offsets = alignTripNumbering(byStop, routeStops, stops);

  // Offsets are relative to the first stop, so a trip is numbered as it is there.
  const numbers = new Set<number>();
  byStop.forEach((timings, index) => {
    for (const order of timings.keys()) numbers.add(order - offsets[index]);
  });

  const trips: Trip[] = [];
  for (const tripOrder of numbers) {
    const times = byStop.map((timings, index) => timings.get(tripOrder + offsets[index]) ?? null);
    // A trip is only usable if at least two stops have times to travel between.
    if (times.filter((t) => t != null).length < 2) continue;
    const unwrapped = unwrapMidnight(times);
    trips.push({ tripOrder, ...repairLegs(unwrapped, routeStops, stops) });
  }
  trips.sort((a, b) => firstTime(a) - firstTime(b));
  return trips;
}

/**
 * `timings[].order` to minutes, per position along the route.
 *
 * Keyed by `order` rather than laid out as rows, because which trip a row
 * belongs to is not settled until the numbering has been aligned. Positions are
 * matched through `RouteStop.order`: `busRouteStopList` arrives in route order
 * in practice, but a stop dropped for missing coordinates would otherwise slide
 * every timing after it onto the wrong stop.
 */
function pivotTimings(raw: RawRoute, routeStops: RouteStop[]): Map<number, number>[] {
  const byStop = routeStops.map(() => new Map<number, number>());
  const positionOf = new Map<number, number>();
  routeStops.forEach((rs, index) => positionOf.set(rs.order, index));

  for (const rawStop of raw.busRouteStopList ?? []) {
    const position = positionOf.get(rawStop.order);
    if (position == null) continue;
    for (const timing of rawStop.timings ?? []) {
      const minutes = parseClock(timing.timing);
      if (minutes == null) continue;
      byStop[position].set(timing.order, minutes);
    }
  }
  return byStop;
}

/**
 * How far each stop's trip numbering has drifted from the first stop's.
 *
 * Walks the route once, carrying the offset forward. A leg is left alone unless
 * reading it straight makes the bus impossibly fast — R8 crossing the 6.5 km
 * bridge from MACL Flat to Senahiya in two minutes — and then the next trip
 * either side is tried, taking the first that turns the leg into a drive a bus
 * could have made in about the time the distance asks for. The median across the
 * day decides, so the handful of trips that cross midnight or run short cannot
 * swing it.
 *
 * Only an impossible leg is grounds for shifting anything. A leg that merely
 * looks slow is left as published: the 15 minutes RTL gives R3 between the
 * airport terminal and the MACL office 181 m away is a layover, not an error.
 */
function alignTripNumbering(
  byStop: Map<number, number>[],
  routeStops: RouteStop[],
  stops: Map<StopCode, Stop>,
): number[] {
  const offsets = [0];

  for (let i = 0; i + 1 < routeStops.length; i++) {
    const here = offsets[i];
    const meters = spanMeters(routeStops, stops, i, i + 1);
    const direct = medianLegMinutes(byStop[i], byStop[i + 1], here, here);
    let chosen = here;

    if (direct != null && impossiblyFast(meters, direct)) {
      for (const candidate of shiftCandidates(here)) {
        const minutes = medianLegMinutes(byStop[i], byStop[i + 1], here, candidate);
        if (minutes == null || minutes <= 0) continue;
        if (impossiblyFast(meters, minutes)) continue;
        if (minutes > spanMinutes(routeStops, stops, i, i + 1) * MAX_REALIGNED_OVERSHOOT) continue;
        chosen = candidate;
        break;
      }
    }
    offsets.push(chosen);
  }
  return offsets;
}

/** Offsets to try for the next stop, nearest trip first, either side. */
function shiftCandidates(from: number): number[] {
  const out: number[] = [];
  for (let d = 1; d <= MAX_ALIGNMENT_SHIFT; d++) out.push(from + d, from - d);
  return out;
}

/**
 * Typical minutes between two stops, over every trip they share.
 *
 * The median rather than the mean: a trip that runs past midnight shows up here
 * as roughly minus a day, and one outlier that large would drag any average
 * clean out of the plausible range.
 */
function medianLegMinutes(
  from: Map<number, number>,
  to: Map<number, number>,
  fromOffset: number,
  toOffset: number,
): number | null {
  const diffs: number[] = [];
  for (const [order, minutes] of from) {
    const next = to.get(order - fromOffset + toOffset);
    if (next != null) diffs.push(next - minutes);
  }
  if (diffs.length === 0) return null;
  diffs.sort((a, b) => a - b);
  return diffs[diffs.length >> 1];
}

/**
 * Ride durations along one trip, with impossible legs lengthened.
 *
 * Alignment fixes the legs whose time went to a neighbouring stop. What is left
 * is time RTL never published at all: R7 gives its return over the bridge two
 * minutes, and no shift recovers the missing twenty because they are not in the
 * feed. Those legs are stretched to what the distance allows at
 * `ESTIMATED_BUS_SPEED_KMH` and counted in `repairsBefore`, so the planner can
 * tell the rider the number is an estimate.
 *
 * Published times are never rewritten. Which stop drifted is unknowable, so
 * moving a departure risks sending a rider for a bus that has already gone —
 * where overstating a ride only ever gets them there early. That also keeps
 * every stop's departure board exactly as RTL prints it.
 */
function repairLegs(
  times: (number | null)[],
  routeStops: RouteStop[],
  stops: Map<StopCode, Stop>,
): Pick<Trip, 'times' | 'elapsed' | 'repairsBefore'> {
  const elapsed = new Array<number | null>(times.length).fill(null);
  const repairsBefore = new Array<number>(times.length).fill(0);
  let cumulative = 0;
  let repairs = 0;
  let previous = -1;

  for (let i = 0; i < times.length; i++) {
    const at = times[i];
    if (at == null) {
      repairsBefore[i] = repairs;
      continue;
    }
    if (previous >= 0) {
      const published = at - times[previous]!;
      const meters = spanMeters(routeStops, stops, previous, i);
      if (impossiblyFast(meters, published)) {
        cumulative += Math.max(published, spanMinutes(routeStops, stops, previous, i));
        repairs++;
      } else {
        cumulative += published;
      }
    }
    repairsBefore[i] = repairs;
    elapsed[i] = cumulative;
    previous = i;
  }

  return { times, elapsed, repairsBefore };
}

/** Speed a leg implies, forgiving one minute of published rounding. */
function impliedKmh(meters: number, minutes: number): number {
  return meters / 1000 / ((minutes + MINUTE_ROUNDING_GRACE) / 60);
}

/** True when no bus covered this ground in this time. Backwards counts. */
function impossiblyFast(meters: number, minutes: number): boolean {
  return minutes < 0 || impliedKmh(meters, minutes) > MAX_PLAUSIBLE_BUS_KMH;
}

/**
 * Late trips cross midnight — "23:40" then "00:10". Roll the tail past 1440 so
 * arithmetic in the planner stays monotonic.
 */
function unwrapMidnight(times: (number | null)[]): (number | null)[] {
  let offset = 0;
  let prev: number | null = null;
  return times.map((t) => {
    if (t == null) return null;
    if (prev != null && t + offset < prev) offset += 24 * 60;
    const value = t + offset;
    prev = value;
    return value;
  });
}

function firstTime(trip: Trip): number {
  for (const t of trip.times) if (t != null) return t;
  return Number.POSITIVE_INFINITY;
}

export function buildGraph(
  response: RouteDetailsResponse,
  now: Date = new Date(),
): TransitGraph {
  const stops = new Map<StopCode, Stop>();
  const routes = new Map<string, Route>();
  const routesAtStop = new Map<StopCode, string[]>();

  // `atollRouteResponse` covers other atolls and is deliberately ignored.
  for (const raw of response.routeResponse ?? []) {
    const rawStops = raw.busRouteStopList ?? [];
    if (rawStops.length < 2) continue;

    const routeStops: RouteStop[] = [];

    for (const rawStop of rawStops) {
      const lat = toCoord(rawStop.latitude);
      const lng = toCoord(rawStop.longitude);
      const code = clean(rawStop.code);
      if (lat == null || lng == null || !code) continue;

      if (!stops.has(code)) {
        stops.set(code, {
          code,
          name: clean(rawStop.name) || `Stop ${code}`,
          dvName: clean(rawStop.dvname),
          lat,
          lng,
          routes: [],
        });
      }
      routeStops.push({ stopCode: code, order: rawStop.order });
    }

    if (routeStops.length < 2) continue;
    routeStops.sort((a, b) => a.order - b.order);

    const trips = buildTrips(raw, routeStops, stops);
    const routeCode = clean(raw.code);

    const route: Route = {
      code: routeCode,
      routeNumber: clean(raw.routeNumber) || routeCode,
      name: clean(raw.name),
      dvName: clean(raw.dvname),
      color: clean(raw.color) || DEFAULT_ROUTE_COLOR,
      fare: raw.fare ?? 0,
      isMiniBus: raw.isMiniBusRoute === 1,
      stops: routeStops,
      trips,
      headwayMin: trips.length === 0 ? DEFAULT_HEADWAY_MIN : undefined,
    };
    routes.set(routeCode, route);

    for (const rs of routeStops) {
      const list = routesAtStop.get(rs.stopCode) ?? [];
      if (!list.includes(routeCode)) list.push(routeCode);
      routesAtStop.set(rs.stopCode, list);
      const stop = stops.get(rs.stopCode);
      if (stop && !stop.routes.includes(routeCode)) stop.routes.push(routeCode);
    }
  }

  return {
    stops,
    routes,
    routesAtStop,
    walkTransfers: buildWalkTransfers(stops),
    serviceDate: serviceDate(now),
  };
}

/** All stop pairs within `MAX_TRANSFER_WALK_M`. ~101 stops, so brute force is fine. */
function buildWalkTransfers(stops: Map<StopCode, Stop>): Map<StopCode, WalkTransfer[]> {
  const list = [...stops.values()];
  const transfers = new Map<StopCode, WalkTransfer[]>();
  for (const stop of list) transfers.set(stop.code, []);

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (haversineMeters(a, b) > MAX_TRANSFER_WALK_M) continue;
      const meters = walkMeters(a, b);
      const seconds = walkSeconds(meters);
      transfers.get(a.code)!.push({ to: b.code, meters, seconds });
      transfers.get(b.code)!.push({ to: a.code, meters, seconds });
    }
  }

  for (const entries of transfers.values()) entries.sort((x, y) => x.meters - y.meters);
  return transfers;
}

/**
 * Ride time between two positions on a frequency route.
 *
 * Measured where the recorder has watched the stretch enough times to have a
 * median for it, and synthesised from straight-line distance at
 * `ESTIMATED_BUS_SPEED_KMH` where it has not.
 *
 * The measurement is worth reaching for because a single average speed cannot
 * describe this network: a stretch through Malé's grid and a stretch of the
 * Hulhumalé link road are the same distance apart on the map and nothing like
 * the same ride. The estimate is not merely imprecise there, it is wrong in
 * opposite directions on the two halves of the same route.
 *
 * Mixed per stop pair rather than all-or-nothing. A route usually has medians
 * for most of its pairs and none for the one an unlucky week never observed, and
 * falling back to the assumed speed for that pair alone is far better than
 * discarding every real measurement beside it.
 */
export function estimateRideMinutes(
  route: Route,
  stops: Map<StopCode, Stop>,
  fromIndex: number,
  toIndex: number,
): number {
  const whole = measuredRideMinutes(route, fromIndex, toIndex);
  if (whole != null) return whole;
  return spanMinutes(route.stops, stops, fromIndex, toIndex, route.measured?.segmentMin);
}

/**
 * The measured ride between two positions around the loop, or null.
 *
 * The recorder times this end to end, from one bus's own arrival at each stop,
 * so it is preferred over both the timetable and any sum of the legs between.
 * Summing legs turns out to cost little on its own — measured across 798 stop
 * pairs it lands within 1.4% of the ride measured whole — but it inherits the
 * timetable's habit of misattributing time between neighbouring legs, and it
 * cannot answer at all for a pair whose every leg was not separately observed.
 *
 * Null wherever the pair was never watched enough times to have a median, which
 * is the ordinary case on a quiet route and leaves the caller with whatever it
 * had before.
 */
export function measuredRideMinutes(
  route: Route,
  fromIndex: number,
  toIndex: number,
): number | null {
  const rides = route.measured?.rideMin;
  if (!rides || toIndex <= fromIndex) return null;

  const from = positionStop(route.stops, fromIndex).stopCode;
  const to = positionStop(route.stops, toIndex).stopCode;
  // A ride that wraps far enough to reach its own boarding stop again is a lap,
  // and the key would name the same stop at both ends.
  if (from === to) return null;

  const minutes = rides[`${from}>${to}`];
  return typeof minutes === 'number' && minutes > 0 ? minutes : null;
}

/**
 * The stop at a position around the route loop.
 *
 * Every Greater Malé `roadshape` comes back as a closed line — start and end
 * within a metre of each other — so a position past the last stop is the bus
 * closing the loop back towards where the route starts, not an index error.
 * Indices in the planner are therefore positions around that loop rather than
 * offsets into the array, and this is where they are brought back to a stop.
 */
export function stopAtPosition(route: Route, position: number): RouteStop {
  return positionStop(route.stops, position);
}

function positionStop(routeStops: RouteStop[], position: number): RouteStop {
  return routeStops[position % routeStops.length];
}

/**
 * Distance ridden along a route between two positions around the loop, in metres.
 *
 * Straight lines between consecutive stops inflated by ROAD_DETOUR_FACTOR — the
 * `roadshape` geometry is fetched per route on demand and is not part of the
 * graph, so the planner cannot measure the real carriageway.
 */
export function rideMeters(
  route: Route,
  stops: Map<StopCode, Stop>,
  fromIndex: number,
  toIndex: number,
): number {
  return spanMeters(route.stops, stops, fromIndex, toIndex);
}

/**
 * `rideMeters` and `estimateRideMinutes` over a bare stop list.
 *
 * Trips are pivoted before the `Route` they belong to exists, and the timetable
 * cannot be judged without knowing how far apart its stops are, so both measures
 * are reachable from the stop list alone.
 */
function spanMeters(
  routeStops: RouteStop[],
  stops: Map<StopCode, Stop>,
  fromIndex: number,
  toIndex: number,
): number {
  let meters = 0;
  for (let i = fromIndex; i < toIndex; i++) {
    const a = stops.get(positionStop(routeStops, i).stopCode);
    const b = stops.get(positionStop(routeStops, i + 1).stopCode);
    if (a && b) meters += haversineMeters(a, b) * ROAD_DETOUR_FACTOR;
  }
  return meters;
}

/**
 * Ride time across a span, pair by pair.
 *
 * `measured` is the route's median seconds-turned-minutes per adjacent stop
 * pair, where the recorder has any. A pair it covers contributes its observed
 * time — which already includes the dwell at the stop it ends on, because it was
 * timed between two arrivals — and a pair it does not falls back to distance at
 * the assumed speed plus a nominal dwell.
 */
function spanMinutes(
  routeStops: RouteStop[],
  stops: Map<StopCode, Stop>,
  fromIndex: number,
  toIndex: number,
  measured?: Record<string, number>,
): number {
  let minutes = 0;
  for (let i = fromIndex; i < toIndex; i++) {
    const from = positionStop(routeStops, i);
    const to = positionStop(routeStops, i + 1);
    const observed = measured?.[`${from.stopCode}>${to.stopCode}`];
    if (observed != null) {
      minutes += observed;
      continue;
    }
    const a = stops.get(from.stopCode);
    const b = stops.get(to.stopCode);
    const meters = a && b ? haversineMeters(a, b) * ROAD_DETOUR_FACTOR : 0;
    // Distance at the assumed speed, plus dwell at the stop this hop ends on.
    minutes += (meters / 1000 / ESTIMATED_BUS_SPEED_KMH) * 60 + 0.4;
  }
  return Math.max(1, Math.round(minutes));
}
