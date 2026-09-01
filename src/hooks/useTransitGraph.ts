import { useQuery } from '@tanstack/react-query';
import { fetchRouteDetails } from '@/api/rtl';
import { buildGraph } from '@/lib/transit/buildGraph';
import { loadOfflineRouteDetails, mergeWithStoredTimetable } from '@/lib/timetableCache';
import type { TransitGraph } from '@/lib/transit/types';

export const TRANSIT_GRAPH_KEY = ['rtl', 'routedetails'] as const;

/**
 * Where a graph came from.
 *
 * `'network'` covers both the backend and RTL directly — from the rider's point
 * of view they are the same thing, current data — while `'cache'` means today's
 * saved snapshot was used because neither could be reached.
 */
export type GraphSource = 'network' | 'cache';

export interface TransitGraphResult {
  graph: TransitGraph;
  source: GraphSource;
  /**
   * True when neither the backend nor RTL could be reached and today's saved
   * snapshot was used. A far more honest signal than `navigator.onLine`, which
   * reports true for any network interface — including one with no route to the
   * internet, and one where only port 4455 is blocked.
   */
  fromCache: boolean;
}

export function useTransitGraph() {
  return useQuery<TransitGraphResult>({
    queryKey: TRANSIT_GRAPH_KEY,
    queryFn: async ({ signal }) => {
      try {
        // Resolves against the backend when one is configured and reachable,
        // and against RTL directly otherwise; the shape is identical either way.
        const raw = await fetchRouteDetails(signal);
        // Fill in the departures RTL has already dropped from today's response.
        // The backend's copy already carries the whole day, in which case this
        // merge finds nothing to add — but it still writes the snapshot that
        // keeps offline planning working, so it runs on both paths.
        const merged = await mergeWithStoredTimetable(raw);
        return { graph: buildGraph(merged), source: 'network', fromCache: false };
      } catch (err) {
        // Offline, or port 4455 blocked with no backend to route around it.
        // Today's saved snapshot still lets the planner work; only live bus
        // times are lost.
        const offline = await loadOfflineRouteDetails();
        if (offline) return { graph: buildGraph(offline), source: 'cache', fromCache: true };
        throw err;
      }
    },
    staleTime: 30 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 2,
  });
}
