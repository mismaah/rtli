import type { ReactNode } from 'react';
import { RouteChip } from '@/components/RouteChip';
import { useNowMinutes } from '@/hooks/useNowMinutes';
import { formatDistance, type LatLng } from '@/lib/geo';
import { formatClock, formatDuration } from '@/lib/time';
import { journeyFraction, stopsRemaining, type JourneyStep } from '@/lib/transit/journey';
import { totalDistanceM } from '@/lib/transit/plan';
import { usePrefs } from '@/store/prefs';
import type { Journey } from '@/hooks/useJourney';
import type { Itinerary, Stop } from '@/lib/transit/types';

interface Props {
  itinerary: Itinerary;
  journey: Journey;
  /** The stops the rider is aboard for on the current ride, board to alight. */
  rideStops: Stop[];
  position: (LatLng & { accuracy?: number }) | null;
  liveApplied: boolean;
  onExit: () => void;
}

/**
 * The journey as it is being made, one instruction at a time.
 *
 * Everything a rider needs while moving is one thing: what to do now. The plan
 * they chose is still underneath, but a step-by-step screen is read at a
 * junction, on a pavement, in the sun, so this shows the current instruction at
 * a size that survives all three, the action that completes it as a thumb-sized
 * button pinned to the bottom, and one line of what comes after it — enough to
 * know the shape of the next few minutes without reading the whole trip again.
 */
export function JourneyNav({
  itinerary,
  journey,
  rideStops,
  position,
  liveApplied,
  onExit,
}: Props) {
  const now = useNowMinutes();
  const { step, steps, index, progress, startedAt, finished } = journey;
  if (!step) return null;

  const next = steps[index + 1];
  const minutesLeft = Math.max(0, Math.round(itinerary.arriveAt - now));
  const elapsed = startedAt == null ? null : Math.max(0, Math.round(now - startedAt));

  return (
    <div className="space-y-4 pb-2">
      <div className="flex min-h-11 items-center justify-between gap-3">
        {finished ? (
          <span />
        ) : (
          <button
            type="button"
            onClick={onExit}
            className="-ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-ink-300 active:bg-white/5"
          >
            <CloseIcon />
            End journey
          </button>
        )}
        <span className="text-xs tabular-nums text-ink-500">
          Step {index + 1} of {steps.length}
        </span>
      </div>

      <div className="h-1 overflow-hidden rounded-full bg-white/10" aria-hidden>
        <div
          className="h-full rounded-full bg-brand-400 transition-[width] duration-500"
          style={{ width: `${journeyFraction(steps, index) * 100}%` }}
        />
      </div>

      {!finished && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-ink-500">
          <span className="tabular-nums text-ink-300">
            Arriving {formatClock(itinerary.arriveAt)}
          </span>
          <span className="tabular-nums">
            {minutesLeft === 0 ? 'any moment' : `${formatDuration(minutesLeft)} to go`}
          </span>
          {elapsed != null && elapsed > 0 && (
            <span className="tabular-nums">{formatDuration(elapsed)} in</span>
          )}
        </div>
      )}

      <Instruction
        step={step}
        progress={progress}
        rideStops={rideStops}
        position={position}
        itinerary={itinerary}
        elapsed={elapsed}
        liveApplied={liveApplied}
      />

      {next && (
        <p className="text-xs text-ink-500">
          <span className="uppercase tracking-wide text-ink-500">Then</span>{' '}
          <span className="text-ink-300">{summarise(next)}</span>
        </p>
      )}

    </div>
  );
}

/**
 * What completes the step the rider is on, as the sheet's own footer — the same
 * thumb-sized target in the same place every time, whatever the instruction is.
 *
 * Only walking completes itself, so this button is how the journey actually
 * moves; the undo beneath it is for the stop that went past while the rider was
 * looking at their phone.
 */
export function JourneyActionBar({
  journey,
  onExit,
}: {
  journey: Journey;
  onExit: () => void;
}) {
  const { step, index, finished } = journey;
  if (!step) return null;

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={finished ? onExit : journey.advance}
        className="min-h-14 w-full rounded-2xl bg-brand-500 px-6 text-base font-semibold text-white shadow-lg shadow-brand-500/20 active:bg-brand-400"
      >
        {actionLabel(step)}
      </button>
      {index > 0 && (
        <button
          type="button"
          onClick={journey.rewind}
          className="min-h-11 w-full rounded-xl text-xs font-medium text-ink-500 active:bg-white/5"
        >
          Went too far? Back a step
        </button>
      )}
    </div>
  );
}

function Instruction({
  step,
  progress,
  rideStops,
  position,
  itinerary,
  elapsed,
  liveApplied,
}: {
  step: JourneyStep;
  progress: Journey['progress'];
  rideStops: Stop[];
  position: LatLng | null;
  itinerary: Itinerary;
  elapsed: number | null;
  liveApplied: boolean;
}) {
  const showDhivehi = usePrefs((s) => s.showDhivehi);
  const away =
    progress.metersToTarget == null || progress.atTarget
      ? null
      : `${formatDistance(progress.metersToTarget)} away`;

  if (step.kind === 'arrive') {
    return (
      <section className="rounded-2xl border border-live-500/30 bg-live-500/10 p-5 text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-full bg-live-500/20">
          <TickIcon />
        </div>
        <h2 className="mt-3 text-xl font-semibold text-ink-100">
          You have reached your destination
        </h2>
        <p className="mt-1 text-sm text-ink-300">{step.targetName}</p>
        <div className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-ink-500">
          {elapsed != null && elapsed > 0 && <span>Took {formatDuration(elapsed)}</span>}
          <span>{formatDistance(totalDistanceM(itinerary))} travelled</span>
          <span>{formatDistance(itinerary.totalWalkM)} walked</span>
          {itinerary.totalFare > 0 && <span>MVR {itinerary.totalFare.toFixed(2)} fare</span>}
        </div>
      </section>
    );
  }

  if (step.kind === 'walk') {
    const walk = step.walk;
    return (
      <section className="rounded-2xl border border-white/10 bg-ink-800/70 p-4">
        <Eyebrow icon={<WalkIcon />} text="Walk" />
        <h2 className="mt-2 text-xl font-semibold leading-tight text-ink-100">
          Walk to {step.targetName}
        </h2>
        <p className="mt-1 text-sm text-ink-300">
          {walk ? `${formatDistance(walk.meters)} · about ${formatDuration(walk.seconds / 60)}` : ''}
        </p>
        <Distance away={away} atTarget={progress.atTarget} known={position !== null} />
        {progress.atTarget && (
          <p className="mt-3 rounded-lg bg-live-500/10 px-3 py-2 text-xs text-live-500">
            You're there. Moving you on…
          </p>
        )}
      </section>
    );
  }

  const bus = step.bus;
  if (!bus) return null;

  if (step.kind === 'wait') {
    const live = bus.liveEta;
    return (
      <section className="rounded-2xl border border-white/10 bg-ink-800/70 p-4">
        <Eyebrow icon={<StopIcon />} text="At the stop" />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <RouteChip route={bus.route} />
          <h2 className="text-xl font-semibold leading-tight text-ink-100">
            Wait for {bus.route.routeNumber}
          </h2>
        </div>
        <p className="mt-1 text-sm text-ink-300">
          at {step.targetName}
          {showDhivehi && bus.boardStop.dvName ? (
            <span className="dv block text-xs text-ink-300">{bus.boardStop.dvName}</span>
          ) : null}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500">
          <span className="tabular-nums">
            {bus.estimated ? 'Around' : 'Departs'} {formatClock(bus.departAt)}
          </span>
          <span>MVR {bus.fare.toFixed(2)}</span>
          <span>Get off at {bus.alightStop.name}</span>
        </div>

        {live ? (
          <p
            className={`mt-3 rounded-lg px-3 py-2 text-sm font-medium ${
              live.minutes === 0
                ? 'bg-live-500/15 text-live-500'
                : 'bg-white/5 text-live-500'
            }`}
          >
            <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-live-500 align-middle" />
            {live.minutes === 0 ? 'Your bus is pulling in — board it' : live.label}
            {live.vehicleCode ? ` · bus ${live.vehicleCode}` : ''}
          </p>
        ) : (
          <p className="mt-3 text-xs text-ink-500">
            {liveApplied
              ? 'No live position for this bus — go by the timetable.'
              : 'Checking for live bus times…'}
          </p>
        )}
        <Distance away={away} atTarget={progress.atTarget} known={position !== null} />
      </section>
    );
  }

  const remaining = stopsRemaining(rideStops, position);
  return (
    <section
      className={`rounded-2xl border p-4 ${
        progress.atTarget
          ? 'border-live-500/40 bg-live-500/10'
          : progress.approaching
            ? 'border-amber-400/40 bg-amber-500/10'
            : 'border-white/10 bg-ink-800/70'
      }`}
    >
      <Eyebrow icon={<BusIcon />} text={`On the ${bus.route.routeNumber}`} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <RouteChip route={bus.route} />
        <h2 className="text-xl font-semibold leading-tight text-ink-100">
          Ride to {step.targetName}
        </h2>
      </div>
      {showDhivehi && bus.alightStop.dvName ? (
        <p className="dv mt-1 text-xs text-ink-300">{bus.alightStop.dvName}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500">
        <span>
          {bus.numStops} stop{bus.numStops > 1 ? 's' : ''}
        </span>
        <span>{formatDuration(bus.arriveAt - bus.departAt)}</span>
        <span className="tabular-nums">
          {bus.estimated ? 'Around' : 'Arrives'} {formatClock(bus.arriveAt)}
        </span>
      </div>

      {progress.atTarget ? (
        <p className="mt-3 rounded-lg bg-live-500/15 px-3 py-2 text-sm font-semibold text-live-500">
          {step.targetName} — get off here
        </p>
      ) : progress.approaching ? (
        <p className="mt-3 rounded-lg bg-amber-500/15 px-3 py-2 text-sm font-semibold text-amber-200">
          Get off at the next stop — {step.targetName} is{' '}
          {formatDistance(progress.metersToTarget ?? 0)} ahead
        </p>
      ) : remaining != null ? (
        <p className="mt-3 text-sm font-medium text-ink-100">
          {remaining === 0
            ? 'Getting off here'
            : `${remaining} stop${remaining > 1 ? 's' : ''} to go`}
        </p>
      ) : (
        <p className="mt-3 text-xs text-ink-500">
          Location off, so count the stops yourself and tap below when you get off.
        </p>
      )}

      {rideStops.length > 1 && remaining != null && (
        <RemainingStops stops={rideStops} remaining={remaining} />
      )}
    </section>
  );
}

/**
 * The rest of the ride, so a rider can follow along out of the window rather
 * than trusting a number. Stops already passed stay listed but fade, which is
 * what tells you at a glance how much of the ride is behind you.
 */
function RemainingStops({ stops, remaining }: { stops: Stop[]; remaining: number }) {
  const passed = stops.length - 1 - remaining;
  return (
    <ol className="mt-3 max-h-40 space-y-1.5 overflow-y-auto pr-1 text-xs">
      {stops.map((stop, i) => {
        const isLast = i === stops.length - 1;
        const done = i < passed;
        return (
          <li key={`${stop.code}-${i}`} className="flex items-center gap-2">
            <span
              className={`size-1.5 shrink-0 rounded-full ${
                isLast ? 'bg-live-500' : done ? 'bg-white/20' : 'bg-white/50'
              }`}
            />
            <span
              className={`truncate ${
                isLast
                  ? 'font-semibold text-live-500'
                  : done
                    ? 'text-ink-500 line-through decoration-white/20'
                    : 'text-ink-300'
              }`}
            >
              {stop.name}
            </span>
            {i === passed && !isLast && (
              <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-ink-500">
                you are here
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Distance({
  away,
  atTarget,
  known,
}: {
  away: string | null;
  atTarget: boolean;
  known: boolean;
}) {
  if (!known) {
    return (
      <p className="mt-3 text-xs text-ink-500">
        Location off, so tap the button below when you get there.
      </p>
    );
  }
  if (!away || atTarget) return null;
  return <p className="mt-3 text-sm font-medium tabular-nums text-ink-100">{away}</p>;
}

function Eyebrow({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-500">
      {icon}
      {text}
    </span>
  );
}

/** One line of what the rider will be doing next. */
function summarise(step: JourneyStep): string {
  switch (step.kind) {
    case 'walk':
      return `walk to ${step.targetName}`;
    case 'wait':
      return `wait for ${step.bus?.route.routeNumber} at ${step.targetName}`;
    case 'ride':
      return `ride ${step.bus?.route.routeNumber} to ${step.targetName}`;
    default:
      return 'arrive at your destination';
  }
}

function actionLabel(step: JourneyStep): string {
  switch (step.kind) {
    case 'walk':
      return "I'm here";
    case 'wait':
      return "I've boarded";
    case 'ride':
      return "I've got off";
    default:
      return 'Done';
  }
}

function WalkIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 fill-current" aria-hidden>
      <path d="M13.5 5.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM9.8 8.9 7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3A6.9 6.9 0 0 0 19 13v-2a4.9 4.9 0 0 1-4.1-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5 0-.8.2L6 7.5V12h2V8.8l1.8-.7Z" />
    </svg>
  );
}

function BusIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 fill-current" aria-hidden>
      <path d="M4 16c0 .9.4 1.7 1 2.2V20a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h8v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1.8c.6-.5 1-1.3 1-2.2V6c0-3.5-3.6-4-8-4s-8 .5-8 4v10Zm3.5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm1.5-6H6V6h12v5Z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 fill-current" aria-hidden>
      <path d="M12 2a7 7 0 0 0-7 7c0 5.3 7 13 7 13s7-7.7 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z" />
    </svg>
  );
}

function TickIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-7 fill-live-500" aria-hidden>
      <path d="M9.6 16.6 5 12l1.4-1.4 3.2 3.2 8-8L19 7.2z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 fill-current" aria-hidden>
      <path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z" />
    </svg>
  );
}
