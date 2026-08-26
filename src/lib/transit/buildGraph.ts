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
 * `timings[].order` is a trip number shared across every stop on the route, so
 * grouping by it reconstructs a full timetable — verified on R1, where trip 28
 * runs stop 1 @ 12:30 through stop 18 @ 13:40.
 */
function buildTrips(raw: RawRoute, stops: RouteStop[]): Trip[] {
  const byTripOrder = new Map<number, (number | null)[]>();

  (raw.busRouteStopList ?? []).forEach((rawStop, index) => {
    for (const timing of rawStop.timings ?? []) {
      const minutes = parseClock(timing.timing);
      if (minutes == null) continue;
      let row = byTripOrder.get(timing.order);
      if (!row) {
        row = new Array<number | null>(stops.length).fill(null);
        byTripOrder.set(timing.order, row);
      }
      row[index] = minutes;
    }
  });

  const trips: Trip[] = [];
  for (const [tripOrder, times] of byTripOrder) {
    // A trip is only usable if at least two stops have times to travel between.
    if (times.filter((t) => t != null).length < 2) continue;
    trips.push({ tripOrder, times: unwrapMidnight(times) });
  }
  trips.sort((a, b) => firstTime(a) - firstTime(b));
  return trips;
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

    const trips = buildTrips(raw, routeStops);
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
 * Synthesised ride time between two positions on a frequency route, from
 * straight-line distance along the intermediate stops at an assumed speed.
 */
export function estimateRideMinutes(
  route: Route,
  stops: Map<StopCode, Stop>,
  fromIndex: number,
  toIndex: number,
): number {
  const meters = rideMeters(route, stops, fromIndex, toIndex);
  const minutes = (meters / 1000 / ESTIMATED_BUS_SPEED_KMH) * 60;
  // Dwell time at each intermediate stop.
  return Math.max(1, Math.round(minutes + (toIndex - fromIndex) * 0.4));
}

/**
 * Distance ridden along a route between two stop indices, in metres.
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
  let meters = 0;
  for (let i = fromIndex; i < toIndex; i++) {
    const a = stops.get(route.stops[i].stopCode);
    const b = stops.get(route.stops[i + 1].stopCode);
    if (a && b) meters += haversineMeters(a, b) * ROAD_DETOUR_FACTOR;
  }
  return meters;
}
