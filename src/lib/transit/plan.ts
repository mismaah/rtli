import { walkMeters, walkSeconds } from '@/lib/geo';
import { estimateRideMinutes, rideMeters } from './buildGraph';
import type {
  BusLeg,
  Itinerary,
  Leg,
  Place,
  Route,
  Stop,
  StopCode,
  TransitGraph,
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
}

/**
 * RAPTOR: round-based earliest-arrival search.
 *
 * With 15 routes, 101 stops and ~40 trips per route this settles in a couple of
 * milliseconds, so there is no need for anything more elaborate.
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
      finalize(
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
      relaxRoute(graph, route, boardable, best, marked, round, improved, busArrivals);
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

    const itinerary = finalize(legs, `${label.round}-${label.stopCode}`);
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
 * Scan a route once, forward along its stop order.
 *
 * Each RTL route is a loop whose stop list runs the outbound leg then the `OPP`
 * return leg, so a ride is valid exactly when the boarding index precedes the
 * alighting index. Wrap-around at the terminal is not modelled.
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
): void {
  let boardIndex = -1;
  let boardLabel: Label | null = null;
  let trip: TripView | null = null;

  for (let i = 0; i < route.stops.length; i++) {
    const stopCode = route.stops[i].stopCode;

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

    // Board: only from stops improved in a previous round.
    const label = boardable.get(stopCode);
    if (!label || !marked.has(stopCode)) continue;

    const readyAt = label.arriveAt + (label.round === 0 ? 0 : MIN_TRANSFER_MIN);
    const candidate = earliestTrip(route, i, readyAt);
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
  estimated: boolean;
  headwayMin: number;
}

/** Earliest trip on `route` departing stop index `index` at or after `readyAt`. */
function earliestTrip(route: Route, index: number, readyAt: number): TripView | null {
  if (route.trips.length === 0) {
    // Frequency route: no timetable published, so assume a headway.
    return { times: [], estimated: true, headwayMin: route.headwayMin ?? 15 };
  }
  let bestTrip: TripView | null = null;
  let bestDeparture = Infinity;
  for (const t of route.trips) {
    const depart = t.times[index];
    if (depart == null || depart < readyAt) continue;
    if (depart < bestDeparture) {
      bestDeparture = depart;
      bestTrip = { times: t.times, estimated: false, headwayMin: 0 };
    }
  }
  return bestTrip;
}

function departureAt(trip: TripView, boardIndex: number, boardLabel: Label): number {
  if (trip.estimated) {
    // Expected wait for a rider turning up at random to a stop served every H minutes.
    return boardLabel.arriveAt + trip.headwayMin / 2;
  }
  return trip.times[boardIndex] ?? boardLabel.arriveAt;
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
  if (trip.estimated) {
    return (
      departureAt(trip, boardIndex, boardLabel) +
      estimateRideMinutes(route, graph.stops, boardIndex, alightIndex)
    );
  }
  const depart = trip.times[boardIndex];
  const arrive = trip.times[alightIndex];
  if (arrive == null || depart == null || arrive < depart) return null;
  return arrive;
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
      const alightIndex = route.stops.findIndex((s) => s.stopCode === stop.code);

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

function finalize(legs: Leg[], id: string): Itinerary {
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
