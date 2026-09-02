import { useQuery } from '@tanstack/react-query';
import { fetchLiveCoordinates } from '@/api/rtl';
import type { TrackedBus } from '@/lib/transit/busTracks';
import { usePageVisible } from './usePageVisible';
import { useIsStreamed } from './useLiveStream';

const POLL_MS = 10_000;

/**
 * Live bus positions for one route.
 *
 * Polling only runs while the tab is in the foreground; RTL is a small public
 * service and there is no reason to poll a screen nobody is looking at.
 *
 * It also stands down entirely while a live stream is feeding this route, since
 * the stream writes into this same cache key. Polling resumes by itself if the
 * stream drops, so losing the backend costs at most one poll interval.
 */
export function useLiveBuses(routeCode: string | null, enabled = true) {
  const visible = usePageVisible();
  const streamed = useIsStreamed(routeCode);

  // `TrackedBus`, not `LiveBus`: the stream writes into this same key and its
  // positions arrive with the server's own heading and trail attached. A poll's
  // buses simply carry none, which is the shape's optional half.
  return useQuery<TrackedBus[]>({
    queryKey: ['rtl', 'livecoordinates', routeCode],
    queryFn: async ({ signal }) => {
      const res = await fetchLiveCoordinates(routeCode!, signal);
      return res.busList ?? [];
    },
    enabled: Boolean(routeCode) && enabled && visible && !streamed,
    refetchInterval: visible && !streamed ? POLL_MS : false,
    refetchIntervalInBackground: false,
    staleTime: 0,
    gcTime: 0,
    retry: 1,
  });
}
