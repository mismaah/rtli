/**
 * Folds the recorder's measurements into a built graph.
 *
 * Deliberately a separate step rather than part of `buildGraph`. That function
 * is the single normalizer both network paths run through — the backend's copy
 * and the direct-to-RTL fallback — and it has to stay a pure function of RTL's
 * own JSON, or the two paths could disagree about what a route is. Measurements
 * come from one of those paths only, may be absent, and are an overlay on the
 * result rather than an input to it.
 *
 * The graph is mutated in place. It has just been built by the caller and is not
 * yet shared with anything, and copying it would mean rebuilding every stop and
 * transfer map to change two fields per route.
 */
import type { HistorySummary } from '@/api/history';
import type { RouteMeasurements, TransitGraph } from './types';

/**
 * The fewest observations behind a headway before it is allowed to replace the
 * assumption.
 *
 * The server already withholds thin buckets, so this is a second, independent
 * floor rather than the only one — it is the client saying what it is willing to
 * plan a rider's journey on, which is not the same question as what is worth
 * publishing. A number here that is wrong in the rider's favour costs them a bus.
 */
export const MIN_HEADWAY_SAMPLES = 20;

/**
 * Applies measurements to a graph, returning it.
 *
 * A null summary is the ordinary case on a client with no backend configured, or
 * one whose backend has no store, and leaves the graph exactly as built: every
 * assumption it already had, unchanged.
 */
export function applyHistory(graph: TransitGraph, history: HistorySummary | null): TransitGraph {
  if (!history) return graph;

  for (const [code, route] of graph.routes) {
    const measured = history.routes[code];
    if (!measured) continue;

    const attached: RouteMeasurements = {
      headwaySamples: measured.headwaySamples ?? 0,
      headwayIsLap: measured.headwayIsLap === true,
      latenessSamples: measured.latenessSamples ?? 0,
    };
    if (typeof measured.headwayMin === 'number') attached.headwayMin = measured.headwayMin;
    if (measured.headwayByHour) attached.headwayByHour = measured.headwayByHour;
    if (measured.latenessByHour) attached.latenessByHour = measured.latenessByHour;
    if (measured.segmentSecs) {
      // Seconds on the wire, minutes in the planner. Converted once here rather
      // than at each of the thousands of lookups a search performs.
      const segmentMin: Record<string, number> = {};
      for (const [pair, secs] of Object.entries(measured.segmentSecs)) {
        if (typeof secs === 'number' && secs > 0) segmentMin[pair] = secs / 60;
      }
      if (Object.keys(segmentMin).length > 0) attached.segmentMin = segmentMin;
    }
    route.measured = attached;

    // The assumed headway is replaced only on the routes that have one — the
    // frequency routes with no timetable. A scheduled route's real departures
    // are better than any median of the gaps between them.
    if (
      route.trips.length === 0 &&
      attached.headwayMin != null &&
      attached.headwaySamples >= MIN_HEADWAY_SAMPLES
    ) {
      route.headwayMin = attached.headwayMin;
    }
  }
  return graph;
}

/**
 * The measured wait at a given time of day, falling back to the route's
 * all-hours median and then to whatever the route already assumed.
 *
 * Hour-of-day matters more here than anywhere else in the planner: a route every
 * 15 minutes at 08:00 is not one every 15 minutes at 23:00, and a rider planning
 * a late journey is the one who most needs to be told the wait is long.
 */
export function headwayMinutesAt(
  measured: RouteMeasurements | undefined,
  maleMinutes: number,
  fallback: number,
): number {
  if (!measured || measured.headwaySamples < MIN_HEADWAY_SAMPLES) return fallback;
  const hour = Math.floor(((maleMinutes % 1440) + 1440) % 1440 / 60);
  const hourly = measured.headwayByHour?.[String(hour)];
  if (typeof hourly === 'number' && hourly > 0) return hourly;
  return measured.headwayMin ?? fallback;
}
