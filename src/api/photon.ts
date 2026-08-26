import type { Place } from '@/lib/transit/types';

/**
 * Photon (Komoot's OpenStreetMap geocoder): free, no API key, CORS-open.
 * Results are biased towards Malé so local landmarks outrank global namesakes.
 */
const PHOTON_URL = 'https://photon.komoot.io/api';
const MALE_CENTER = { lat: 4.1755, lng: 73.5093 };

/** Greater Malé plus a margin, so far-flung matches are dropped. */
const BBOX = { minLat: 4.1, maxLat: 4.3, minLng: 73.4, maxLng: 73.6 };

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, string | undefined>;
}

export async function searchPlaces(
  query: string,
  signal?: AbortSignal,
  limit = 6,
): Promise<Place[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const url = new URL(PHOTON_URL);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(limit * 3));
  url.searchParams.set('lat', String(MALE_CENTER.lat));
  url.searchParams.set('lon', String(MALE_CENTER.lng));

  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return [];
    const data = (await res.json()) as { features?: PhotonFeature[] };

    const places: Place[] = [];
    for (const f of data.features ?? []) {
      const coords = f.geometry?.coordinates;
      if (!coords) continue;
      const [lng, lat] = coords;
      if (lat < BBOX.minLat || lat > BBOX.maxLat || lng < BBOX.minLng || lng > BBOX.maxLng) {
        continue;
      }
      const p = f.properties ?? {};
      const name = p.name ?? p.street ?? p.city;
      if (!name) continue;
      places.push({ name, lat, lng, });
      if (places.length >= limit) break;
    }
    return places;
  } catch {
    // Offline or blocked: stop search alone still works.
    return [];
  }
}

/** Secondary line for a result, e.g. "Maafannu, Malé". */
export function describePlace(p: Record<string, string | undefined>): string {
  return [p.district, p.city, p.state].filter(Boolean).join(', ');
}
