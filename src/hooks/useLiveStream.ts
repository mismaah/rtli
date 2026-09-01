import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '@/config';
import { usePageVisible } from './usePageVisible';
import type { LiveBus } from '@/api/rtl';

/**
 * Live bus positions pushed from the backend, instead of polled.
 *
 * Measured, the upstream GPS feed advances each bus on a ~11 s cycle, so polling
 * faster collects nothing. What a stream buys is *promptness*: a 10 s poll sits
 * at a random phase against that cycle and is ~5.5 s stale on average, which at
 * the measured 64 m per update is roughly 30 m of error. The server polls
 * tightly on everyone's behalf and forwards each new fix within a second or so.
 *
 * The stream also arrives with headings and trails already inferred, which
 * polling cannot do: the client has to watch a bus travel 12 m across two polls
 * before it can draw an arrow, and it discards that history on every route
 * change.
 *
 * Results are written into the same react-query cache key `useLiveBuses` uses,
 * so `useTrackedBuses`, `BusMarkers` and `useBoardedBus` need no changes and
 * keep de-duplicating. When there is no backend, or the stream will not open,
 * `useLiveBuses` goes on polling exactly as before.
 */

/** Matches the server's snapshot payload. */
interface StreamTrack extends LiveBus {
  lat: number;
  lng: number;
}

interface SnapshotEvent {
  routeCode: string;
  tracks: StreamTrack[];
}

/** Server tracks carry lat/lng; the cache wants RTL's latitude/longitude. */
function toLiveBus(track: StreamTrack): LiveBus {
  return {
    busCode: track.busCode,
    plateNumber: track.plateNumber,
    latitude: track.lat,
    longitude: track.lng,
  };
}

/**
 * Which routes currently have a live stream feeding them.
 *
 * `useLiveBuses` reads this and stands its poll down for those routes, so the
 * two never both fetch the same positions. It is a module-level registry rather
 * than context because the reader and the writer sit in unrelated parts of the
 * tree, and because there is only ever one stream per tab.
 */
const streamedRoutes = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while a stream is delivering positions for this route. */
export function useIsStreamed(routeCode: string | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (routeCode !== null && streamedRoutes.has(routeCode)),
    () => false,
  );
}

export interface LiveStreamState {
  /** True while a stream is open and carrying this route. */
  streaming: boolean;
}

/**
 * Opens one SSE stream for the given routes.
 *
 * The stream is closed whenever the tab is backgrounded, matching how polling
 * already pauses: there is no reason to hold a connection open for a screen
 * nobody is looking at.
 */
export function useLiveStream(routeCodes: string[]): LiveStreamState {
  const queryClient = useQueryClient();
  const visible = usePageVisible();
  const streaming = useRef(false);

  // Sorted and joined so the effect re-runs on a real change of routes rather
  // than on every render that rebuilds the array.
  const key = [...routeCodes].sort().join(',');

  useEffect(() => {
    if (!API_BASE || !visible || key.length === 0) return;

    const source = new EventSource(`${API_BASE}/v1/live/stream?routes=${encodeURIComponent(key)}`);
    const routes = key.split(',');

    const writeBuses = (routeCode: string, update: (buses: LiveBus[]) => LiveBus[]) => {
      queryClient.setQueryData<LiveBus[]>(['rtl', 'livecoordinates', routeCode], (previous) =>
        update(previous ?? []),
      );
    };

    source.addEventListener('open', () => {
      streaming.current = true;
      for (const routeCode of routes) streamedRoutes.add(routeCode);
      notify();
    });

    source.addEventListener('snapshot', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent<string>).data) as SnapshotEvent;
        writeBuses(data.routeCode, () => data.tracks.map(toLiveBus));
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    });

    source.addEventListener('bus', (event) => {
      try {
        const track = JSON.parse((event as MessageEvent<string>).data) as StreamTrack;
        const bus = toLiveBus(track);
        // Which route this bus belongs to is not on the delta, so every
        // subscribed route is updated where it already knows the bus. Route
        // membership is stable, so this cannot move a bus between routes.
        for (const routeCode of routes) {
          writeBuses(routeCode, (buses) => {
            const index = buses.findIndex((b) => b.busCode === bus.busCode);
            if (index === -1) return buses;
            const next = buses.slice();
            next[index] = bus;
            return next;
          });
        }
      } catch {
        // Ignore.
      }
    });

    source.addEventListener('bus-gone', (event) => {
      try {
        const { busCode } = JSON.parse((event as MessageEvent<string>).data) as { busCode: string };
        for (const routeCode of routes) {
          writeBuses(routeCode, (buses) => buses.filter((b) => b.busCode !== busCode));
        }
      } catch {
        // Ignore.
      }
    });

    source.addEventListener('error', () => {
      // EventSource reconnects on its own. Releasing the routes here hands them
      // straight back to polling, so a dropped stream degrades to the old
      // behaviour within one poll rather than going quiet.
      streaming.current = false;
      for (const routeCode of routes) streamedRoutes.delete(routeCode);
      notify();
    });

    return () => {
      streaming.current = false;
      for (const routeCode of routes) streamedRoutes.delete(routeCode);
      notify();
      source.close();
    };
  }, [key, visible, queryClient]);

  return { streaming: streaming.current };
}
