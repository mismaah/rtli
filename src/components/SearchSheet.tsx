import { useEffect, useMemo, useRef, useState } from 'react';
import { nearestStops, searchStops, useStopIndex, usePlaceSearch } from '@/hooks/useStopSearch';
import { formatDistance, haversineMeters, type LatLng } from '@/lib/geo';
import { useSavedPlaces } from '@/store/savedPlaces';
import { usePrefs } from '@/store/prefs';
import { SIDE_PANEL_WIDTH, useWideLayout } from '@/hooks/useWideLayout';
import type { Place, Stop, TransitGraph } from '@/lib/transit/types';

interface Props {
  graph: TransitGraph | undefined;
  userPosition: LatLng | null;
  title: string;
  onPick: (place: Place) => void;
  onClose: () => void;
}

/**
 * Search: saved places, nearby stops, all stops, then OSM places.
 *
 * Takes the whole screen on phones; on wide screens it covers only the side
 * panel, so the map you are picking a point on stays in view.
 */
export function SearchSheet({ graph, userPosition, title, onPick, onClose }: Props) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const index = useStopIndex(graph);
  const { places, searching } = usePlaceSearch(query);
  const saved = useSavedPlaces((s) => s.places);
  const showDhivehi = usePrefs((s) => s.showDhivehi);
  const wide = useWideLayout();

  useEffect(() => {
    // Delayed so the sheet's entry transition doesn't fight the keyboard.
    const t = setTimeout(() => input.current?.focus(), 120);
    return () => clearTimeout(t);
  }, []);

  const stopHits = useMemo(() => searchStops(index, query), [index, query]);
  const nearby = useMemo(
    () => (userPosition && !query ? nearestStops(index.stops, userPosition) : []),
    [index.stops, userPosition, query],
  );
  const savedHits = useMemo(
    () =>
      query
        ? saved.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()))
        : saved,
    [saved, query],
  );

  const toPlace = (stop: Stop): Place => ({
    name: stop.name,
    lat: stop.lat,
    lng: stop.lng,
    stopCode: stop.code,
  });

  return (
    <div
      className={
        wide
          ? 'fixed inset-y-0 right-0 z-50 flex flex-col border-l border-white/10 bg-ink-950'
          : 'fixed inset-0 z-50 flex flex-col bg-ink-950'
      }
      style={{ paddingTop: 'var(--safe-top)', width: wide ? SIDE_PANEL_WIDTH : undefined }}
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-3">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close search"
          className="grid size-11 shrink-0 place-items-center rounded-full text-ink-300 active:bg-white/10"
        >
          <svg viewBox="0 0 24 24" className="size-6 fill-current" aria-hidden>
            <path d="M15.5 4.5 14 3l-9 9 9 9 1.5-1.5L8 12z" />
          </svg>
        </button>
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={title}
          enterKeyHint="search"
          autoComplete="off"
          className="h-11 min-w-0 flex-1 rounded-xl bg-ink-800 px-4 text-base text-ink-100 outline-none placeholder:text-ink-500 focus:ring-2 focus:ring-brand-500"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear"
            className="grid size-11 shrink-0 place-items-center rounded-full text-ink-500 active:bg-white/10"
          >
            <svg viewBox="0 0 24 24" className="size-5 fill-current" aria-hidden>
              <path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z" />
            </svg>
          </button>
        )}
      </div>

      <div
        className="no-scrollbar flex-1 overflow-y-auto overscroll-contain px-3 pt-2"
        style={{ paddingBottom: 'calc(var(--safe-bottom) + 1.5rem)' }}
      >
        {savedHits.length > 0 && (
          <Section label="Saved">
            {savedHits.map((p) => (
              <Row
                key={p.id}
                icon={<span className="text-lg">{p.icon}</span>}
                title={p.name}
                onClick={() => onPick(p)}
              />
            ))}
          </Section>
        )}

        {nearby.length > 0 && (
          <Section label="Nearby stops">
            {nearby.map((s) => (
              <Row
                key={s.code}
                icon={<StopIcon />}
                title={s.name}
                subtitle={
                  userPosition ? formatDistance(haversineMeters(userPosition, s) * 1.35) : undefined
                }
                dv={showDhivehi ? s.dvName : undefined}
                onClick={() => onPick(toPlace(s))}
              />
            ))}
          </Section>
        )}

        {stopHits.length > 0 && (
          <Section label="Bus stops">
            {stopHits.map((s) => (
              <Row
                key={s.code}
                icon={<StopIcon />}
                title={s.name}
                subtitle={s.routes.join(' · ')}
                dv={showDhivehi ? s.dvName : undefined}
                onClick={() => onPick(toPlace(s))}
              />
            ))}
          </Section>
        )}

        {query.trim().length >= 2 && (
          <Section label="Places">
            {searching && places.length === 0 && (
              <p className="px-3 py-4 text-sm text-ink-500">Searching…</p>
            )}
            {!searching && places.length === 0 && (
              <p className="px-3 py-4 text-sm text-ink-500">
                No places found. Try a bus stop name instead.
              </p>
            )}
            {places.map((p, i) => (
              <Row
                key={`${p.name}-${i}`}
                icon={<PinIcon />}
                title={p.name}
                onClick={() => onPick(p)}
              />
            ))}
          </Section>
        )}

        {!query && savedHits.length === 0 && nearby.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-ink-500">
            Search for a bus stop, a landmark or an address in Greater Malé.
          </p>
        )}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mb-4">
      <h2 className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
        {label}
      </h2>
      <div className="overflow-hidden rounded-xl bg-ink-900">{children}</div>
    </section>
  );
}

function Row({
  icon,
  title,
  subtitle,
  dv,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  dv?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-14 w-full items-center gap-3 border-b border-white/5 px-3 py-2.5 text-left last:border-0 active:bg-white/5"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ink-800 text-ink-300">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink-100">{title}</span>
        {dv ? <span className="dv block truncate text-xs text-ink-300">{dv}</span> : null}
        {subtitle ? <span className="block truncate text-xs text-ink-500">{subtitle}</span> : null}
      </span>
    </button>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 fill-current" aria-hidden>
      <path d="M4 16c0 .9.4 1.7 1 2.2V20a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h8v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1.8c.6-.5 1-1.3 1-2.2V6c0-3.5-3.6-4-8-4s-8 .5-8 4v10Zm3.5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3ZM18 11H6V6h12v5Z" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 fill-current" aria-hidden>
      <path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z" />
    </svg>
  );
}
