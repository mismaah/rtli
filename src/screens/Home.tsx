import { useSavedPlaces } from '@/store/savedPlaces';
import { useRecentTrips } from '@/store/recentTrips';
import type { GeolocationStatus } from '@/hooks/useGeolocation';
import type { Place } from '@/lib/transit/types';

interface Props {
  origin: Place | null;
  destination: Place | null;
  geoStatus: GeolocationStatus;
  onRequestLocation: () => void;
  onEditOrigin: () => void;
  onEditDestination: () => void;
  onPickRecent: (origin: Place, destination: Place) => void;
  onPickSaved: (destination: Place) => void;
  onManageSaved: () => void;
}

export function Home({
  origin,
  destination,
  geoStatus,
  onRequestLocation,
  onEditOrigin,
  onEditDestination,
  onPickRecent,
  onPickSaved,
  onManageSaved,
}: Props) {
  const saved = useSavedPlaces((s) => s.places);
  const recents = useRecentTrips((s) => s.trips);

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-white/10 bg-ink-800/70 p-2">
        <FieldButton
          label="From"
          value={origin?.name}
          placeholder={geoStatus === 'locating' ? 'Finding your location…' : 'Choose a start'}
          onClick={onEditOrigin}
          dot="#3b82f6"
        />
        <div className="ml-6 h-4 w-px bg-white/15" />
        <FieldButton
          label="To"
          value={destination?.name}
          placeholder="Where are you going?"
          onClick={onEditDestination}
          dot="#ef4444"
        />
      </div>

      {geoStatus !== 'ready' && (
        <button
          type="button"
          onClick={onRequestLocation}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-brand-500/40 bg-brand-500/10 px-4 text-sm font-medium text-brand-400 active:bg-brand-500/20"
        >
          <LocateIcon />
          {geoStatus === 'denied' ? 'Location blocked — tap to retry' : 'Use my location'}
        </button>
      )}

      {saved.length > 0 && (
        <section>
          <div className="mb-2 flex items-center justify-between px-1">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
              Saved
            </h2>
            <button
              type="button"
              onClick={onManageSaved}
              className="text-xs font-medium text-brand-400"
            >
              Manage
            </button>
          </div>
          <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {saved.map((p) => (
              <button
                key={p.id}
                type="button"
                // A saved place is somewhere to go, never both ends of a trip:
                // tapping one before a start point exists used to plan a journey
                // from the place to itself, and file it under recents.
                onClick={() => onPickSaved(p)}
                className="flex min-h-16 w-24 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-white/10 bg-ink-800/70 px-2 py-2 active:bg-ink-700/70"
              >
                <span className="text-xl">{p.icon}</span>
                <span className="w-full truncate text-center text-[11px] text-ink-300">
                  {p.name}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {recents.length > 0 && (
        <section>
          <h2 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
            Recent
          </h2>
          <div className="overflow-hidden rounded-xl bg-ink-900">
            {recents.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onPickRecent(t.origin, t.destination)}
                className="flex min-h-14 w-full items-center gap-3 border-b border-white/5 px-3 py-2.5 text-left last:border-0 active:bg-white/5"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ink-800 text-ink-500">
                  <ClockIcon />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink-100">{t.destination.name}</span>
                  <span className="block truncate text-xs text-ink-500">from {t.origin.name}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function FieldButton({
  label,
  value,
  placeholder,
  onClick,
  dot,
}: {
  label: string;
  value?: string;
  placeholder: string;
  onClick: () => void;
  dot: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left active:bg-white/5"
    >
      <span className="size-3 shrink-0 rounded-full" style={{ background: dot }} />
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] uppercase tracking-wide text-ink-500">{label}</span>
        <span className={value ? 'block truncate text-ink-100' : 'block truncate text-ink-500'}>
          {value ?? placeholder}
        </span>
      </span>
    </button>
  );
}

function LocateIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 fill-current" aria-hidden>
      <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8.9 3a9 9 0 0 0-7.9-7.9V1h-2v2.1A9 9 0 0 0 3.1 11H1v2h2.1a9 9 0 0 0 7.9 7.9V23h2v-2.1a9 9 0 0 0 7.9-7.9H23v-2h-2.1ZM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 fill-current" aria-hidden>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 10.6V6h-2v7.4l5.2 3.1 1-1.7-4.2-2.2Z" />
    </svg>
  );
}
