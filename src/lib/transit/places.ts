import type { LatLng } from '@/lib/geo';
import type { Place, TransitGraph } from './types';

/**
 * How a place is named, compared and put in a URL.
 *
 * Three kinds of place reach the planner and they are not equally identifiable:
 * a bus stop has a code, an address from search has coordinates, and "my
 * location" is not a fixed point at all — it is wherever the rider happens to be
 * standing. Treating that last one as its coordinates is what put the same trip
 * in the recents list once per city block, so it gets an identity of its own.
 */

export const MY_LOCATION_NAME = 'My location';

export function currentLocation(position: LatLng): Place {
  return { name: MY_LOCATION_NAME, lat: position.lat, lng: position.lng, current: true };
}

/**
 * Stable identity for a place, for de-duplicating and comparing.
 *
 * Coordinates are rounded to ~11 m: two searches for the same address can differ
 * in the last decimal, and nothing in this app distinguishes points that close.
 */
export function placeKey(place: Place): string {
  if (place.current) return 'me';
  if (place.stopCode) return `stop:${place.stopCode}`;
  return `${place.lat.toFixed(4)},${place.lng.toFixed(4)}`;
}

export function samePlace(a: Place, b: Place): boolean {
  return placeKey(a) === placeKey(b);
}

/** A place as it appears in the URL. Round-trips through `parsePlaceRef`. */
export function encodePlace(place: Place): string {
  if (place.current) return 'me';
  if (place.stopCode) return `stop:${place.stopCode}`;
  return `${place.lat.toFixed(5)},${place.lng.toFixed(5)},${place.name}`;
}

/**
 * What a URL asked for, before anything is known about it.
 *
 * A shared link names a stop by its code and the rider by `me`; neither can be
 * turned into a point until the timetable has loaded or the browser has answered
 * with a fix. Parsing is therefore separate from resolving, so a link can be read
 * on the first render and honoured whenever its ingredients turn up.
 */
export type PlaceRef =
  | { kind: 'current' }
  | { kind: 'stop'; code: string }
  | { kind: 'point'; place: Place };

export function parsePlaceRef(raw: string | undefined | null): PlaceRef | null {
  const value = raw?.trim();
  if (!value) return null;
  if (value === 'me') return { kind: 'current' };
  if (value.startsWith('stop:')) {
    const code = value.slice(5).trim();
    return code ? { kind: 'stop', code } : null;
  }

  // `lat,lng,name` — the name is the remainder, so commas in it survive.
  const first = value.indexOf(',');
  const second = value.indexOf(',', first + 1);
  if (first < 0) return null;
  const lat = Number(value.slice(0, first));
  const lng = Number(second < 0 ? value.slice(first + 1) : value.slice(first + 1, second));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  const name = second < 0 ? '' : value.slice(second + 1).trim();
  return { kind: 'point', place: { name: name || 'Dropped pin', lat, lng } };
}

/** Null while the reference cannot be honoured yet — not "no such place". */
export function resolvePlaceRef(
  ref: PlaceRef,
  graph: TransitGraph | undefined,
  position: LatLng | null,
): Place | null {
  if (ref.kind === 'point') return ref.place;
  if (ref.kind === 'current') return position ? currentLocation(position) : null;

  const stop = graph?.stops.get(ref.code);
  return stop ? { name: stop.name, lat: stop.lat, lng: stop.lng, stopCode: stop.code } : null;
}

/** True when this reference can never resolve, so waiting on it is pointless. */
export function isUnresolvable(ref: PlaceRef, graph: TransitGraph | undefined): boolean {
  return ref.kind === 'stop' && graph !== undefined && !graph.stops.has(ref.code);
}
