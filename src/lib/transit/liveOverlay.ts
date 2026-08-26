import { fetchStopEtas } from '@/api/rtl';
import { parseEta } from './parseEta';
import type { Itinerary, LiveEta, StopCode } from './types';

/** Next reported arrival per stop, per route. */
export type LiveEtaIndex = Map<string, Map<StopCode, LiveEta>>;

/** The routes an itinerary set rides, sorted so the list is a stable cache key. */
export function routeCodesOf(itineraries: Itinerary[]): string[] {
  const codes = new Set<string>();
  for (const it of itineraries) {
    for (const leg of it.legs) if (leg.kind === 'bus') codes.add(leg.route.code);
  }
  return [...codes].sort();
}

/**
 * Reads live arrivals for the given routes.
 *
 * Kept separate from the merge below so the two can run on their own clocks: the
 * plan is recomputed as the minute turns, while these are polled on their own
 * interval. Folding them together meant a replan silently discarded live data
 * and refetched it, which showed up as the ETA badges blinking out every minute.
 *
 * Every failure is swallowed — a missing ETA must never cost the rider their
 * itinerary, so a route that reports nothing simply has no entry.
 */
export async function fetchLiveEtas(
  routeCodes: string[],
  signal?: AbortSignal,
): Promise<LiveEtaIndex> {
  const byRoute: LiveEtaIndex = new Map();

  await Promise.all(
    routeCodes.map(async (routeCode) => {
      try {
        const res = await fetchStopEtas(routeCode, signal);
        const rows = [
          ...(res.inboundStopsETAList ?? []),
          // Observed null in every capture, but handled rather than assumed.
          ...(res.outboundStopsETAList ?? []),
        ];
        const perStop = new Map<StopCode, LiveEta>();
        for (const row of rows) {
          const eta = parseEta(row.eta, row.vehicleCode);
          if (!eta) continue;
          const existing = perStop.get(row.stopCode);
          // Several buses can be inbound to one stop; the rider wants the next.
          if (!existing || eta.minutes < existing.minutes) perStop.set(row.stopCode, eta);
        }
        byRoute.set(routeCode, perStop);
      } catch {
        // Live data is an enhancement, not a dependency.
      }
    }),
  );

  return byRoute;
}

/**
 * Annotates planned itineraries with live arrivals at their boarding stops.
 *
 * Deliberately applied after planning, never inside it: live coverage is partial
 * (some routes report no buses at all), so the schedule stays the source of
 * truth and this only annotates it.
 */
export function mergeLiveEtas(itineraries: Itinerary[], index: LiveEtaIndex): Itinerary[] {
  if (index.size === 0) return itineraries;

  return itineraries.map((it) => {
    let changed = false;
    const legs = it.legs.map((leg) => {
      if (leg.kind !== 'bus') return leg;
      const eta = index.get(leg.route.code)?.get(leg.boardStop.code);
      if (!eta) return leg;
      changed = true;
      return { ...leg, liveEta: eta };
    });
    // Preserving identity when nothing matched keeps React from re-rendering the
    // whole result list on a poll that told us nothing new.
    return changed ? { ...it, legs } : it;
  });
}

/** Fetch-and-merge in one step, for callers with no separate poll loop. */
export async function applyLiveEtas(
  itineraries: Itinerary[],
  signal?: AbortSignal,
): Promise<Itinerary[]> {
  const routeCodes = routeCodesOf(itineraries);
  if (routeCodes.length === 0) return itineraries;
  return mergeLiveEtas(itineraries, await fetchLiveEtas(routeCodes, signal));
}
