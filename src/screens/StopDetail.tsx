import { useQuery } from '@tanstack/react-query';
import { fetchStopEtas } from '@/api/rtl';
import { parseEta } from '@/lib/transit/parseEta';
import { usePageVisible } from '@/hooks/usePageVisible';
import { usePrefs } from '@/store/prefs';
import { RouteChip } from '@/components/RouteChip';
import type { Stop, TransitGraph } from '@/lib/transit/types';

interface Props {
  stop: Stop;
  graph: TransitGraph;
  onClose: () => void;
  onRouteFrom: (stop: Stop) => void;
  onRouteTo: (stop: Stop) => void;
}

const POLL_MS = 20_000;

export function StopDetail({ stop, graph, onClose, onRouteFrom, onRouteTo }: Props) {
  const visible = usePageVisible();
  const showDhivehi = usePrefs((s) => s.showDhivehi);

  const { data: arrivals, isLoading } = useQuery({
    queryKey: ['rtl', 'stop-etas', stop.code, stop.routes],
    queryFn: async ({ signal }) => {
      const perRoute = await Promise.all(
        stop.routes.map(async (routeCode) => {
          try {
            const res = await fetchStopEtas(routeCode, signal);
            const rows = [
              ...(res.inboundStopsETAList ?? []),
              ...(res.outboundStopsETAList ?? []),
            ].filter((r) => r.stopCode === stop.code);

            return rows
              .map((r) => ({ routeCode, eta: parseEta(r.eta, r.vehicleCode), destination: r.destination }))
              .filter((r): r is { routeCode: string; eta: NonNullable<ReturnType<typeof parseEta>>; destination: string } => r.eta !== null);
          } catch {
            return [];
          }
        }),
      );
      return perRoute.flat().sort((a, b) => a.eta.minutes - b.eta.minutes);
    },
    enabled: visible,
    refetchInterval: visible ? POLL_MS : false,
    // Overrides the app-wide default: timers are throttled or stopped while the
    // phone is asleep, so the arrivals on screen when it wakes are however old
    // the nap was until this refetches them.
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-ink-100">{stop.name}</h2>
          {showDhivehi && stop.dvName && (
            <p className="dv truncate text-sm text-ink-300">{stop.dvName}</p>
          )}
          <p className="mt-0.5 text-xs text-ink-500">Stop {stop.code}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid size-10 shrink-0 place-items-center rounded-full text-ink-500 active:bg-white/10"
        >
          <svg viewBox="0 0 24 24" className="size-5 fill-current" aria-hidden>
            <path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z" />
          </svg>
        </button>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onRouteFrom(stop)}
          className="min-h-11 flex-1 rounded-xl border border-white/10 bg-ink-800 text-sm font-medium text-ink-100 active:bg-ink-700"
        >
          Start here
        </button>
        <button
          type="button"
          onClick={() => onRouteTo(stop)}
          className="min-h-11 flex-1 rounded-xl bg-brand-500 text-sm font-semibold text-white active:bg-brand-400"
        >
          Go here
        </button>
      </div>

      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
          Next buses
        </h3>

        {isLoading && <p className="text-sm text-ink-500">Checking live arrivals…</p>}

        {!isLoading && (arrivals?.length ?? 0) === 0 && (
          <p className="text-sm text-ink-500">
            No live arrivals reported for this stop right now.
          </p>
        )}

        <div className="overflow-hidden rounded-xl bg-ink-900">
          {arrivals?.map((a, i) => {
            const route = graph.routes.get(a.routeCode);
            if (!route) return null;
            return (
              <div
                key={`${a.routeCode}-${a.eta.vehicleCode}-${i}`}
                className="flex min-h-14 items-center gap-3 border-b border-white/5 px-3 py-2.5 last:border-0"
              >
                <RouteChip route={route} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink-100">{route.name}</span>
                  {a.destination && (
                    <span className="block truncate text-xs text-ink-500">
                      towards {a.destination}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-live-500">
                  {a.eta.minutes === 0 ? 'Now' : `${a.eta.minutes} min`}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
          Routes serving this stop
        </h3>
        <div className="flex flex-wrap gap-2">
          {stop.routes.map((code) => {
            const route = graph.routes.get(code);
            return route ? <RouteChip key={code} route={route} /> : null;
          })}
        </div>
      </section>
    </div>
  );
}
