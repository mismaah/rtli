import { walkMeters, walkSeconds } from '@/lib/geo';
import { estimateRideMinutes, rideMeters, stopAtPosition } from './buildGraph';
import type {
  BusLeg,
  Itinerary,
  Leg,
  LiveEta,
  LiveEtaIndex,
  Place,
  Route,
  Stop,
  StopCode,
  TransitGraph,
  Trip,
  WalkLeg,
} from './types';

export interface PlanOptions {
  /** Minutes since Malé midnight. */
  departAt: number;
  /** How much walking the rider is willing to trade for time or money. */
  walkPreference?: WalkPreference;
  /** Furthest the rider will walk in one go to reach or leave a stop. */
  maxWalkM?: number;
  /** Ceiling on walking across the whole trip, transfers included. */
  maxTotalWalkM?: number;
  /** Rounds of boarding; N rounds allows N-1 transfers. */
  maxRounds?: number;
  maxResults?: number;
  /**
   * Live arrivals, keyed route then stop. Where a reported bus can still be
   * caught it is planned on in place of the timetable — see `earliestTrip`.
   */
  liveEtas?: LiveEtaIndex;
}

const DEFAULTS = {
  walkPreference: 'balanced' as WalkPreference,
  maxWalkM: 800,
  maxTotalWalkM: 1600,
  maxRounds: 3,
  maxResults: 4,
};

/** Buffer so a transfer isn't planned with zero seconds to spare. */
const MIN_TRANSFER_MIN = 2;

/**
 * How far past its last stop a route will still carry a rider.
 *
 * Every route's `roadshape` is a closed loop, so a bus reaching the last stop
 * on its list still has to drive back to the first one to begin its next trip —
 * 190 m on R2, nearly 800 m on R5/R6/R9 — and it calls at that stop when it
 * gets there. One position is the whole of that closing stretch; beyond it the
 * bus is running its next trip, which the timetable publishes separately and
 * which this must not pretend to plan.
 *
 * Exported for tests: it is the bound on how far a ride may run past the end of
 * a route's stop list, so it is worth asserting against directly.
 */
export const MAX_WRAP_STOPS = 1;

/** Time to close the loop's last stretch is unpublished, so allow for a pause. */
const TERMINAL_DWELL_MIN = 1;

/**
 * Below this the closing stretch covers no ground and is not a ride.
 *
 * On R1, R3, R4, R10 and R15 the list ends at the `OPP` twin of the stop it
 * began at — Maafannu Bus Terminal OPP back to Maafannu Bus Terminal — sharing
 * one set of coordinates. Riding that is a leg that goes nowhere; the rider is
 * already there, and the walk transfers say so.
 */
const MIN_WRAP_RIDE_M = 30;

/**
 * Ranking weights, all in minutes so they add up into one comparable number.
 *
 * Earliest arrival alone produces itineraries that shave a few minutes by making
 * the rider walk an extra kilometre, or by charging them for a second bus to
 * save three minutes, so arrival time is traded off against the rest of what a
 * journey actually costs: distance on foot, transfers, and fares.
 */
export type WalkPreference = 'less' | 'balanced' | 'more';

/**
 * Minutes charged per kilometre walked, on top of the ~12 min/km it actually
 * takes. `balanced` doubles the felt cost of walking — the "walk reluctance
 * 2.0" convention. The other two are for riders whose trade-off differs: in the
 * heat, or carrying shopping, 300 m saved is worth a longer ride, while someone
 * in a hurry would rather walk a block than wait for a connection.
 *
 * These only reweight the ranking. `maxWalkM` still decides what is walkable at
 * all, so `more` can never route a rider past the distance they set.
 */
export const WALK_PENALTY_MIN_PER_KM: Record<WalkPreference, number> = {
  less: 30,
  balanced: 12,
  more: 3,
};
const TRANSFER_PENALTY_MIN = 5;
/** Unscheduled minibus times are guesses, so they lose ties to real timetables. */
const ESTIMATE_PENALTY_MIN = 4;
/**
 * Fares are charged per boarding, so a two-bus trip can cost MVR 25 where one
 * bus costs 10 — a real difference to a daily rider that arrival time alone
 * never sees. At Malé wages an hour is worth well north of MVR 60, so a minute
 * per rufiyaa is a deliberately conservative trade: it will not sell a rider a
 * much slower trip to save a few rufiyaa, but it does break the common case
 * where two options land within a few minutes of each other and one is cheaper.
 */
const FARE_PENALTY_MIN_PER_MVR = 1;

/**
 * A label is one way of standing at one stop at one time.
 *
 * The predecessor is held as a direct reference rather than looked up by stop
 * code: labels get overwritten as rounds progress, and a by-code lookup would
 * rebuild an itinerary out of steps that never belonged to the same journey.
 */
interface Label {
  stopCode: StopCode;
  arriveAt: number;
  round: number;
  via: ViaOrigin | ViaWalk | ViaBus;
}
interface ViaOrigin {
  kind: 'origin';
  meters: number;
  seconds: number;
}
interface ViaWalk {
  kind: 'walk';
  from: Label;
  meters: number;
  seconds: number;
}
interface ViaBus {
  kind: 'bus';
  from: Label;
  routeCode: string;
  departAt: number;
  estimated: boolean;
  /** Set when `departAt` is a reported arrival rather than a timetable time. */
  live?: LiveEta;
}

/**
 * RAPTOR: round-based earliest-arrival search.
 *
 * With 15 routes, 101 stops and ~40 trips per route this settles in a couple of
 * milliseconds, so there is no need for anything more elaborate.
 *
 * Given `options.liveEtas`, the search runs on reported arrivals wherever it has
 * one for a bus the rider can still catch, so a late or missing bus reshapes the
 * whole answer — which options are offered, when to leave, whether a connection
 * still stands — rather than being noted beside times that no longer hold.
 */
export function planJourney(
  graph: TransitGraph,
  origin: Place,
  destination: Place,
  options: PlanOptions,
): Itinerary[] {
  const walkPreference = options.walkPreference ?? DEFAULTS.walkPreference;
  const maxWalkM = options.maxWalkM ?? DEFAULTS.maxWalkM;
  const maxTotalWalkM = options.maxTotalWalkM ?? DEFAULTS.maxTotalWalkM;
  const maxRounds = options.maxRounds ?? DEFAULTS.maxRounds;
  const maxResults = options.maxResults ?? DEFAULTS.maxResults;

  const candidates: Itinerary[] = [];

  // The destination may simply be close enough to walk to.
  const directWalkM = walkMeters(origin, destination);
  if (directWalkM <= maxWalkM) {
    candidates.push(
      finalizeItinerary(
        [
          {
            kind: 'walk',
            from: origin,
            to: destination,
            meters: directWalkM,
            seconds: walkSeconds(directWalkM),
          },
        ],
        'walk-only',
      ),
    );
  }

  // Round 0 — walk from the origin to every stop in range.
  const best = new Map<StopCode, Label>();
  let marked = new Set<StopCode>();

  for (const stop of graph.stops.values()) {
    const meters = walkMeters(origin, stop);
    if (meters > maxWalkM) continue;
    const seconds = walkSeconds(meters);
    best.set(stop.code, {
      stopCode: stop.code,
      arriveAt: options.departAt + seconds / 60,
      round: 0,
      via: { kind: 'origin', meters, seconds },
    });
    marked.add(stop.code);
  }

  /**
   * Every arrival by bus, kept separately from `best`.
   *
   * `best` holds the earliest way to *stand* at a stop, which is often a short
   * walk from a neighbouring stop. Those walk labels are what lets the next round
   * board elsewhere, but you cannot end a journey on one — so the alighting
   * options are collected here, where a faster walk cannot erase them.
   */
  const busArrivals: Label[] = [];

  for (let round = 1; round <= maxRounds && marked.size > 0; round++) {
    const improved = new Set<StopCode>();
    // Boarding reads the previous round's labels so that relaxing a route cannot
    // depend on a label written moments earlier in the same round.
    const boardable = new Map(best);

    for (const routeCode of routesTouching(graph, marked)) {
      const route = graph.routes.get(routeCode);
      if (!route) continue;
      relaxRoute(
        graph,
        route,
        boardable,
        best,
        marked,
        round,
        improved,
        busArrivals,
        options.liveEtas?.get(routeCode),
      );
    }

    // Walking interchange, so the next round can board at a neighbouring stop.
    for (const stopCode of [...improved]) {
      const label = best.get(stopCode);
      if (!label) continue;
      for (const transfer of graph.walkTransfers.get(stopCode) ?? []) {
        const arriveAt = label.arriveAt + transfer.seconds / 60;
        const existing = best.get(transfer.to);
        if (existing && existing.arriveAt <= arriveAt) continue;
        best.set(transfer.to, {
          stopCode: transfer.to,
          arriveAt,
          round,
          via: { kind: 'walk', from: label, meters: transfer.meters, seconds: transfer.seconds },
        });
        improved.add(transfer.to);
      }
    }

    marked = improved;
  }

  // Egress — walk from every stop a bus actually dropped us at to the destination.
  for (const label of busArrivals) {
    const stop = graph.stops.get(label.stopCode);
    if (!stop) continue;

    const meters = walkMeters(stop, destination);
    if (meters > maxWalkM) continue;

    const legs = reconstruct(graph, label, origin);
    if (!legs) continue;
    // Getting off a route only to board the same route again is never useful —
    // the loop-shaped stop lists make the search find these, so drop them.
    if (hasRedundantTransfer(legs)) continue;

    if (meters > 30) {
      legs.push({
        kind: 'walk',
        from: placeOf(stop),
        to: destination,
        meters,
        seconds: walkSeconds(meters),
      });
    }

    const itinerary = finalizeItinerary(legs, `${label.round}-${label.stopCode}`);
    if (itinerary.totalWalkM > maxTotalWalkM) continue;
    candidates.push(itinerary);
  }

  return dedupe(candidates, walkPreference)
    .sort(
      (a, b) =>
        generalizedCost(a, walkPreference) - generalizedCost(b, walkPreference) ||
        a.arriveAt - b.arriveAt ||
        a.totalWalkM - b.totalWalkM ||
        totalDistanceM(a) - totalDistanceM(b),
    )
    .slice(0, maxResults);
}

/**
 * What an itinerary costs the rider, in minutes-equivalent.
 *
 * Time, distance and money in one number: arrival time carries the journey and
 * the wait before it, walking distance is charged at the rider's own rate, and
 * every fare is converted at FARE_PENALTY_MIN_PER_MVR.
 *
 * Distance ridden on the bus is deliberately absent — it is already paid for in
 * arrival time, and charging for it again would push riders onto a shortcut
 * that is slower, or dearer, or both.
 *
 * Exported for tests: the weights are the ranking, so they are worth asserting
 * on directly rather than through whichever itineraries a fixture happens to
 * contain.
 */
export function generalizedCost(
  it: Itinerary,
  walkPreference: WalkPreference = DEFAULTS.walkPreference,
): number {
  return (
    it.arriveAt +
    (it.totalWalkM / 1000) * WALK_PENALTY_MIN_PER_KM[walkPreference] +
    it.transfers * TRANSFER_PENALTY_MIN +
    it.totalFare * FARE_PENALTY_MIN_PER_MVR +
    (it.estimated ? ESTIMATE_PENALTY_MIN : 0)
  );
}

/** Whole door-to-door distance — walked plus ridden — in metres. */
export function totalDistanceM(it: Itinerary): number {
  return it.totalWalkM + it.totalRideM;
}

/**
 * Identifies the journey an itinerary describes, independently of when it runs.
 *
 * `id` is positional within one search and is not comparable across searches, so
 * a view holding onto a chosen trip needs this to find that same trip again in a
 * later plan — the same buses boarded and left at the same stops, just a
 * departure or two further down the timetable.
 */
export function itinerarySignature(it: Itinerary): string {
  return it.legs
    .map((l) =>
      l.kind === 'bus'
        ? `${l.route.code}@${l.boardStop.code}>${l.alightStop.code}`
        : `walk:${Math.round(l.meters)}`,
    )
    .join('|');
}

function routesTouching(graph: TransitGraph, marked: Set<StopCode>): Set<string> {
  const out = new Set<string>();
  for (const stopCode of marked) {
    for (const routeCode of graph.routesAtStop.get(stopCode) ?? []) out.add(routeCode);
  }
  return out;
}

/**
 * Scan a route once, forward around its loop.
 *
 * Each RTL route is a loop whose stop list runs the outbound leg then the `OPP`
 * return leg, so a ride is valid exactly when the boarding position precedes the
 * alighting one. The list ends before the loop closes, though — a bus reaching
 * the last stop still drives back to the first to start its next trip, and
 * carries riders over that stretch — so the scan runs `MAX_WRAP_STOPS` positions
 * past the end, indexing by position around the loop rather than into the array.
 *
 * The wrap can never reach the boarding stop again: it is capped at `boardIndex`
 * as well, so no rider is sold a second lap of the route they are already on.
 */
function relaxRoute(
  graph: TransitGraph,
  route: Route,
  boardable: Map<StopCode, Label>,
  best: Map<StopCode, Label>,
  marked: Set<StopCode>,
  round: number,
  improved: Set<StopCode>,
  busArrivals: Label[],
  liveAtStop?: Map<StopCode, LiveEta>,
): void {
  let boardIndex = -1;
  let boardLabel: Label | null = null;
  let trip: TripView | null = null;

  // `boardIndex` is settled by the time the scan passes the last stop, since
  // boarding only happens below that, so the wrap's extent is known when needed.
  for (let i = 0; i < route.stops.length + Math.min(MAX_WRAP_STOPS, Math.max(0, boardIndex)); i++) {
    const stopCode = stopAtPosition(route, i).stopCode;

    // Ride: having boarded upstream, can we alight here?
    if (trip && boardIndex >= 0 && boardLabel) {
      const arriveAt = arrivalAt(graph, route, trip, boardIndex, i, boardLabel);
      if (arriveAt != null) {
        const label: Label = {
          stopCode,
          arriveAt,
          round,
          via: {
            kind: 'bus',
            from: boardLabel,
            routeCode: route.code,
            departAt: departureAt(trip, boardIndex, boardLabel),
            estimated: trip.estimated,
            live: trip.live,
          },
        };
        busArrivals.push(label);

        const existing = best.get(stopCode);
        if (!existing || arriveAt < existing.arriveAt) {
          best.set(stopCode, label);
          improved.add(stopCode);
        }
      }
    }

    // Board: only from stops improved in a previous round, and only on the
    // route's own stop order — a wrapped position is the ride finishing, not a
    // fresh boarding opportunity on a trip that has already run its course.
    if (i >= route.stops.length) continue;

    const label = boardable.get(stopCode);
    if (!label || !marked.has(stopCode)) continue;

    const readyAt = label.arriveAt + (label.round === 0 ? 0 : MIN_TRANSFER_MIN);
    const candidate = earliestTrip(route, i, readyAt, liveAtStop?.get(stopCode));
    if (!candidate) continue;

    const currentDeparture = trip ? departureAt(trip, boardIndex, boardLabel!) : Infinity;
    if (departureAt(candidate, i, label) < currentDeparture) {
      trip = candidate;
      boardIndex = i;
      boardLabel = label;
    }
  }
}

interface TripView {
  times: (number | null)[];
  /**
   * Minutes added to every timetable time so the trip runs to the bus that was
   * actually reported. Zero for a trip taken straight off the schedule.
   */
  shift: number;
  /** Departure read off the feed, on a route with no timetable to shift. */
  liveDepartAt?: number;
  /** The reading this trip was matched to, when it came from one. */
  live?: LiveEta;
  estimated: boolean;
  headwayMin: number;
}

/**
 * Earliest departure from stop index `index` at or after `readyAt`.
 *
 * A reported bus outranks the timetable. The feed is tracking the vehicles
 * themselves, so when it says the next bus reaches this stop in nine minutes,
 * nine minutes is when the rider can leave — including when the timetable
 * promises one sooner, which is exactly the case a printed time lets a rider
 * down in: the bus that is running late, or is not running at all, is still
 * there in the schedule.
 *
 * The reading only stands in for the timetable on a bus the rider can still
 * catch. One arriving before they can reach the stop says nothing about the one
 * after it, so those boardings fall back to the schedule.
 */
function earliestTrip(
  route: Route,
  index: number,
  readyAt: number,
  live?: LiveEta,
): TripView | null {
  const liveDepartAt = live?.expectedAt;
  const catchable = liveDepartAt != null && liveDepartAt >= readyAt;

  if (route.trips.length === 0) {
    // Frequency route: no timetable published, so a reported bus is the only
    // real departure there is. Failing that, assume a headway.
    return catchable
      ? { times: [], shift: 0, liveDepartAt, live, estimated: true, headwayMin: 0 }
      : { times: [], shift: 0, estimated: true, headwayMin: route.headwayMin ?? 15 };
  }

  if (catchable) {
    // The feed names a time, not a trip. Matching it to the nearest scheduled
    // departure from this stop borrows that trip's onward times — which stops it
    // serves, and how long it takes between them — and slides them onto the time
    // reported. Landing on a neighbouring trip costs next to nothing, since
    // consecutive trips run the same road at the same speeds.
    const matched = nearestTripDeparting(route, index, liveDepartAt);
    if (matched) {
      return {
        times: matched.times,
        shift: liveDepartAt - matched.times[index]!,
        live,
        estimated: false,
        headwayMin: 0,
      };
    }
  }

  let bestTrip: TripView | null = null;
  let bestDeparture = Infinity;
  for (const t of route.trips) {
    const depart = t.times[index];
    if (depart == null || depart < readyAt) continue;
    if (depart < bestDeparture) {
      bestDeparture = depart;
      bestTrip = { times: t.times, shift: 0, estimated: false, headwayMin: 0 };
    }
  }
  return bestTrip;
}

/**
 * The trip whose scheduled departure from `index` falls closest to `at`.
 *
 * `route.trips` is in chronological order and the comparison is strict, so a
 * reported time sitting exactly between two trips takes the earlier one — a bus
 * behind its slot is the common case, one ahead of it is not.
 */
function nearestTripDeparting(route: Route, index: number, at: number): Trip | null {
  let best: Trip | null = null;
  let bestGap = Infinity;
  for (const t of route.trips) {
    const depart = t.times[index];
    if (depart == null) continue;
    const gap = Math.abs(depart - at);
    if (gap < bestGap) {
      bestGap = gap;
      best = t;
    }
  }
  return best;
}

function departureAt(trip: TripView, boardIndex: number, boardLabel: Label): number {
  if (trip.times.length === 0) {
    // Frequency route: the reported bus, or the expected wait for a rider
    // turning up at random to a stop served every H minutes.
    return trip.liveDepartAt ?? boardLabel.arriveAt + trip.headwayMin / 2;
  }
  const scheduled = trip.times[boardIndex];
  return scheduled == null ? boardLabel.arriveAt : scheduled + trip.shift;
}

function arrivalAt(
  graph: TransitGraph,
  route: Route,
  trip: TripView,
  boardIndex: number,
  alightIndex: number,
  boardLabel: Label,
): number | null {
  if (alightIndex <= boardIndex) return null;

  const terminal = route.stops.length - 1;
  if (alightIndex > terminal) {
    if (rideMeters(route, graph.stops, terminal, alightIndex) < MIN_WRAP_RIDE_M) return null;
    // Closing the loop. No published time covers the stretch past the last stop,
    // so the time the bus is there is extended by the drive back round to the
    // route's start — the one part of the ride this has to estimate.
    const atTerminal =
      boardIndex < terminal
        ? arrivalAt(graph, route, trip, boardIndex, terminal, boardLabel)
        : departureAt(trip, boardIndex, boardLabel);
    if (atTerminal == null) return null;
    return (
      atTerminal +
      TERMINAL_DWELL_MIN +
      estimateRideMinutes(route, graph.stops, terminal, alightIndex)
    );
  }

  if (trip.estimated) {
    return (
      departureAt(trip, boardIndex, boardLabel) +
      estimateRideMinutes(route, graph.stops, boardIndex, alightIndex)
    );
  }
  const depart = trip.times[boardIndex];
  const arrive = trip.times[alightIndex];
  if (arrive == null || depart == null || arrive < depart) return null;
  // Shifted with the departure: a bus reported nine minutes late is nine minutes
  // late all the way down the line, and its connections have to be judged on that.
  return arrive + trip.shift;
}

/** Walks the label chain back to the origin and emits legs in travel order. */
function reconstruct(graph: TransitGraph, end: Label, origin: Place): Leg[] | null {
  const legs: Leg[] = [];
  let cursor: Label | null = end;
  let guard = 0;

  while (cursor && guard++ < 32) {
    const stop = graph.stops.get(cursor.stopCode);
    if (!stop) return null;
    const via: Label['via'] = cursor.via;

    if (via.kind === 'origin') {
      // Sub-30 m hops (the origin already being at the stop) are noise, not a leg.
      if (via.meters > 30) {
        legs.push({
          kind: 'walk',
          from: origin,
          to: placeOf(stop),
          meters: via.meters,
          seconds: via.seconds,
        });
      }
      cursor = null;
    } else if (via.kind === 'walk') {
      const from = graph.stops.get(via.from.stopCode);
      if (!from) return null;
      if (via.meters > 30) {
        legs.push({
          kind: 'walk',
          from: placeOf(from),
          to: placeOf(stop),
          meters: via.meters,
          seconds: via.seconds,
        });
      }
      cursor = via.from;
    } else {
      const route = graph.routes.get(via.routeCode);
      const boardStop = graph.stops.get(via.from.stopCode);
      if (!route || !boardStop) return null;

      const boardIndex = route.stops.findIndex((s) => s.stopCode === boardStop.code);
      let alightIndex = route.stops.findIndex((s) => s.stopCode === stop.code);
      // A ride that closed the loop alights at a stop sitting earlier in the list
      // than the one it boarded at. Unwrapping it back to a position around the
      // loop is what makes the distance and stop count measure the way the bus
      // actually drove, rather than counting backwards through the list.
      if (alightIndex <= boardIndex) alightIndex += route.stops.length;

      legs.push({
        kind: 'bus',
        route,
        boardStop,
        alightStop: stop,
        departAt: via.departAt,
        arriveAt: cursor.arriveAt,
        numStops: Math.max(1, alightIndex - boardIndex),
        meters: rideMeters(route, graph.stops, boardIndex, alightIndex),
        fare: route.fare,
        estimated: via.estimated,
        liveEta: via.live,
      });
      cursor = via.from;
    }
  }

  return legs.reverse();
}

/** True when two consecutive bus legs ride the same route. */
function hasRedundantTransfer(legs: Leg[]): boolean {
  const routes = legs.filter((l): l is BusLeg => l.kind === 'bus').map((l) => l.route.code);
  return routes.some((code, i) => i > 0 && routes[i - 1] === code);
}

function placeOf(stop: Stop): Place {
  return { name: stop.name, lat: stop.lat, lng: stop.lng, stopCode: stop.code };
}

/**
 * Totals and door-to-door times, derived from the legs alone.
 *
 * Exported because a walking path routed after the fact changes a walk leg's
 * distance and duration, and everything an itinerary reports about itself —
 * when to leave, when you arrive, how far you walk — has to be recomputed from
 * the legs it now has rather than patched.
 */
export function finalizeItinerary(legs: Leg[], id: string): Itinerary {
  const busLegs = legs.filter((l): l is BusLeg => l.kind === 'bus');
  const walkLegs = legs.filter((l): l is WalkLeg => l.kind === 'walk');

  const firstBus = busLegs[0];
  const lastBus = busLegs[busLegs.length - 1];

  const leadingWalkSec = legs[0]?.kind === 'walk' ? legs[0].seconds : 0;
  const last = legs[legs.length - 1];
  const trailingWalkSec = last?.kind === 'walk' ? last.seconds : 0;

  const departAt = firstBus ? firstBus.departAt - leadingWalkSec / 60 : 0;
  const arriveAt = lastBus
    ? lastBus.arriveAt + trailingWalkSec / 60
    : walkLegs.reduce((sum, l) => sum + l.seconds / 60, 0);

  return {
    id,
    legs,
    departAt,
    arriveAt,
    totalWalkM: walkLegs.reduce((sum, l) => sum + l.meters, 0),
    totalRideM: busLegs.reduce((sum, l) => sum + l.meters, 0),
    transfers: Math.max(0, busLegs.length - 1),
    totalFare: busLegs.reduce((sum, l) => sum + l.fare, 0),
    estimated: busLegs.some((l) => l.estimated),
  };
}

/**
 * Keeps one itinerary per combination of routes.
 *
 * The search naturally finds a dozen near-identical trips down the same routes
 * that differ only in which stop you get off at and how far you then walk.
 * Showing four of those is useless; a rider choosing between options wants
 * genuinely different buses, so only the best trip per route sequence survives.
 */
function dedupe(list: Itinerary[], walkPreference: WalkPreference): Itinerary[] {
  const bestPerRouteCombo = new Map<string, Itinerary>();

  for (const it of list) {
    const key =
      it.legs
        .filter((l): l is BusLeg => l.kind === 'bus')
        .map((l) => l.route.code)
        .join('>') || 'walk';

    const existing = bestPerRouteCombo.get(key);
    if (
      !existing ||
      generalizedCost(it, walkPreference) < generalizedCost(existing, walkPreference)
    ) {
      bestPerRouteCombo.set(key, it);
    }
  }

  return [...bestPerRouteCombo.values()];
}
