import { useEffect, useMemo, useRef, useState } from 'react';
import Fuse from 'fuse.js';
import { searchPlaces } from '@/api/photon';
import { haversineMeters, type LatLng } from '@/lib/geo';
import type { Place, Stop, TransitGraph } from '@/lib/transit/types';

const PLACE_DEBOUNCE_MS = 350;

export function useStopIndex(graph: TransitGraph | undefined) {
  return useMemo(() => {
    const stops = graph ? [...graph.stops.values()] : [];
    return {
      stops,
      fuse: new Fuse(stops, {
        keys: [
          { name: 'name', weight: 3 },
          { name: 'dvName', weight: 2 },
          { name: 'code', weight: 1 },
        ],
        threshold: 0.35,
        ignoreLocation: true,
      }),
    };
  }, [graph]);
}

export function searchStops(
  index: { stops: Stop[]; fuse: Fuse<Stop> },
  query: string,
  limit = 8,
): Stop[] {
  const q = query.trim();
  if (!q) return [];
  return index.fuse.search(q, { limit }).map((r) => r.item);
}

export function nearestStops(stops: Stop[], from: LatLng, limit = 5): Stop[] {
  return [...stops]
    .map((s) => ({ s, d: haversineMeters(from, s) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.s);
}

/** Debounced, abortable Photon lookup. Stop search stays instant and local. */
export function usePlaceSearch(query: string): { places: Place[]; searching: boolean } {
  const [places, setPlaces] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = query.trim();
    controller.current?.abort();

    if (q.length < 2) {
      setPlaces([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    const ac = new AbortController();
    controller.current = ac;

    const timer = setTimeout(async () => {
      const results = await searchPlaces(q, ac.signal);
      if (ac.signal.aborted) return;
      setPlaces(results);
      setSearching(false);
    }, PLACE_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [query]);

  return { places, searching };
}
