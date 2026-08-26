import { useEffect, useRef, useState } from 'react';
import { updateTracks, type BusTrack } from '@/lib/transit/busTracks';
import { useLiveBuses } from './useLiveBuses';

export interface TrackedBuses {
  tracks: BusTrack[];
  /** Epoch ms the feed last answered, or 0 before the first response. */
  updatedAt: number;
}

/**
 * Live buses for one route, carrying their inferred heading and speed.
 *
 * The tracks live in a ref rather than in query state because they are history:
 * each poll is folded into what came before, and react-query only ever hands back
 * the latest snapshot.
 */
export function useTrackedBuses(routeCode: string | null): TrackedBuses {
  const { data, dataUpdatedAt } = useLiveBuses(routeCode);
  const history = useRef(new Map<string, BusTrack>());
  const trackedRoute = useRef(routeCode);
  const [tracks, setTracks] = useState<BusTrack[]>([]);

  useEffect(() => {
    if (trackedRoute.current !== routeCode) {
      // Another route's buses are not this route's history.
      trackedRoute.current = routeCode;
      history.current = new Map();
      setTracks([]);
    }
    if (!data) return;

    history.current = updateTracks(history.current, data, dataUpdatedAt || Date.now());
    setTracks([...history.current.values()]);
  }, [routeCode, data, dataUpdatedAt]);

  return { tracks, updatedAt: dataUpdatedAt };
}
