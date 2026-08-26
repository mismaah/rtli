import { LegTimeline } from '@/components/LegTimeline';
import { RouteChip } from '@/components/RouteChip';
import { formatClock, formatDuration } from '@/lib/time';
import { formatDistance } from '@/lib/geo';
import { totalDistanceM } from '@/lib/transit/plan';
import type { Itinerary } from '@/lib/transit/types';

interface Props {
  itinerary: Itinerary;
  liveApplied: boolean;
  onBack: () => void;
}

export function TripDetail({ itinerary, liveApplied, onBack }: Props) {
  const busLegs = itinerary.legs.filter((l) => l.kind === 'bus');

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-brand-400 active:bg-white/5"
      >
        <svg viewBox="0 0 24 24" className="size-5 fill-current" aria-hidden>
          <path d="M15.5 4.5 14 3l-9 9 9 9 1.5-1.5L8 12z" />
        </svg>
        All options
      </button>

      <header className="rounded-2xl border border-white/10 bg-ink-800/70 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-2xl font-semibold tabular-nums">
            {formatDuration(itinerary.arriveAt - itinerary.departAt)}
          </span>
          <span className="text-sm tabular-nums text-ink-300">
            {formatClock(itinerary.departAt)} – {formatClock(itinerary.arriveAt)}
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500">
          <span>
            {itinerary.transfers === 0
              ? 'Direct'
              : `${itinerary.transfers} transfer${itinerary.transfers > 1 ? 's' : ''}`}
          </span>
          <span>{formatDistance(totalDistanceM(itinerary))} total</span>
          <span>{formatDistance(itinerary.totalWalkM)} walking</span>
          {itinerary.totalFare > 0 && (
            <span className="font-medium text-ink-300">MVR {itinerary.totalFare.toFixed(2)}</span>
          )}
        </div>

        {busLegs.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {busLegs.map((leg, i) => leg.kind === 'bus' && <RouteChip key={i} route={leg.route} />)}
          </div>
        )}

        {itinerary.estimated && (
          <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            This trip uses a minibus route with no published timetable. Times are estimated from
            typical frequency, so treat them as a guide.
          </p>
        )}
        {!liveApplied && (
          <p className="mt-2 text-[11px] text-ink-500">Checking for live bus times…</p>
        )}
      </header>

      <LegTimeline itinerary={itinerary} />
    </div>
  );
}

/**
 * Pinned below the trip rather than placed within it: the timeline is as long as
 * the journey is, and the one thing a rider standing at a stop wants — to be
 * walked through it — should never be somewhere they have to scroll to find.
 */
export function StartJourneyBar({ onStart }: { onStart: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onStart}
        className="min-h-14 w-full rounded-2xl bg-brand-500 px-6 text-base font-semibold text-white shadow-lg shadow-brand-500/20 active:bg-brand-400"
      >
        Start journey
      </button>
      <p className="pt-2 text-center text-[11px] text-ink-500">
        Step-by-step directions that follow you as you go
      </p>
    </div>
  );
}
