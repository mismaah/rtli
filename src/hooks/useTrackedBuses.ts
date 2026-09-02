import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { BusTrack } from '@/lib/transit/busTracks';
import { commitTracks, readTracks, subscribeTracks } from '@/lib/transit/trackStore';
import { polylinesOf, snapToRoute } from '@/lib/transit/snapToRoute';
import { useRoadShape } from './useRoadShape';
import { useLiveBuses } from './useLiveBuses';

export interface TrackedBuses {
  tracks: BusTrack[];
  /** Epoch ms the feed last answered, or 0 before the first response. */
  updatedAt: number;
}

/**
 * Live buses for one route, corrected onto that route and carrying their
 * inferred heading and speed.
 *
 * The correction happens here, before any inference: a position pulled back onto
 * the road is also a steadier one, so the heading taken from it stops swinging
 * with the fix. See `snapToRoute` for how far a bus is allowed to be moved.
 *
 * The tracks live in `trackStore` rather than in query state because they are
 * history: each poll is folded into what came before, and react-query only ever
 * hands back the latest snapshot. Keeping that history outside the component is
 * also what lets a trail survive leaving a route and coming back to it.
 */
export function useTrackedBuses(routeCode: string | null): TrackedBuses {
  const { data, dataUpdatedAt } = useLiveBuses(routeCode);
  // The same query the route's shape layer draws from, so this costs no fetch.
  const { data: shape } = useRoadShape(routeCode);
  const tracks = useSyncExternalStore(
    useCallback((listener) => subscribeTracks(routeCode, listener), [routeCode]),
    useCallback(() => readTracks(routeCode), [routeCode]),
  );

  const lines = useMemo(() => polylinesOf(shape), [shape]);

  const corrected = useMemo(() => {
    if (!data || lines.length === 0) return data;
    return data.map((bus) => {
      if (!Number.isFinite(bus.latitude) || !Number.isFinite(bus.longitude)) return bus;
      const snapped = snapToRoute({ lat: bus.latitude, lng: bus.longitude }, lines);
      return { ...bus, latitude: snapped.lat, longitude: snapped.lng };
    });
  }, [data, lines]);

  useEffect(() => {
    if (!routeCode || !corrected) return;
    commitTracks(routeCode, corrected, dataUpdatedAt || Date.now());
  }, [routeCode, corrected, dataUpdatedAt]);

  return { tracks, updatedAt: dataUpdatedAt };
}
