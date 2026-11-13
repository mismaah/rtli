import { useState } from 'react';
import { ItineraryCard } from '@/components/ItineraryCard';
import { formatClock, minutesOfDay, MINUTES_PER_DAY, parseClock } from '@/lib/time';
import { usePrefs } from '@/store/prefs';
import { Dv, placeSecondary, placeText, useT } from '@/i18n';
import type { T } from '@/i18n';
import type { WalkPreference } from '@/lib/transit/plan';
import type { Itinerary, Place, TransitGraph, TripTiming } from '@/lib/transit/types';

interface Props {
  graph: TransitGraph;
  origin: Place;
  destination: Place;
  itineraries: Itinerary[];
  timing: TripTiming;
  onTimingChange: (timing: TripTiming) => void;
  loading: boolean;
  onSelect: (itinerary: Itinerary) => void;
  onEditOrigin: () => void;
  onEditDestination: () => void;
  onToggleSaveDestination: () => void;
  destinationSaved: boolean;
}

export function Results({
  graph,
  origin,
  destination,
  itineraries,
  timing,
  onTimingChange,
  loading,
  onSelect,
  onEditOrigin,
  onEditDestination,
  onToggleSaveDestination,
  destinationSaved,
}: Props) {
  const walkPreference = usePrefs((s) => s.walkPreference);
  const setWalkPreference = usePrefs((s) => s.setWalkPreference);
  const { t, lang } = useT();

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-ink-800/70 p-1">
        <Endpoint
          label={t('fieldFrom')}
          value={placeText(origin, lang, graph, t)}
          dv={placeSecondary(origin, lang, graph)}
          onClick={onEditOrigin}
          dot="#3b82f6"
        />
        <Endpoint
          label={t('fieldTo')}
          value={placeText(destination, lang, graph, t)}
          dv={placeSecondary(destination, lang, graph)}
          onClick={onEditDestination}
          dot="#ef4444"
          action={
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleSaveDestination();
              }}
              aria-label={destinationSaved ? t('removeFromSaved') : t('saveThisPlace')}
              className="grid size-10 shrink-0 place-items-center rounded-full text-ink-500 active:bg-white/10"
            >
              <StarIcon filled={destinationSaved} />
            </button>
          }
        />
      </div>

      <TripTimePicker value={timing} onChange={onTimingChange} t={t} />

      {itineraries.length > 0 && (
        <WalkPreferencePicker value={walkPreference} onChange={setWalkPreference} t={t} />
      )}

      {loading && <SkeletonList />}

      {!loading && itineraries.length === 0 && (
        <div className="rounded-2xl border border-white/10 bg-ink-800/50 p-6 text-center">
          {timing.kind === 'arrive' ? (
            <>
              <p className="text-sm text-ink-300">
                {t('noRouteArriveBy', { time: formatClock(timing.at) })}
              </p>
              <p className="mt-2 text-xs text-ink-500">{t('noRouteArriveByHint')}</p>
            </>
          ) : (
            <>
              <p className="text-sm text-ink-300">{t('noRouteFound')}</p>
              <p className="mt-2 text-xs text-ink-500">{t('noRouteHint')}</p>
            </>
          )}
        </div>
      )}

      {itineraries.map((it) => (
        <ItineraryCard key={it.id} itinerary={it} onSelect={() => onSelect(it)} />
      ))}
    </div>
  );
}

/**
 * Leave now, leave at a time, or be there by one — collapsed to a single line
 * that says which, since leaving now is what nearly every search wants and the
 * controls for the other two would otherwise sit above the results every time.
 *
 * Times are today's: the timetable loaded is today's, and a different day's
 * service is not something this app has to plan with.
 */
const TIMING_OPTIONS = [
  { value: 'now', label: 'timingNow' },
  { value: 'depart', label: 'timingDepart' },
  { value: 'arrive', label: 'timingArrive' },
] as const;

/** How far ahead an arrive-by search starts out, before the rider adjusts it. */
const DEFAULT_ARRIVE_AHEAD_MIN = 30;

function TripTimePicker({
  value,
  onChange,
  t,
}: {
  value: TripTiming;
  onChange: (next: TripTiming) => void;
  t: T;
}) {
  const [open, setOpen] = useState(false);
  const pinned = value.kind !== 'now';

  const summary =
    value.kind === 'depart'
      ? t('timingDepartAt', { time: formatClock(value.at) })
      : value.kind === 'arrive'
        ? t('timingArriveBy', { time: formatClock(value.at) })
        : t('timingNow');

  const choose = (kind: TripTiming['kind']) => {
    if (kind === value.kind) return;
    if (kind === 'now') {
      onChange({ kind: 'now' });
      return;
    }
    // Switching between the two pinned modes keeps the time already chosen;
    // coming from "now" starts from the next round five minutes.
    const now = minutesOfDay();
    const at = pinned
      ? value.at
      : roundUpToFive(kind === 'arrive' ? now + DEFAULT_ARRIVE_AHEAD_MIN : now);
    onChange({ kind, at });
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-ink-800/70 p-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-sm active:bg-white/5 ${
          pinned ? 'font-medium text-brand-400' : 'text-ink-100'
        }`}
      >
        <ClockIcon />
        <span className="flex-1 text-start tabular-nums">{summary}</span>
        <svg
          viewBox="0 0 24 24"
          className={`size-5 fill-current text-ink-500 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        >
          <path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z" />
        </svg>
      </button>

      {open && (
        <div className="space-y-2 p-1">
          <div role="radiogroup" aria-label={t('tripTime')} className="flex gap-1">
            {TIMING_OPTIONS.map((option) => {
              const selected = option.value === value.kind;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => choose(option.value)}
                  className={`min-h-9 flex-1 rounded-full px-3 text-xs font-medium transition-colors ${
                    selected ? 'bg-brand-500/20 text-brand-400' : 'text-ink-500 active:bg-white/5'
                  }`}
                >
                  {t(option.label)}
                </button>
              );
            })}
          </div>

          {pinned && (
            <input
              type="time"
              step={60}
              dir="ltr"
              aria-label={t('timingTimeLabel')}
              value={formatClock(value.at)}
              onChange={(e) => {
                // A half-typed or cleared field is not a time; keep the last one.
                const at = parseClock(e.target.value);
                if (at != null) onChange({ kind: value.kind, at });
              }}
              className="min-h-11 w-full rounded-xl border border-white/10 bg-ink-900 px-3 text-base tabular-nums text-ink-100"
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Up to the next multiple of five minutes, kept within today. */
function roundUpToFive(minutes: number): number {
  return Math.min(Math.ceil(minutes / 5) * 5, MINUTES_PER_DAY - 1);
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0 fill-current" aria-hidden>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7Z" />
    </svg>
  );
}

/**
 * Lets the rider retune the ranking in place. Walking is the one trade-off the
 * planner cannot guess — the same 600 m is a pleasant shortcut at 7am and out of
 * the question at noon with shopping — so it sits with the results it reorders
 * rather than behind a settings screen.
 */
const WALK_OPTIONS = [
  { value: 'less', label: 'walkLess', hint: 'walkLessHint' },
  { value: 'balanced', label: 'walkBalanced', hint: 'walkBalancedHint' },
  { value: 'more', label: 'walkMore', hint: 'walkMoreHint' },
] as const;

function WalkPreferencePicker({
  value,
  onChange,
  t,
}: {
  value: WalkPreference;
  onChange: (next: WalkPreference) => void;
  t: T;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={t('walkPreference')}
      className="flex gap-1 rounded-full border border-white/10 bg-ink-800/70 p-1"
    >
      {WALK_OPTIONS.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={t(option.hint)}
            onClick={() => onChange(option.value)}
            className={`min-h-9 flex-1 rounded-full px-3 text-xs font-medium transition-colors ${
              selected ? 'bg-brand-500/20 text-brand-400' : 'text-ink-500 active:bg-white/5'
            }`}
          >
            {t(option.label)}
          </button>
        );
      })}
    </div>
  );
}

function Endpoint({
  label,
  value,
  dv,
  onClick,
  dot,
  action,
}: {
  label: string;
  value: string;
  dv?: string;
  onClick: () => void;
  dot: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center">
      <button
        type="button"
        onClick={onClick}
        className="flex min-h-12 flex-1 items-center gap-3 rounded-xl px-3 py-2 text-start active:bg-white/5"
      >
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: dot }} />
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] uppercase tracking-wide text-ink-500">{label}</span>
          <span className="block truncate text-sm text-ink-100">{value}</span>
          {dv ? <Dv className="block truncate text-xs text-ink-300">{dv}</Dv> : null}
        </span>
      </button>
      {action}
    </div>
  );
}

function SkeletonList() {
  return (
    <div className="space-y-3" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="animate-pulse rounded-2xl border border-white/10 bg-ink-800/50 p-4">
          <div className="h-7 w-28 rounded bg-white/10" />
          <div className="mt-3 h-4 w-40 rounded bg-white/10" />
          <div className="mt-3 h-3 w-52 rounded bg-white/5" />
        </div>
      ))}
    </div>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return filled ? (
    <svg viewBox="0 0 24 24" className="size-5 fill-amber-400" aria-hidden>
      <path d="m12 17.3-6.2 3.7 1.6-7L2 9.2l7.1-.6L12 2l2.9 6.6 7.1.6-5.4 4.8 1.6 7z" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" className="size-5 fill-current" aria-hidden>
      <path d="m12 15.4 3.8 2.3-1-4.3 3.3-2.9-4.4-.4L12 6l-1.7 4.1-4.4.4 3.3 2.9-1 4.3 3.8-2.3ZM12 17.3l-6.2 3.7 1.6-7L2 9.2l7.1-.6L12 2l2.9 6.6 7.1.6-5.4 4.8 1.6 7L12 17.3Z" />
    </svg>
  );
}
