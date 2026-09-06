import { formatClock, formatDuration } from '@/lib/time';
import { formatDistance } from '@/lib/geo';
import { formatEta } from '@/lib/transit/parseEta';
import { Dv, placeSecondary, placeText, stopSecondary, stopText, routeText, useT } from '@/i18n';
import type { T } from '@/i18n';
import type { Itinerary, Leg, TransitGraph } from '@/lib/transit/types';
import { RouteChip } from './RouteChip';

/** Vertical step-by-step breakdown of a single itinerary. */
export function LegTimeline({
  itinerary,
  graph,
}: {
  itinerary: Itinerary;
  graph: TransitGraph;
}) {
  const { t, lang } = useT();

  return (
    <ol className="relative space-y-1 ps-1">
      {itinerary.legs.map((leg, i) => (
        <li key={i} className="relative flex gap-3">
          <Rail leg={leg} last={i === itinerary.legs.length - 1} />
          <div className="min-w-0 flex-1 pb-5">
            {leg.kind === 'walk' ? (
              <div>
                <div className="text-sm font-medium text-ink-100">
                  {t('walkTo', { name: placeText(leg.to, lang, graph, t) })}
                </div>
                {placeSecondary(leg.to, lang, graph) ? (
                  <Dv className="mt-0.5 block truncate text-xs text-ink-300">
                    {placeSecondary(leg.to, lang, graph)}
                  </Dv>
                ) : null}
                <div className="mt-0.5 text-xs text-ink-500">
                  {t('distanceAbout', {
                    dist: formatDistance(leg.meters, t),
                    duration: formatDuration(leg.seconds / 60, t),
                  })}
                </div>
              </div>
            ) : (
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <RouteChip route={leg.route} />
                  <span className="text-sm font-medium text-ink-100">
                    {routeText(leg.route, lang)}
                  </span>
                </div>

                <div className="mt-2 rounded-xl border border-white/10 bg-ink-800/60 p-3">
                  <Endpoint
                    time={formatClock(leg.departAt)}
                    label={t('board')}
                    name={stopText(leg.boardStop, lang)}
                    dv={stopSecondary(leg.boardStop, lang)}
                  />
                  <div className="my-2 flex items-center gap-2 ps-14 text-xs text-ink-500">
                    <span className="h-px flex-1 bg-white/10" />
                    {t('legSummary', {
                      stops: stopCount(leg.numStops, t),
                      dist: formatDistance(leg.meters, t),
                      duration: formatDuration(leg.arriveAt - leg.departAt, t),
                    })}
                    <span className="h-px flex-1 bg-white/10" />
                  </div>
                  <Endpoint
                    time={formatClock(leg.arriveAt)}
                    label={t('getOff')}
                    name={stopText(leg.alightStop, lang)}
                    dv={stopSecondary(leg.alightStop, lang)}
                  />
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className="text-ink-500">
                    {t('fare', { amount: leg.fare.toFixed(2) })}
                  </span>
                  {leg.liveEta && (
                    <span className="inline-flex items-center gap-1 font-medium text-live-500">
                      <span className="size-1.5 animate-pulse rounded-full bg-live-500" />
                      {formatEta(leg.liveEta, t)}
                      {leg.liveEta.vehicleCode
                        ? ` · ${t('busNumbered', { code: leg.liveEta.vehicleCode })}`
                        : ''}
                    </span>
                  )}
                  {leg.estimated && (
                    <span className="text-amber-300">{t('noTimetableEstimated')}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** English needs the plural, Dhivehi does not — so the choice is a key, not an `s`. */
export function stopCount(n: number, t: T): string {
  return t(n > 1 ? 'stopsMany' : 'stopsOne', { n });
}

function Endpoint({
  time,
  label,
  name,
  dv,
}: {
  time: string;
  label: string;
  name: string;
  dv?: string;
}) {
  return (
    <div className="flex gap-3">
      <span className="w-11 shrink-0 text-sm font-semibold tabular-nums text-ink-100">{time}</span>
      <span className="min-w-0">
        <span className="block text-[11px] uppercase tracking-wide text-ink-500">{label}</span>
        <span className="block truncate text-sm text-ink-100">{name}</span>
        {dv ? <Dv className="block truncate text-xs text-ink-300">{dv}</Dv> : null}
      </span>
    </div>
  );
}

function Rail({ leg, last }: { leg: Leg; last: boolean }) {
  const color = leg.kind === 'bus' ? leg.route.color : '#64748b';
  return (
    <div className="flex w-4 shrink-0 flex-col items-center pt-1.5">
      <span
        className="size-3 shrink-0 rounded-full ring-2 ring-ink-900"
        style={{ background: color }}
      />
      {!last && (
        <span
          className="mt-1 w-0.5 flex-1"
          style={
            leg.kind === 'walk'
              ? {
                  backgroundImage: `repeating-linear-gradient(to bottom, ${color} 0 4px, transparent 4px 8px)`,
                }
              : { background: color }
          }
        />
      )}
    </div>
  );
}
