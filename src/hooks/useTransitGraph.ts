import { useQuery } from '@tanstack/react-query';
import { fetchRouteDetails } from '@/api/rtl';
import { buildGraph } from '@/lib/transit/buildGraph';
import { loadOfflineRouteDetails, mergeWithStoredTimetable } from '@/lib/timetableCache';
import type { TransitGraph } from '@/lib/transit/types';

export const TRANSIT_GRAPH_KEY = ['rtl', 'routedetails'] as const;

export interface TransitGraphResult {
  graph: TransitGraph;
  /**
   * True when RTL could not be reached and today's saved snapshot was used.
   * A far more honest signal than `navigator.onLine`, which reports true for any
   * network interface — including one with no route to the internet, and one
   * where only port 4455 is blocked.
   */
  fromCache: boolean;
}

export function useTransitGraph() {
  return useQuery<TransitGraphResult>({
    queryKey: TRANSIT_GRAPH_KEY,
    queryFn: async ({ signal }) => {
      try {
        const raw = await fetchRouteDetails(signal);
        // Fill in the departures RTL has already dropped from today's response.
        const merged = await mergeWithStoredTimetable(raw);
        return { graph: buildGraph(merged), fromCache: false };
      } catch (err) {
        // Offline, or port 4455 blocked. Today's saved snapshot still lets the
        // planner work; only live bus times are lost.
        const offline = await loadOfflineRouteDetails();
        if (offline) return { graph: buildGraph(offline), fromCache: true };
        throw err;
      }
    },
    staleTime: 30 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 2,
  });
}
