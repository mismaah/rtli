export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_000;

/**
 * Real footpaths are longer than the crow flies. 1.35 is a common urban
 * detour factor and matches Malé's dense grid reasonably well.
 */
export const WALK_DETOUR_FACTOR = 1.35;
/** ~4.9 km/h — an unhurried adult pace. */
export const WALK_SPEED_MPS = 1.35;
/** Fixed overhead for crossing roads / finding the stop pole. */
export const WALK_OVERHEAD_SEC = 15;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Initial bearing from `a` to `b`, in compass degrees clockwise from north.
 *
 * RTL's live feed reports position only, never heading, so a bus's direction is
 * inferred from where it was on an earlier poll. Callers must gate this on a
 * meaningful distance — over a few metres of GPS jitter the answer is noise.
 */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLng = (b.lng - a.lng) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (((Math.atan2(y, x) / rad) % 360) + 360) % 360;
}

const COMPASS = [
  'north', 'north-east', 'east', 'south-east',
  'south', 'south-west', 'west', 'north-west',
] as const;

/** 45 -> "north-east". Eight points is as precise as an inferred heading deserves. */
export function compassPoint(degrees: number): string {
  const normalized = ((degrees % 360) + 360) % 360;
  return COMPASS[Math.round(normalized / 45) % 8];
}

/** Straight-line distance inflated by the detour factor. */
export function walkMeters(a: LatLng, b: LatLng): number {
  return haversineMeters(a, b) * WALK_DETOUR_FACTOR;
}

/**
 * Walking time in seconds for a given already-detoured distance.
 * Isolated here so it can be swapped for a real routing API later without
 * touching the planner.
 */
export function walkSeconds(meters: number): number {
  if (meters <= 0) return 0;
  return Math.round(meters / WALK_SPEED_MPS + WALK_OVERHEAD_SEC);
}

export function formatDistance(meters: number): string {
  const m = Math.round(meters);
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Douglas–Peucker on [lng, lat] pairs. Keeps route shapes light on mobile. */
export function simplifyLine(points: [number, number][], epsilon = 1e-5): [number, number][] {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let index = 0;
  const [start] = points;
  const end = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], start, end);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }

  if (maxDist <= epsilon) return [start, end];

  const left = simplifyLine(points.slice(0, index + 1), epsilon);
  const right = simplifyLine(points.slice(index), epsilon);
  return [...left.slice(0, -1), ...right];
}

function perpendicularDistance(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
  const clamped = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + clamped * dx), p[1] - (a[1] + clamped * dy));
}

export function boundsOf(points: LatLng[]): [[number, number], [number, number]] | null {
  if (points.length === 0) return null;
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return [[minLng, minLat], [maxLng, maxLat]];
}
