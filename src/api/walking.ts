import { haversineMeters, type LatLng } from '@/lib/geo';

/**
 * Pedestrian routing, from FOSSGIS's public OSRM — the same foot router
 * openstreetmap.org offers. No key, CORS-open, and run on donated hardware
 * under a fair-use policy, so callers cache every answer indefinitely and route
 * only the one trip a rider has actually opened.
 *
 * Straight-line distance times a detour factor is good enough to rank
 * itineraries, but not to tell someone which way to walk: in Malé the crow-flies
 * line runs through the middle of a block as often as not.
 */
const OSRM_FOOT_URL = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot';

/**
 * OSRM answers for the nearest routable point, not the point it was asked
 * about. Past this the drawn path would visibly begin somewhere other than the
 * stop, which is worse than showing no path at all.
 */
const MAX_SNAP_M = 150;

/**
 * A path allowed to be three times the crow flies, plus a fixed allowance so a
 * short hop can still go the long way round a block. Beyond that OSM is missing
 * a footway rather than the walk really being that far, and the estimate the
 * planner already made is the better answer.
 */
const MAX_DETOUR_RATIO = 3;
const DETOUR_ALLOWANCE_M = 300;

export interface WalkPath {
  /** `[lng, lat]` along real footways, origin first. */
  coordinates: [number, number][];
  /** Distance along that path, in metres. */
  meters: number;
}

interface OsrmRoute {
  distance?: number;
  geometry?: { coordinates?: [number, number][] };
}
interface OsrmResponse {
  code?: string;
  routes?: OsrmRoute[];
  waypoints?: { distance?: number }[];
}

/**
 * The walking path between two points, or null when there isn't a usable one.
 *
 * Null means the router answered and its answer cannot be trusted for these
 * points; a network or server failure throws instead, so a transient outage is
 * retried rather than cached as "no path exists".
 */
export async function fetchWalkPath(
  from: LatLng,
  to: LatLng,
  signal?: AbortSignal,
): Promise<WalkPath | null> {
  const url =
    `${OSRM_FOOT_URL}/${lngLat(from)};${lngLat(to)}` +
    '?overview=full&geometries=geojson&alternatives=false&steps=false';

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Walking router returned ${res.status}`);
  const data = (await res.json()) as OsrmResponse;

  // `NoRoute` / `NoSegment`: nothing walkable here, which is an answer.
  if (data.code !== 'Ok') return null;

  const route = data.routes?.[0];
  const coordinates = route?.geometry?.coordinates;
  const meters = route?.distance;
  if (!coordinates || coordinates.length < 2 || typeof meters !== 'number') return null;

  if ((data.waypoints ?? []).some((w) => (w.distance ?? 0) > MAX_SNAP_M)) return null;
  if (meters > haversineMeters(from, to) * MAX_DETOUR_RATIO + DETOUR_ALLOWANCE_M) return null;

  return { coordinates, meters };
}

function lngLat(p: LatLng): string {
  return `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`;
}
