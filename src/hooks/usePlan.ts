import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { planJourney } from '@/lib/transit/plan';
import { fetchLiveEtas, mergeLiveEtas, routeCodesOf } from '@/lib/transit/liveOverlay';
import { useNowMinutes } from '@/hooks/useNowMinutes';
import { usePageVisible } from '@/hooks/usePageVisible';
import { usePrefs } from '@/store/prefs';
import type { Itinerary, Place, TransitGraph } from '@/lib/transit/types';

export interface PlanResult {
  itineraries: Itinerary[];
  /** True once live ETAs have been merged in. */
  liveApplied: boolean;
}

/** Matches StopDetail, so the two views never disagree about the same bus. */
const POLL_MS = 20_000;

/**
 * Plans a journey, then layers live ETAs on top.
 *
 * The schedule-only result renders immediately and the live pass patches it in
 * when it lands, so a slow or unavailable ETA endpoint never delays results.
 *
 * Both halves are re-driven over time. The plan is recomputed as the wall clock
 * turns over, so a departure that has just gone drops off the list instead of
 * sitting at the top; the ETAs are polled on their own interval, so the "next in
 * 4 min" badge counts down rather than freezing at whatever it said on arrival.
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

  const itineraries = useMemo(
    () => (liveIndex ? mergeLiveEtas(scheduled, liveIndex) : scheduled),
    [scheduled, liveIndex],
  );

  return { itineraries, liveApplied: liveIndex !== undefined || routeKey.length === 0 };
}
