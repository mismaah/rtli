import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import maplibregl from 'maplibre-gl';
import { useTrackedBuses } from '@/hooks/useTrackedBuses';
import { formatSpeed, isStopped, type BusTrack } from '@/lib/transit/busTracks';
import { compassPoint } from '@/lib/geo';
import { formatAgo } from '@/lib/time';
import { readableOn } from '@/components/RouteChip';
import type { Route } from '@/lib/transit/types';
import { BusTrails } from './BusTrails';
import { useMap } from './MapContext';

interface MarkerEntry {
  marker: maplibregl.Marker;
  el: HTMLDivElement;
  dir: HTMLDivElement;
  body: HTMLButtonElement;
  /** Unwrapped rotation in degrees, so 350° -> 10° turns the short way. */
  angle: number;
}

const BUS_GLYPH = `<svg viewBox="0 0 24 24" width="13" height="13" fill="#fff" aria-hidden="true"><path d="M4 16c0 .9.4 1.7 1 2.2V20a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h8v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1.8c.6-.5 1-1.3 1-2.2V6c0-3.5-3.6-4-8-4s-8 .5-8 4v10Zm3.5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm1.5-6H6V6h12v5Z"/></svg>`;
// The viewBox is padded past the arrow so the outline drawn in CSS has room to
// sit outside it instead of being clipped; `.rtl-bus-dir svg` pulls that padding
// back in so the arrow stays exactly where it was.
const ARROW_GLYPH = `<svg viewBox="-1.6 -1.6 13.2 11.2" width="14.5" height="12.3" aria-hidden="true"><path d="M5 0 9.4 8 5 5.9.6 8Z" fill="currentColor"/></svg>`;

/**
 * Broadcasts which bus was just opened. Module-level because each route mounts
 * its own <BusMarkers>, and only one of them may hold the open popup.
 */
const selectionChannel = new EventTarget();
function announceSelection(busCode: string) {
  selectionChannel.dispatchEvent(new CustomEvent('select', { detail: busCode }));
}

/**
 * Live bus positions for a route, polled while the screen is in the foreground.
 *
 * Markers are kept and moved rather than recreated each poll, so buses glide to
 * their new position instead of flickering, and so an arrow can be swung to the
 * heading inferred in `busTracks` rather than snapping about.
 */
export function BusMarkers({ route }: { route: Route }) {
  const map = useMap();
  const { tracks, updatedAt } = useTrackedBuses(route.code);
  const markers = useRef(new Map<string, MarkerEntry>());
  const [selected, setSelected] = useState<string | null>(null);
  const [host] = useState(() => document.createElement('div'));
  const popup = useRef<maplibregl.Popup | null>(null);
  // Mirrors `selected` for the cross-route listener below, which runs before a
  // state update has been flushed.
  const selectedRef = useRef<string | null>(null);

  const select = useCallback((busCode: string | null) => {
    selectedRef.current = busCode;
    setSelected(busCode);
    if (busCode) announceSelection(busCode);
  }, []);

  // A trip can put two or three routes on the map, each with its own markers.
  // Opening a bus on one route closes whatever another had open, so the map
  // never carries two popups at once.
  useEffect(() => {
    const onOther = (e: Event) => {
      const busCode = (e as CustomEvent<string>).detail;
      if (busCode !== selectedRef.current) select(null);
    };
    selectionChannel.addEventListener('select', onOther);
    return () => selectionChannel.removeEventListener('select', onOther);
  }, [select]);

  const selectedTrack = useMemo(
    () => tracks.find((t) => t.busCode === selected) ?? null,
    [tracks, selected],
  );

  useEffect(() => {
    const current = markers.current;
    const now = Date.now();
    const seen = new Set<string>();

    for (const track of tracks) {
      seen.add(track.busCode);
      let entry = current.get(track.busCode);

      if (!entry) {
        entry = createMarker(route.color, () => select(track.busCode));
        entry.marker.setLngLat([track.lng, track.lat]).addTo(map);
        current.set(track.busCode, entry);
      } else {
        entry.marker.setLngLat([track.lng, track.lat]);
      }

      entry.el.dataset.selected = String(track.busCode === selected);
      entry.el.dataset.motion = isStopped(track, now) ? 'stopped' : 'moving';
      entry.body.setAttribute('aria-label', describe(track, route, now));
      entry.body.title = describe(track, route, now);

      if (track.heading === null) {
        entry.el.dataset.heading = 'unknown';
      } else {
        entry.el.dataset.heading = 'known';
        // Rotate by the shortest arc so the arrow never spins the long way round.
        entry.angle += ((track.heading - entry.angle + 540) % 360) - 180;
        entry.dir.style.transform = `rotate(${entry.angle}deg)`;
      }
    }

    // A bus that stopped reporting has gone out of service.
    for (const [code, entry] of current) {
      if (!seen.has(code)) {
        entry.marker.remove();
        current.delete(code);
        if (code === selected) select(null);
      }
    }
  }, [map, tracks, route, selected, select]);

  // The popup is created once per selection and then only repositioned, so it
  // does not blink out of existence on every ten-second poll. Its opening
  // position is read through a ref for that reason — depending on `tracks` here
  // would rebuild it on each one.
  const latest = useRef<BusTrack[]>(tracks);
  latest.current = tracks;

  useEffect(() => {
    const opened = latest.current.find((t) => t.busCode === selected);
    if (!opened) return;

    const instance = new maplibregl.Popup({
      offset: 20,
      closeOnClick: false,
      maxWidth: '270px',
      focusAfterOpen: false,
    })
      .setLngLat([opened.lng, opened.lat])
      .setDOMContent(host)
      .addTo(map);
    frameForPopup(map, [opened.lng, opened.lat]);
    const handleClose = () => select(null);
    instance.on('close', handleClose);
    popup.current = instance;

    return () => {
      // Detached first: `remove()` fires 'close' itself, which would otherwise
      // clear a selection that has just moved to a different bus.
      instance.off('close', handleClose);
      popup.current = null;
      instance.remove();
    };
  }, [map, host, selected, select]);

  useEffect(() => {
    if (selectedTrack) popup.current?.setLngLat([selectedTrack.lng, selectedTrack.lat]);
  }, [selectedTrack]);

  useEffect(() => {
    const current = markers.current;
    return () => {
      for (const entry of current.values()) entry.marker.remove();
      current.clear();
    };
  }, []);

  return (
    <>
      <BusTrails routeCode={route.code} color={route.color} tracks={tracks} />
      {selectedTrack &&
        createPortal(<BusInfo track={selectedTrack} route={route} updatedAt={updatedAt} />, host)}
    </>
  );
}

function createMarker(color: string, onClick: () => void): MarkerEntry {
  const el = document.createElement('div');
  el.className = 'rtl-bus';
  el.style.setProperty('--rtl-bus-color', color);
  el.dataset.heading = 'unknown';

  const dir = document.createElement('div');
  dir.className = 'rtl-bus-dir';
  dir.innerHTML = ARROW_GLYPH;

  // A button rather than a div: the dot is the only interactive part of the
  // marker, and this is what makes it reachable by keyboard and announced.
  const body = document.createElement('button');
  body.type = 'button';
  body.className = 'rtl-bus-body';
  body.innerHTML = BUS_GLYPH;

  el.append(dir, body);
  body.addEventListener('click', (e) => {
    // Otherwise the map's own click handlers treat this as a tap on the basemap.
    e.stopPropagation();
    onClick();
  });

  return { marker: new maplibregl.Marker({ element: el }), el, dir, body, angle: 0 };
}

/** The marker's accessible name — the popup's content, said in one line. */
function describe(track: BusTrack, route: Route, now: number): string {
  const bus = `${route.routeNumber} bus ${track.plateNumber || track.busCode}`;
  if (track.heading === null) return `${bus}, direction not known yet`;
  if (isStopped(track, now)) return `${bus}, stopped, last headed ${compassPoint(track.heading)}`;
  return `${bus}, heading ${compassPoint(track.heading)}`;
}

/**
 * Brings the tapped bus to the top of the strip the sheet leaves visible, so its
 * popup opens downwards into open map instead of underneath the sheet — which is
 * where MapLibre would otherwise put it, knowing only the container's own size.
 */
function frameForPopup(map: maplibregl.Map, center: [number, number]) {
  const { top, bottom } = map.getPadding();
  const visibleCenter = (top + (map.getContainer().clientHeight - bottom)) / 2;
  map.easeTo({ center, offset: [0, top + 56 - visibleCenter], duration: 400 });
}

/**
 * What is actually known about one bus. RTL publishes no timestamp with a
 * position, so "updated" is when the feed answered, and everything about
 * movement is inferred — labelled as such rather than dressed up as telemetry.
 */
function BusInfo({ track, route, updatedAt }: { track: BusTrack; route: Route; updatedAt: number }) {
  const now = useTicker();
  const stopped = isStopped(track, now);

  return (
    <div className="w-[228px] p-3.5 text-ink-100">
      <div className="flex items-center gap-2 pr-5">
        <span
          className="inline-flex items-center rounded-lg px-2 py-1 text-xs font-bold leading-none"
          style={{ background: route.color, color: readableOn(route.color) }}
        >
          {route.routeNumber}
        </span>
        <span className="min-w-0 truncate text-xs text-ink-300">{route.name}</span>
      </div>

      <p className="mt-2 text-sm font-semibold">
        {track.plateNumber || 'Unmarked bus'}
        <span className="ml-1.5 text-[11px] font-normal text-ink-500">{track.busCode}</span>
      </p>

      <p className="mt-2.5 flex items-center gap-1.5 border-t border-white/10 pt-2.5 text-xs">
        {track.heading === null ? (
          <span className="text-ink-500">Direction not known yet</span>
        ) : (
          <>
            <svg
              viewBox="0 0 10 8"
              className="size-2.5 shrink-0"
              style={{ transform: `rotate(${track.heading}deg)` }}
              aria-hidden
            >
              <path d="M5 0 9.4 8 5 5.9.6 8Z" fill="currentColor" />
            </svg>
            {stopped ? (
              <span>
                <span className="text-amber-200">Stopped</span> — last headed{' '}
                {compassPoint(track.heading)}
              </span>
            ) : (
              <span>
                Heading {compassPoint(track.heading)}
                {track.speedMps !== null && ` · ${formatSpeed(track.speedMps)}`}
              </span>
            )}
          </>
        )}
      </p>

      <p className="mt-1 text-[11px] text-ink-500">
        Updated {formatAgo(now - (updatedAt || now))} · moved {formatAgo(now - track.movedAt)}
      </p>

      <p className="mt-2 text-[10px] leading-snug text-ink-500">
        {track.heading === null
          ? 'RTL reports position only — direction appears once the bus has moved.'
          : 'Direction and speed are estimated from recent positions.'}
      </p>
    </div>
  );
}

/** Keeps the "12s ago" lines honest while the popup sits open. */
function useTicker(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
