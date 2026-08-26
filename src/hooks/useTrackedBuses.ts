import { useEffect, useMemo, useRef, useState } from 'react';
import { updateTracks, type BusTrack } from '@/lib/transit/busTracks';
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
 * The tracks live in a ref rather than in query state because they are history:
 * each poll is folded into what came before, and react-query only ever hands back
 * the latest snapshot.
 */
export function useTrackedBuses(routeCode: string | null): TrackedBuses {
  const { data, dataUpdatedAt } = useLiveBuses(routeCode);
  // The same query the route's shape layer draws from, so this costs no fetch.
  const { data: shape } = useRoadShape(routeCode);
  const history = useRef(new Map<string, BusTrack>());
  const trackedRoute = useRef(routeCode);
  const [tracks, setTracks] = useState<BusTrack[]>([]);

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
    if (trackedRoute.current !== routeCode) {
      // Another route's buses are not this route's history.
      trackedRoute.current = routeCode;
      history.current = new Map();
      setTracks([]);
    }
    if (!corrected) return;

    history.current = updateTracks(history.current, corrected, dataUpdatedAt || Date.now());
    setTracks([...history.current.values()]);
  }, [routeCode, corrected, dataUpdatedAt]);

  return { tracks, updatedAt: dataUpdatedAt };
}
