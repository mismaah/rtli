import { formatClock, formatDuration } from '@/lib/time';
import { formatDistance } from '@/lib/geo';
import { usePrefs } from '@/store/prefs';
import type { Itinerary, Leg } from '@/lib/transit/types';
import { RouteChip } from './RouteChip';

/** Vertical step-by-step breakdown of a single itinerary. */
export function LegTimeline({ itinerary }: { itinerary: Itinerary }) {
  const showDhivehi = usePrefs((s) => s.showDhivehi);

  return (
    <ol className="relative space-y-1 pl-1">
      {itinerary.legs.map((leg, i) => (
        <li key={i} className="relative flex gap-3">
          <Rail leg={leg} last={i === itinerary.legs.length - 1} />
          <div className="min-w-0 flex-1 pb-5">
            {leg.kind === 'walk' ? (
              <div>
                <div className="text-sm font-medium text-ink-100">Walk to {leg.to.name}</div>
                <div className="mt-0.5 text-xs text-ink-500">
                  {formatDistance(leg.meters)} · about {formatDuration(leg.seconds / 60)}
                </div>
              </div>
            ) : (
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <RouteChip route={leg.route} />
                  <span className="text-sm font-medium text-ink-100">{leg.route.name}</span>
                </div>

                <div className="mt-2 rounded-xl border border-white/10 bg-ink-800/60 p-3">
                  <Endpoint
                    time={formatClock(leg.departAt)}
                    label="Board"
                    name={leg.boardStop.name}
                    dv={showDhivehi ? leg.boardStop.dvName : undefined}
                  />
                  <div className="my-2 flex items-center gap-2 pl-14 text-xs text-ink-500">
                    <span className="h-px flex-1 bg-white/10" />
                    {leg.numStops} stop{leg.numStops > 1 ? 's' : ''} ·{' '}
                    {formatDistance(leg.meters)} · {formatDuration(leg.arriveAt - leg.departAt)}
                    <span className="h-px flex-1 bg-white/10" />
                  </div>
                  <Endpoint
                    time={formatClock(leg.arriveAt)}
                    label="Get off"
                    name={leg.alightStop.name}
                    dv={showDhivehi ? leg.alightStop.dvName : undefined}
                  />
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className="text-ink-500">MVR {leg.fare.toFixed(2)}</span>
                  {leg.liveEta && (
                    <span className="inline-flex items-center gap-1 font-medium text-live-500">
                      <span className="size-1.5 animate-pulse rounded-full bg-live-500" />
                      {leg.liveEta.label}
                      {leg.liveEta.vehicleCode ? ` · bus ${leg.liveEta.vehicleCode}` : ''}
                    </span>
                  )}
                  {leg.estimated && (
                    <span className="text-amber-300">No published timetable — estimated</span>
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
        {dv ? <span className="dv block truncate text-xs text-ink-300">{dv}</span> : null}
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
