import { fetchStopEtas } from '@/api/rtl';
import { parseEta } from './parseEta';
import type { Itinerary, LiveEta } from './types';

/**
 * Attaches real-time arrivals to already-planned itineraries.
 *
 * Deliberately applied after planning, never inside it: live coverage is partial
 * (some routes report no buses at all), so the schedule stays the source of truth
 * and this only annotates it. Every failure is swallowed — a missing ETA must
 * never cost the rider their itinerary.
 */
export async function applyLiveEtas(
  itineraries: Itinerary[],
  signal?: AbortSignal,
): Promise<Itinerary[]> {
  const routeCodes = new Set<string>();
  for (const it of itineraries) {
    for (const leg of it.legs) if (leg.kind === 'bus') routeCodes.add(leg.route.code);
  }
  if (routeCodes.size === 0) return itineraries;

  const byRoute = new Map<string, Map<string, LiveEta>>();

  await Promise.all(
    [...routeCodes].map(async (routeCode) => {
      try {
        const res = await fetchStopEtas(routeCode, signal);
        const rows = [
          ...(res.inboundStopsETAList ?? []),
          // Observed null in every capture, but handled rather than assumed.
          ...(res.outboundStopsETAList ?? []),
        ];
        const perStop = new Map<string, LiveEta>();
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

  return itineraries.map((it) => ({
    ...it,
    legs: it.legs.map((leg) => {
      if (leg.kind !== 'bus') return leg;
      const eta = byRoute.get(leg.route.code)?.get(leg.boardStop.code);
      return eta ? { ...leg, liveEta: eta } : leg;
    }),
  }));
}
