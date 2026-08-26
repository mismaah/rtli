/**
 * Hits all four RTL endpoints for every Greater Malé route.
 *
 * RTL's API is unversioned and undocumented, so this exists to catch upstream
 * shape drift — a renamed field or a route that stops reporting — before it turns
 * into a blank screen. Run with `pnpm smoke`.
 */
const BASE = 'https://bo.rtl.mv:4455/maldives/api';

interface RouteRow {
  code: string;
  routeNumber: string;
  name: string;
  depotName: string | null;
  busRouteStopList: { code: string; timings: unknown[] | null }[] | null;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const problems: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) problems.push(message);
}

const details = (await (await fetch(`${BASE}/booking/v2/bus/routedetails`)).json()) as {
  routeResponse: RouteRow[] | null;
};

const routes = (details.routeResponse ?? []).filter((r) => r.depotName?.includes('Male'));
console.log(`routedetails: ${routes.length} Greater Malé routes`);
check(routes.length === 15, `expected 15 Greater Malé routes, got ${routes.length}`);

const stopCodes = new Set<string>();
for (const r of routes) for (const s of r.busRouteStopList ?? []) stopCodes.add(s.code);
console.log(`             ${stopCodes.size} unique stops`);
check(stopCodes.size === 101, `expected 101 unique stops, got ${stopCodes.size}`);

console.log('\nroute            stops  sched  shape   buses  etas');
for (const route of routes) {
  const stops = route.busRouteStopList ?? [];
  const scheduled = stops.filter((s) => (s.timings ?? []).length > 0).length;

  const [shape, live, etas] = await Promise.all([
    post<{ roadShape: { features?: unknown[] } | null }>('/booking/v2/bus/roadshape', {
      routeCode: route.code,
    }).catch(() => null),
    post<{ busList: unknown[] | null }>('/booking/v1/bus/livecoordinates', {
      routeCode: route.code,
    }).catch(() => null),
    post<{ inboundStopsETAList: unknown[] | null }>('/gps-engine/eta/all-stops-of-route', {
      routeCode: route.code,
    }).catch(() => null),
  ]);

  const features = shape?.roadShape?.features?.length ?? 0;
  check(features > 0, `${route.routeNumber}: roadshape returned no geometry`);
  check(stops.length >= 2, `${route.routeNumber}: fewer than 2 stops`);

  console.log(
    `${route.routeNumber.padEnd(5)} ${route.code.padEnd(6)} ` +
      `${String(stops.length).padStart(5)}  ${String(scheduled).padStart(5)}  ` +
      `${String(features).padStart(5)}  ${String(live?.busList?.length ?? 0).padStart(5)}  ` +
      `${String(etas?.inboundStopsETAList?.length ?? 0).padStart(4)}`,
  );
}

// R10/R11/R12/R15 legitimately publish no timetable; anything else losing its
// schedule means the planner has quietly started guessing.
const FREQUENCY_ROUTES = new Set(['R10', 'R11', 'R12', 'R15']);
for (const route of routes) {
  const scheduled = (route.busRouteStopList ?? []).filter(
    (s) => (s.timings ?? []).length > 0,
  ).length;
  if (!FREQUENCY_ROUTES.has(route.routeNumber) && scheduled === 0) {
    problems.push(`${route.routeNumber} unexpectedly has no timetable at any stop`);
  }
}

console.log(
  problems.length === 0
    ? '\nAll checks passed.'
    : `\n${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join('\n'),
);
process.exit(problems.length === 0 ? 0 : 1);
