import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { planJourney } from '@/lib/transit/plan';
import { fetchLiveEtas, routeCodesOf } from '@/lib/transit/liveOverlay';
import { useNowMinutes } from '@/hooks/useNowMinutes';
import { usePageVisible } from '@/hooks/usePageVisible';
import { usePrefs } from '@/store/prefs';
import type { Itinerary, Place, TransitGraph } from '@/lib/transit/types';

export interface PlanResult {
  itineraries: Itinerary[];
  /** True once the live feed has been read, whether or not it had anything. */
  liveApplied: boolean;
}

/** Matches StopDetail, so the two views never disagree about the same bus. */
const POLL_MS = 20_000;

/**
 * Plans a journey, on live arrivals wherever the feed reports one.
 *
 * Planned twice, deliberately. The schedule-only pass renders immediately, so a
 * slow or unreachable ETA endpoint never delays results, and it is also what
 * decides which routes are worth polling — a poll key taken from the live-aware
 * plan would move every time the feed changed the answer, evicting the cache it
 * had just filled. The trade is that a route no schedule-only option rides is
 * never polled, so it is planned from the timetable even if it is running.
 *
 * Both passes are re-driven over time. The plan is recomputed as the wall clock
 * turns over, so a departure that has just gone drops off the list instead of
 * sitting at the top; the ETAs are polled on their own interval, so a bus
 * falling further behind moves the times it is quoted at.
 */
export function usePlan(
  graph: TransitGraph | undefined,
  origin: Place | null,
  destination: Place | null,
  departAt?: number,
): PlanResult {
  const maxWalkM = usePrefs((s) => s.maxWalkM);
  const walkPreference = usePrefs((s) => s.walkPreference);
  const nowMinutes = useNowMinutes();
  const visible = usePageVisible();

  // `departAt` pins the search to a chosen time; without one it follows the
  // clock, which is what makes the results keep up with the minute.
  const searchFrom = departAt ?? nowMinutes;

  const scheduled = useMemo(() => {
    if (!graph || !origin || !destination) return [];
    return planJourney(graph, origin, destination, {
      departAt: searchFrom,
      maxWalkM,
      walkPreference,
    });
  }, [graph, origin, destination, searchFrom, maxWalkM, walkPreference]);

  const routeCodes = useMemo(() => routeCodesOf(scheduled), [scheduled]);
  /**
   * Keyed on which routes are involved rather than on the itineraries.
   * Replanning on the minute nearly always yields the same handful of routes, so
   * a key derived from the plan would evict the cache — and blank out every live
   * badge — once a minute for data that had not changed.
   */
  const routeKey = routeCodes.join(',');

  const { data: liveIndex } = useQuery({
    queryKey: ['rtl', 'plan-etas', routeKey],
    queryFn: ({ signal }) => fetchLiveEtas(routeKey.split(','), signal),
    enabled: visible && routeKey.length > 0,
    refetchInterval: visible ? POLL_MS : false,
    // Overrides the app-wide default: an ETA read before the phone went to sleep
    // is worthless on wake, and this is exactly when the rider looks at it.
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  /**
   * Replanned rather than annotated, so a bus the feed puts ten minutes behind
   * is ten minutes behind everywhere it matters: the departure the rider walks
   * to, the connection that may no longer stand, and the ranking that decides
   * whether this is still the option to show first.
   */
  const itineraries = useMemo(() => {
    if (!liveIndex || liveIndex.size === 0) return scheduled;
    if (!graph || !origin || !destination) return scheduled;
    return planJourney(graph, origin, destination, {
      departAt: searchFrom,
      maxWalkM,
      walkPreference,
      liveEtas: liveIndex,
    });
  }, [graph, origin, destination, searchFrom, maxWalkM, walkPreference, scheduled, liveIndex]);

  return { itineraries, liveApplied: liveIndex !== undefined || routeKey.length === 0 };
}
