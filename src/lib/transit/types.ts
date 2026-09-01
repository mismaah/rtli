import type { LatLng } from '@/lib/geo';

export type StopCode = string;
export type RouteCode = string;

export interface Stop extends LatLng {
  code: StopCode;
  name: string;
  dvName: string;
  /** Route codes serving this stop, in no particular order. */
  routes: RouteCode[];
}

export interface RouteStop {
  stopCode: StopCode;
  /** Position along the route loop: outbound leg, then the `OPP` return leg. */
  order: number;
}

export interface Trip {
  /** RTL's `timings[].order` — the trip number, shared across every stop. */
  tripOrder: number;
  /** Minutes since Malé midnight, index-aligned to `Route.stops`. */
  times: (number | null)[];
}

export interface Route {
  code: RouteCode;
  routeNumber: string;
  name: string;
  dvName: string;
  color: string;
  fare: number;
  isMiniBus: boolean;
  stops: RouteStop[];
  /** Empty for frequency-based routes (R10/R11/R12/R15). */
  trips: Trip[];
  /** Set only when `trips` is empty — assumed headway in minutes. */
  headwayMin?: number;
}

export interface WalkTransfer {
  to: StopCode;
  meters: number;
  seconds: number;
}

export interface TransitGraph {
  stops: Map<StopCode, Stop>;
  routes: Map<RouteCode, Route>;
  routesAtStop: Map<StopCode, RouteCode[]>;
  walkTransfers: Map<StopCode, WalkTransfer[]>;
  /** Malé service date the timetable belongs to, `YYYY-MM-DD`. */
  serviceDate: string;
}

export interface Place extends LatLng {
  name: string;
  /** Present when this place is a bus stop rather than an arbitrary point. */
  stopCode?: StopCode;
  /**
   * True when this is the rider's own position rather than a fixed point, so
   * the coordinates are a reading rather than an identity.
   */
  current?: boolean;
}

export interface LiveEta {
  /** Minutes until arrival, or 0 when the bus is pulling in. */
  minutes: number;
  vehicleCode: string;
  label: string;
  /**
   * Minutes since Malé midnight the bus is due, stamped when the reading was
   * taken. `minutes` is only true at the instant it was fetched, and planning
   * happens later and against absolute times, so this is what the planner reads.
   * Absent on a reading parsed outside a fetch, such as the stop board's.
   */
  expectedAt?: number;
}

/** Next reported arrival per stop, per route. */
export type LiveEtaIndex = Map<RouteCode, Map<StopCode, LiveEta>>;

export interface WalkLeg {
  kind: 'walk';
  from: Place;
  to: Place;
  meters: number;
  seconds: number;
  /**
   * `[lng, lat]` along the real footpath, when one has been routed. Its absence
   * means `meters` is still the planner's straight-line-plus-detour estimate.
   */
  path?: [number, number][];
}

export interface BusLeg {
  kind: 'bus';
  route: Route;
  boardStop: Stop;
  alightStop: Stop;
  /** Minutes since Malé midnight. May exceed 1440 for post-midnight arrivals. */
  departAt: number;
  arriveAt: number;
  numStops: number;
  /** Distance ridden along the route, in metres. */
  meters: number;
  /** Rufiyaa charged for boarding this route. */
  fare: number;
  /** True when times came from an assumed headway, not a published timetable. */
  estimated: boolean;
  /**
   * The reading this leg's times were planned from. Its presence means
   * `departAt` is when a tracked bus is actually due rather than when the
   * timetable says one should be.
   */
  liveEta?: LiveEta;
}

export type Leg = WalkLeg | BusLeg;

export interface Itinerary {
  id: string;
  legs: Leg[];
  departAt: number;
  arriveAt: number;
  totalWalkM: number;
  /** Distance covered on a bus, in metres. */
  totalRideM: number;
  transfers: number;
  /** Sum of every boarding's fare, in rufiyaa. */
  totalFare: number;
  estimated: boolean;
}
