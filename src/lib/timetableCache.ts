import { get, set, keys, del } from 'idb-keyval';
import type { RouteDetailsResponse, RawRoute } from '@/api/rtl';
import { serviceDate } from './time';

/**
 * RTL only returns *upcoming* departures — a fetch at 12:17 and one at 12:23 both
 * start R1 at the same trip. Opening the app in the evening therefore shows a
 * timetable with the whole morning missing.
 *
 * Each response is merged into a per-day store keyed by (routeCode, tripOrder),
 * so the picture fills in over the day and offline planning keeps working. Keyed
 * by service date because schedules may differ between days — a timetable is
 * never carried across dates.
 */
const KEY_PREFIX = 'rtl-improved.timetable.';
const SNAPSHOT_PREFIX = 'rtl-improved.routedetails.';

type StoredTimings = Record<string, Record<string, Record<number, string>>>;
// routeCode -> stopCode -> tripOrder -> "HH:mm:ss"

function keyFor(date: string): string {
  return `${KEY_PREFIX}${date}`;
}

function snapshotKeyFor(date: string): string {
  return `${SNAPSHOT_PREFIX}${date}`;
}

function extract(response: RouteDetailsResponse): StoredTimings {
  const out: StoredTimings = {};
  for (const route of response.routeResponse ?? []) {
    const perStop: Record<string, Record<number, string>> = {};
    for (const stop of route.busRouteStopList ?? []) {
      const timings = stop.timings ?? [];
      if (timings.length === 0) continue;
      const perTrip: Record<number, string> = {};
      for (const t of timings) perTrip[t.order] = t.timing;
      perStop[stop.code] = perTrip;
    }
    if (Object.keys(perStop).length > 0) out[route.code] = perStop;
  }
  return out;
}

function mergeStored(base: StoredTimings, incoming: StoredTimings): StoredTimings {
  const merged: StoredTimings = { ...base };
  for (const [routeCode, stops] of Object.entries(incoming)) {
    const target = { ...(merged[routeCode] ?? {}) };
    for (const [stopCode, trips] of Object.entries(stops)) {
      target[stopCode] = { ...(target[stopCode] ?? {}), ...trips };
    }
    merged[routeCode] = target;
  }
  return merged;
}

/**
 * Merges the response into today's accumulated timetable and returns a response
 * carrying the union — every trip seen so far today, not just the ones still to come.
 */
export async function mergeWithStoredTimetable(
  response: RouteDetailsResponse,
  now: Date = new Date(),
): Promise<RouteDetailsResponse> {
  const date = serviceDate(now);
  const key = keyFor(date);

  let stored: StoredTimings = {};
  try {
    stored = (await get<StoredTimings>(key)) ?? {};
  } catch {
    // Private mode or blocked storage: fall through with what the network gave us.
  }

  const merged = mergeStored(stored, extract(response));

  const complete = applyTimetable(response, merged);

  try {
    await set(key, merged);
    // Keep the whole response, not just the timings: routes, stops and
    // coordinates are what the planner needs to work at all when offline.
    await set(snapshotKeyFor(date), complete);
    await pruneOldDays(date);
  } catch {
    // Non-fatal — merging still improves this session.
  }

  return complete;
}

/**
 * The last good response, for when RTL cannot be reached.
 *
 * Only today's snapshot is offered: schedules may differ between days, and a
 * stale timetable presented as today's is worse than admitting we have none.
 */
export async function loadOfflineRouteDetails(
  now: Date = new Date(),
): Promise<RouteDetailsResponse | null> {
  try {
    return (await get<RouteDetailsResponse>(snapshotKeyFor(serviceDate(now)))) ?? null;
  } catch {
    return null;
  }
}

function applyTimetable(
  response: RouteDetailsResponse,
  timetable: StoredTimings,
): RouteDetailsResponse {
  const routes: RawRoute[] = (response.routeResponse ?? []).map((route) => {
    const perStop = timetable[route.code];
    if (!perStop) return route;
    return {
      ...route,
      busRouteStopList: (route.busRouteStopList ?? []).map((stop) => {
        const perTrip = perStop[stop.code];
        if (!perTrip) return stop;
        const timings = Object.entries(perTrip)
          .map(([order, timing]) => ({ order: Number(order), timing }))
          .sort((a, b) => a.order - b.order);
        return { ...stop, timings };
      }),
    };
  });
  return { ...response, routeResponse: routes };
}

async function pruneOldDays(keepDate: string): Promise<void> {
  const all = await keys();
  for (const k of all) {
    if (typeof k !== 'string') continue;
    const isOldTimetable = k.startsWith(KEY_PREFIX) && k !== keyFor(keepDate);
    const isOldSnapshot = k.startsWith(SNAPSHOT_PREFIX) && k !== snapshotKeyFor(keepDate);
    if (isOldTimetable || isOldSnapshot) await del(k);
  }
}
