import { useEffect, useMemo, useState } from 'react';
import { planJourney } from '@/lib/transit/plan';
import { applyLiveEtas } from '@/lib/transit/liveOverlay';
import { minutesOfDay } from '@/lib/time';
import { usePrefs } from '@/store/prefs';
import type { Itinerary, Place, TransitGraph } from '@/lib/transit/types';

export interface PlanResult {
  itineraries: Itinerary[];
  /** True once live ETAs have been merged in. */
  liveApplied: boolean;
}

/**
 * Plans a journey, then layers live ETAs on top.
 *
 * The schedule-only result renders immediately and the live pass patches it in
 * when it lands, so a slow or unavailable ETA endpoint never delays results.
 */
export function usePlan(
  graph: TransitGraph | undefined,
  origin: Place | null,
  destination: Place | null,
  departAt?: number,
): PlanResult {
  const maxWalkM = usePrefs((s) => s.maxWalkM);
  const walkPreference = usePrefs((s) => s.walkPreference);

  const scheduled = useMemo(() => {
    if (!graph || !origin || !destination) return [];
    return planJourney(graph, origin, destination, {
      departAt: departAt ?? minutesOfDay(),
      maxWalkM,
      walkPreference,
    });
  }, [graph, origin, destination, departAt, maxWalkM, walkPreference]);

  const [live, setLive] = useState<Itinerary[] | null>(null);

  useEffect(() => {
    setLive(null);
    if (scheduled.length === 0) return;
    const controller = new AbortController();
    let cancelled = false;

    applyLiveEtas(scheduled, controller.signal).then((withEtas) => {
      if (!cancelled) setLive(withEtas);
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [scheduled]);

  return { itineraries: live ?? scheduled, liveApplied: live !== null };
}
