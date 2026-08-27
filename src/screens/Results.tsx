import { ItineraryCard } from '@/components/ItineraryCard';
import { usePrefs } from '@/store/prefs';
import type { WalkPreference } from '@/lib/transit/plan';
import type { Itinerary, Place } from '@/lib/transit/types';

interface Props {
  origin: Place;
  destination: Place;
  itineraries: Itinerary[];
  loading: boolean;
  onSelect: (itinerary: Itinerary) => void;
  onEditOrigin: () => void;
  onEditDestination: () => void;
  onToggleSaveDestination: () => void;
  destinationSaved: boolean;
}

export function Results({
  origin,
  destination,
  itineraries,
  loading,
  onSelect,
  onEditOrigin,
  onEditDestination,
  onToggleSaveDestination,
  destinationSaved,
}: Props) {
  const walkPreference = usePrefs((s) => s.walkPreference);
  const setWalkPreference = usePrefs((s) => s.setWalkPreference);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-ink-800/70 p-1">
        <Endpoint label="From" value={origin.name} onClick={onEditOrigin} dot="#3b82f6" />
        <Endpoint
          label="To"
          value={destination.name}
          onClick={onEditDestination}
          dot="#ef4444"
          action={
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleSaveDestination();
              }}
              aria-label={destinationSaved ? 'Remove from saved places' : 'Save this place'}
              className="grid size-10 shrink-0 place-items-center rounded-full text-ink-500 active:bg-white/10"
            >
              <StarIcon filled={destinationSaved} />
            </button>
          }
        />
      </div>

      {itineraries.length > 0 && (
        <WalkPreferencePicker value={walkPreference} onChange={setWalkPreference} />
      )}

      {loading && <SkeletonList />}

      {!loading && itineraries.length === 0 && (
        <div className="rounded-2xl border border-white/10 bg-ink-800/50 p-6 text-center">
          <p className="text-sm text-ink-300">No bus route found for this trip.</p>
          <p className="mt-2 text-xs text-ink-500">
            RTL buses cover Malé, Hulhulé and Hulhumalé, plus Villimalé internally. Villimalé is
            reached by ferry, not by bus, so trips between it and Malé cannot be planned here.
          </p>
        </div>
      )}

      {itineraries.map((it) => (
        <ItineraryCard key={it.id} itinerary={it} onSelect={() => onSelect(it)} />
      ))}
    </div>
  );
}

/**
 * Lets the rider retune the ranking in place. Walking is the one trade-off the
 * planner cannot guess — the same 600 m is a pleasant shortcut at 7am and out of
 * the question at noon with shopping — so it sits with the results it reorders
 * rather than behind a settings screen.
 */
const WALK_OPTIONS: { value: WalkPreference; label: string; hint: string }[] = [
  { value: 'less', label: 'Less walking', hint: 'Favours trips with the shortest walk' },
  { value: 'balanced', label: 'Balanced', hint: 'Trades walking against time and fare' },
  { value: 'more', label: 'Fastest', hint: 'Walk further if it gets you there sooner' },
];

function WalkPreferencePicker({
  value,
  onChange,
}: {
  value: WalkPreference;
  onChange: (next: WalkPreference) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Walking preference"
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
            title={option.hint}
            onClick={() => onChange(option.value)}
            className={`min-h-9 flex-1 rounded-full px-3 text-xs font-medium transition-colors ${
              selected ? 'bg-brand-500/20 text-brand-400' : 'text-ink-500 active:bg-white/5'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function Endpoint({
  label,
  value,
  onClick,
  dot,
  action,
}: {
  label: string;
  value: string;
  onClick: () => void;
  dot: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center">
      <button
        type="button"
        onClick={onClick}
        className="flex min-h-12 flex-1 items-center gap-3 rounded-xl px-3 py-2 text-left active:bg-white/5"
      >
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: dot }} />
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] uppercase tracking-wide text-ink-500">{label}</span>
          <span className="block truncate text-sm text-ink-100">{value}</span>
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
