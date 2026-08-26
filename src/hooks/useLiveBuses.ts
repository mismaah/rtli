import { useQuery } from '@tanstack/react-query';
import { fetchLiveCoordinates, type LiveBus } from '@/api/rtl';
import { usePageVisible } from './usePageVisible';

const POLL_MS = 10_000;

/**
 * Live bus positions for one route.
 *
 * Polling only runs while the tab is in the foreground; RTL is a small public
 * service and there is no reason to poll a screen nobody is looking at.
 */
export function useLiveBuses(routeCode: string | null, enabled = true) {
  const visible = usePageVisible();

  return useQuery<LiveBus[]>({
    queryKey: ['rtl', 'livecoordinates', routeCode],
    queryFn: async ({ signal }) => {
      const res = await fetchLiveCoordinates(routeCode!, signal);
      return res.busList ?? [];
    },
    enabled: Boolean(routeCode) && enabled && visible,
    refetchInterval: visible ? POLL_MS : false,
    refetchIntervalInBackground: false,
    staleTime: 0,
    gcTime: 0,
    retry: 1,
  });
}
