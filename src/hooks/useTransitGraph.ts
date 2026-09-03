import { useQuery } from '@tanstack/react-query';
import { fetchRouteDetails, type Via } from '@/api/rtl';
import { backendWorthAsking, COOLDOWN_MS } from '@/api/backend';
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
  /** Which network path answered, or null when nothing did. */
  via: Via | null;
}

/**
 * How long to wait before re-asking the backend for a graph RTL ended up
 * serving. A little past the breaker's cooldown, so a backend that has been set
 * aside is being asked *after* it is allowed back rather than during.
 */
const RECHECK_MS = COOLDOWN_MS + 5_000;

export function useTransitGraph() {
  return useQuery<TransitGraphResult>({
    queryKey: TRANSIT_GRAPH_KEY,
    queryFn: async ({ signal }) => {
      try {
        // Resolves against the backend when one is configured and reachable,
        // and against RTL directly otherwise; the shape is identical either way.
        const { details: raw, via } = await fetchRouteDetails(signal);
        // Fill in the departures RTL has already dropped from today's response.
        // The backend's copy already carries the whole day, in which case this
        // merge finds nothing to add — but it still writes the snapshot that
        // keeps offline planning working, so it runs on both paths.
        const merged = await mergeWithStoredTimetable(raw);
        return { graph: buildGraph(merged), source: 'network', fromCache: false, via };
      } catch (err) {
        // Offline, or port 4455 blocked with no backend to route around it.
        // Today's saved snapshot still lets the planner work; only live bus
        // times are lost.
        const offline = await loadOfflineRouteDetails();
        if (offline) {
          return { graph: buildGraph(offline), source: 'cache', fromCache: true, via: null };
        }
        throw err;
      }
    },
    staleTime: 30 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 2,
    /**
     * Come back to a fallback once, rather than living with it.
     *
     * This is the only request the app makes at startup, and it is then held
     * for half an hour — so a single slow or failed answer from the backend
     * hands the whole session to RTL, and nothing but a page reload ever asks
     * again. That is what a rider reports as "it works after I refresh".
     *
     * Exactly one re-ask, which is what `dataUpdateCount` bounds: the first
     * fetch makes it 1 and the re-ask makes it 2. A backend that has since
     * recovered is picked back up; one that is still down is then left alone,
     * because every attempt that fails costs a second download of the whole
     * timetable from RTL — on mobile data, to learn nothing. It is skipped
     * outright while the breaker is holding the backend aside, so the one
     * attempt is spent on a backend that is at least allowed to answer.
     */
    refetchInterval: ({ state }) =>
      state.data?.via === 'rtl' && state.dataUpdateCount < 2 && backendWorthAsking()
        ? RECHECK_MS
        : false,
    refetchIntervalInBackground: false,
  });
}
