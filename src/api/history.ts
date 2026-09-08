/**
 * What the backend's recorder has measured about how the network actually runs.
 *
 * This is the one thing the server knows that RTL does not publish. Everything
 * else the backend serves is a cache or a reshaping of upstream data; this is
 * the product of watching buses for weeks, and it exists because four of these
 * routes publish no timetable at all and the rest publish one the buses keep to
 * only approximately.
 *
 * Entirely optional. There is no fallback path to RTL because RTL has nothing to
 * fall back to — when this is unavailable the planner keeps the assumptions it
 * has always used, which is exactly what it did before the recorder existed.
 */
import { fetchFromBackend } from './backend';

/** One route's measured behaviour. Every field may be absent. */
export interface RouteHistory {
  /**
   * Median wait in minutes, absent when too little was observed to say. Missing
   * is not zero: it means "no measurement", and the caller keeps its assumption.
   */
  headwayMin?: number;
  headwaySamples: number;
  /**
   * True when the wait had to be measured as one bus coming round again,
   * because the route is worked by a single vehicle and no two consecutive
   * arrivals are different buses. Still the wait a rider has — R12 is the case
   * this exists for — but worth being able to tell apart.
   */
  headwayIsLap?: boolean;
  /** Median wait per hour of the Malé day, keyed "0".."23". */
  headwayByHour?: Record<string, number>;
  /**
   * Median signed minutes late against the route's own published timetable, per
   * hour. Positive is late. Absent for the routes that publish no timetable.
   */
  latenessByHour?: Record<string, number>;
  latenessSamples: number;
  /** Median ride in seconds between adjacent stops, keyed "fromStop>toStop". */
  segmentSecs?: Record<string, number>;
  /**
   * Median seconds to ride from one stop to another, keyed "fromStop>toStop",
   * for every ordered pair a bus was observed covering in one pass.
   *
   * Measured whole rather than summed from the legs between, so it carries what
   * a rider actually sits through. This is what a journey's ride time is taken
   * from where it exists; `segmentSecs` remains the per-leg figure.
   */
  rideSecs?: Record<string, number>;
  /**
   * The same medians resolved by hour of the Malé day, keyed "fromStop>toStop"
   * then "0".."23". Sparse: only the buckets with enough observations appear,
   * and `segmentSecs` above is what a caller falls back to for the rest.
   */
  segmentSecsByHour?: Record<string, Record<string, number>>;
}

export interface HistorySummary {
  generatedAtMs: number;
  fromMs: number;
  /** Keyed by route code ("133"), not route number ("R1"). */
  routes: Record<string, RouteHistory>;
}

/**
 * Fetches the measured summary, or null when there is none to be had.
 *
 * Null covers every failure mode there is — no backend configured, a server
 * without a store, a breaker holding it aside, a request that timed out — and
 * they all mean the same thing to the caller: plan with the assumptions.
 */
export async function fetchHistory(signal?: AbortSignal): Promise<HistorySummary | null> {
  const summary = await fetchFromBackend<HistorySummary>('/v1/history', signal);
  // A server that answered but has measured nothing is not an error, and is
  // still worth distinguishing from one that could not answer at all — but the
  // caller does the same thing either way, so it is folded into null here.
  if (!summary || typeof summary !== 'object' || !summary.routes) return null;
  return summary;
}
