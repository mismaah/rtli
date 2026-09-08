import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { planJourney } from '@/lib/transit/plan';
import { fetchLiveEtas, preferEtas, routeCodesOf } from '@/lib/transit/liveOverlay';
import { usePositionEtas } from '@/hooks/usePositionEtas';
import { useNowMinutes } from '@/hooks/useNowMinutes';
import { usePageVisible } from '@/hooks/usePageVisible';
import { usePrefs } from '@/store/prefs';
import type { Itinerary, LiveEtaIndex, Place, TransitGraph } from '@/lib/transit/types';

export interface PlanResult {
  itineraries: Itinerary[];
  /**
   * The arrivals the plan was built on, so a trip the rider has already chosen
   * can be re-timed on the same readings rather than on the timetable alone —
   * see `refreshItinerary`. Undefined until something has answered.
   */
  liveEtas: LiveEtaIndex | undefined;
  /** True once the live feed has been read, whether or not it had anything. */
  liveApplied: boolean;
}

export interface UsePlanOptions {
  /** Pins the search to a chosen time instead of following the wall clock. */
  departAt?: number;
  /**
   * Routes to keep reading live arrivals for whatever the plan offers.
   *
   * The ranking keeps four options and one per combination of routes, so the
   * trip a rider has chosen routinely stops being offered — which is precisely
   * when they are standing at its stop watching for it. Polling it anyway is
   * what keeps `refreshItinerary` re-timing that trip on live data rather than
   * falling back to the timetable at the moment it matters most.
   */
  watchRoutes?: readonly string[];
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
  { departAt, watchRoutes }: UsePlanOptions = {},
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

  const watchKey = watchRoutes?.join(',') ?? '';
  const routeCodes = useMemo(() => {
    const codes = new Set(routeCodesOf(scheduled));
    for (const code of watchKey ? watchKey.split(',') : []) codes.add(code);
    return [...codes].sort();
  }, [scheduled, watchKey]);
  /**
   * Keyed on which routes are involved rather than on the itineraries.
   * Replanning on the minute nearly always yields the same handful of routes, so
   * a key derived from the plan would evict the cache — and blank out every live
   * badge — once a minute for data that had not changed.
   */
  const routeKey = routeCodes.join(',');

  const { data: reported } = useQuery({
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
   * What the app works out for itself from where the buses are, which is the
   * better answer wherever it has one — RTL's feed cannot say when the *next*
   * bus reaches a stop, only when the one it happens to be projecting would.
   * Its own readings stay underneath as the fallback: they still cover the stop
   * immediately ahead of a bus, and they need neither geometry nor a backend.
   */
  const derived = usePositionEtas(graph, routeCodes);
  const liveIndex = useMemo(
    () => (reported ? preferEtas(derived, reported) : derived.size > 0 ? derived : undefined),
    [derived, reported],
  );

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

  // "The live read has settled", which the screens use to tell "still checking"
  // apart from "nothing is running". Either source having answered settles it.
  return {
    itineraries,
    liveEtas: liveIndex,
    liveApplied: reported !== undefined || derived.size > 0 || routeKey.length === 0,
  };
}
