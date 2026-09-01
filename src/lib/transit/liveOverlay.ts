import { fetchStopEtas, fetchStopEtasBatch, type StopsEtaResponse } from '@/api/rtl';
import { minutesOfDay } from '@/lib/time';
import { parseEta } from './parseEta';
import type { Itinerary, LiveEta, LiveEtaIndex, StopCode } from './types';

export type { LiveEtaIndex };

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
 * Kept separate from the planning it feeds so the two can run on their own
 * clocks: the plan is recomputed as the minute turns, while these are polled on
 * their own interval. Folding them together meant a replan silently discarded
 * live data and refetched it, which showed up as the ETA badges blinking out
 * every minute.
 *
 * Each reading is stamped with the clock time the bus is due, taken as this call
 * goes out. RTL reports a countdown, and a countdown read at 13:40 is wrong by
 * 13:43; the planner works in absolute times and runs whenever the minute turns
 * or the rider retunes their preferences, so the conversion belongs here, at the
 * one moment "in 4 minutes" is known to be true.
 *
 * Every failure is swallowed — a missing ETA must never cost the rider their
 * itinerary, so a route that reports nothing simply has no entry.
 */
export async function fetchLiveEtas(
  routeCodes: string[],
  signal?: AbortSignal,
): Promise<LiveEtaIndex> {
  const readAt = minutesOfDay();

  // One request for every route, when there is a backend to ask. Unbatched, a
  // phone comparing a few itineraries issues one of these per route per poll.
  try {
    const batched = await fetchStopEtasBatch(routeCodes, signal);
    if (batched) {
      const byRoute: LiveEtaIndex = new Map();
      for (const [routeCode, route] of Object.entries(batched.routes)) {
        // The backend may have been holding this reading for a moment. A
        // countdown read three seconds ago is three seconds wrong, and the
        // planner works in absolute times, so the age is discounted here.
        byRoute.set(routeCode, indexRows(route, readAt - route.ageMs / 60_000));
      }
      return byRoute;
    }
  } catch {
    // Fall through to RTL directly.
  }

  const byRoute: LiveEtaIndex = new Map();
  await Promise.all(
    routeCodes.map(async (routeCode) => {
      try {
        byRoute.set(routeCode, indexRows(await fetchStopEtas(routeCode, signal), readAt));
      } catch {
        // Live data is an enhancement, not a dependency.
      }
    }),
  );

  return byRoute;
}

/**
 * Folds one route's ETA rows into a per-stop index.
 *
 * `readAt` is the clock the countdowns are relative to, in minutes since Malé
 * midnight — now for a direct read, or slightly earlier for one the backend had
 * already been holding.
 */
function indexRows(res: StopsEtaResponse, readAt: number): Map<StopCode, LiveEta> {
  const rows = [
    ...(res.inboundStopsETAList ?? []),
    // Observed null in every capture, but handled rather than assumed.
    ...(res.outboundStopsETAList ?? []),
  ];
  const perStop = new Map<StopCode, LiveEta>();
  for (const row of rows) {
    const parsed = parseEta(row.eta, row.vehicleCode);
    if (!parsed) continue;
    const eta: LiveEta = { ...parsed, expectedAt: readAt + parsed.minutes };
    const existing = perStop.get(row.stopCode);
    // Several buses can be inbound to one stop; the rider wants the next.
    if (!existing || eta.minutes < existing.minutes) perStop.set(row.stopCode, eta);
  }
  return perStop;
}

/**
 * Annotates planned itineraries with live arrivals at their boarding stops.
 *
 * For a plan built without live data. `planJourney` given a `liveEtas` index
 * does better than this — it plans on the reported times rather than pinning
 * them beside timetable ones — so this is the fallback for an itinerary that
 * has already been planned and cannot be planned again, and it deliberately
 * leaves the times it finds alone.
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
