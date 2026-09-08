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
  /** Trip number after realignment — RTL's `timings[].order` at the first stop. */
  tripOrder: number;
  /** Minutes since Malé midnight, index-aligned to `Route.stops`. */
  times: (number | null)[];
  /**
   * Minutes from the trip's first timed stop, with legs the timetable gives an
   * impossible time lengthened to what the distance allows.
   *
   * `times` stays exactly as published, so a stop's departure board is still
   * RTL's own; this is the ride duration to plan on. Where nothing was repaired
   * the two agree — `elapsed[b] - elapsed[a]` equals `times[b] - times[a]`.
   * Null wherever `times` is.
   */
  elapsed: (number | null)[];
  /**
   * Legs repaired at or before each position, so a ride that crosses one can be
   * surfaced as an estimate: it did when the count rises between its two ends.
   */
  repairsBefore: number[];
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
  /**
   * Set only when `trips` is empty — the headway in minutes to plan on.
   *
   * `DEFAULT_HEADWAY_MIN` until the recorder has measured the route, then the
   * median wait it observed. `measured` says which, and is what a caller should
   * read before telling a rider this number came from anywhere.
   */
  headwayMin?: number;
  /**
   * What the backend's recorder measured about this route, when it had enough
   * observations to say anything. Absent on every route until the history has
   * been fetched and applied, and absent afterwards on routes too thinly
   * observed to measure.
   */
  measured?: RouteMeasurements;
}

/**
 * Measured behaviour attached to a route, in the units the planner works in.
 *
 * Kept separate from the fields it feeds so provenance survives: `headwayMin`
 * on the route is the number to plan with, and this is where it came from.
 */
export interface RouteMeasurements {
  /** Median observed wait in minutes, absent when too little was seen. */
  headwayMin?: number;
  headwaySamples: number;
  /** The wait is one bus lapping, because the route runs a single vehicle. */
  headwayIsLap: boolean;
  /** Median observed wait per hour of the Malé day, keyed "0".."23". */
  headwayByHour?: Record<string, number>;
  /**
   * Median minutes late against the published timetable, per hour. Positive is
   * late. Recorded and surfaced, but deliberately not applied to departure
   * times; see the note in `plan.ts`.
   */
  latenessByHour?: Record<string, number>;
  latenessSamples: number;
  /**
   * Median ride in *minutes* between any two stops of the route, keyed
   * "fromStop>toStop", measured end to end from one bus's own arrivals.
   *
   * Not the legs between it summed: RTL's published times overstate a typical
   * ride by 16% across the network and by 44% on R2, and this is the figure that
   * says so. Where it exists it is what a journey is timed on, because it is an
   * observation of the ride rather than a claim about it.
   */
  rideMin?: Record<string, number>;
  /**
   * Median ride in *minutes* between adjacent stops, keyed "fromStop>toStop".
   * Converted from the seconds the server serves, because minutes are what the
   * planner adds up.
   */
  segmentMin?: Record<string, number>;
  /**
   * The same medians per hour of the Malé day, keyed "fromStop>toStop" then
   * "0".."23".
   *
   * A stretch of road is not the same ride at 08:00 as at 23:00, and an arrival
   * predicted minutes out is where that difference shows. Sparse by
   * construction — a thin hour is absent rather than noisy — so `segmentMin` is
   * always the fallback.
   */
  segmentMinByHour?: Record<string, Record<string, number>>;
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

/**
 * Which of RTL's three kinds of reading this is. Held as a kind rather than a
 * finished sentence because ETAs are parsed inside the live overlay, where no
 * language is in scope — the wording is chosen by whichever screen renders it.
 */
export type LiveEtaKind = 'arriving' | 'dispatch' | 'due';

/**
 * Where a reading came from.
 *
 * Absent means RTL's own feed, which is the reading this app started with and
 * still falls back to. `position` means the app worked it out itself, from live
 * bus positions on the route's geometry and the recorder's measured stop-to-stop
 * times — see `positionEta.ts` for why that is worth doing.
 */
export type LiveEtaSource = 'position';

export interface LiveEta {
  /** Minutes until arrival, or 0 when the bus is pulling in. */
  minutes: number;
  vehicleCode: string;
  kind: LiveEtaKind;
  /**
   * Minutes since Malé midnight the bus is due, stamped when the reading was
   * taken. `minutes` is only true at the instant it was fetched, and planning
   * happens later and against absolute times, so this is what the planner reads.
   * Absent on a reading parsed outside a fetch, such as the stop board's.
   */
  expectedAt?: number;
  /** How this reading was arrived at. Absent when it came straight from RTL. */
  source?: LiveEtaSource;
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
