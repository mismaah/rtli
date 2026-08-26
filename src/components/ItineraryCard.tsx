import { Fragment } from 'react';
import { formatClock, formatDuration } from '@/lib/time';
import { formatDistance } from '@/lib/geo';
import { totalDistanceM } from '@/lib/transit/plan';
import type { Itinerary } from '@/lib/transit/types';
import { RouteChip } from './RouteChip';

interface Props {
  itinerary: Itinerary;
  onSelect: () => void;
}

export function ItineraryCard({ itinerary, onSelect }: Props) {
  const duration = itinerary.arriveAt - itinerary.departAt;
  const busLegs = itinerary.legs.filter((l) => l.kind === 'bus');
  const firstBus = busLegs[0];
  const live = firstBus?.kind === 'bus' ? firstBus.liveEta : undefined;

  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full rounded-2xl border border-white/10 bg-ink-800/70 p-4 text-left transition-colors active:bg-ink-700/70"
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-2xl font-semibold tabular-nums">{formatDuration(duration)}</div>
        <div className="text-sm tabular-nums text-ink-300">
          {formatClock(itinerary.departAt)} – {formatClock(itinerary.arriveAt)}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {itinerary.legs.map((leg, i) => (
          <Fragment key={i}>
            {i > 0 && <span aria-hidden className="text-ink-500">›</span>}
            {leg.kind === 'bus' ? (
              <RouteChip route={leg.route} size="sm" />
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] text-ink-300">
                <WalkIcon />
                {formatDistance(leg.meters)}
              </span>
            )}
          </Fragment>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
        <span>
          {itinerary.transfers === 0
            ? busLegs.length === 0
              ? 'Walk the whole way'
              : 'Direct'
            : `${itinerary.transfers} transfer${itinerary.transfers > 1 ? 's' : ''}`}
        </span>
        {itinerary.totalFare > 0 && (
          <span className="font-medium text-ink-300">MVR {itinerary.totalFare.toFixed(2)}</span>
        )}
        <span>{formatDistance(totalDistanceM(itinerary))}</span>
        <span>{formatDistance(itinerary.totalWalkM)} walk</span>

        {live && (
          <span className="inline-flex items-center gap-1 font-medium text-live-500">
            <span className="size-1.5 animate-pulse rounded-full bg-live-500" />
            {live.minutes === 0 ? 'Arriving now' : `Next in ${live.minutes} min`}
          </span>
        )}
        {itinerary.estimated && (
          <span
            className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-300"
            title="This route has no published timetable, so times are estimated from typical frequency."
          >
            Estimated
          </span>
        )}
      </div>
    </button>
  );
}

function WalkIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3 fill-current" aria-hidden>
      <path d="M13.5 5.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM9.8 8.9 7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3A6.9 6.9 0 0 0 19 13v-2a4.9 4.9 0 0 1-4.1-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5 0-.8.2L6 7.5V12h2V8.8l1.8-.7Z" />
    </svg>
  );
}
