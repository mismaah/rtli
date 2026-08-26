import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { useLiveBuses } from '@/hooks/useLiveBuses';
import { useMap } from './MapContext';

/**
 * Live bus positions for a route, polled while the screen is in the foreground.
 *
 * Markers are kept and moved rather than recreated each poll, so buses glide to
 * their new position instead of flickering.
 */
export function BusMarkers({ routeCode, color }: { routeCode: string; color: string }) {
  const map = useMap();
  const { data: buses } = useLiveBuses(routeCode);
  const markers = useRef(new Map<string, maplibregl.Marker>());

  useEffect(() => {
    const current = markers.current;
    if (!buses) return;

    const seen = new Set<string>();

    for (const bus of buses) {
      if (!Number.isFinite(bus.latitude) || !Number.isFinite(bus.longitude)) continue;
      seen.add(bus.busCode);

      const existing = current.get(bus.busCode);
      if (existing) {
        existing.setLngLat([bus.longitude, bus.latitude]);
        continue;
      }

      const el = document.createElement('div');
      el.className = 'rtl-live-bus';
      el.style.cssText = `width:22px;height:22px;border-radius:9999px;display:grid;place-items:center;background:${color};box-shadow:0 0 0 2px rgba(11,17,32,.9),0 2px 6px rgba(0,0,0,.5);transition:transform .3s ease`;
      el.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="#fff" aria-hidden="true"><path d="M4 16c0 .9.4 1.7 1 2.2V20a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h8v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1.8c.6-.5 1-1.3 1-2.2V6c0-3.5-3.6-4-8-4s-8 .5-8 4v10Zm3.5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm1.5-6H6V6h12v5Z"/></svg>`;
      el.title = `Bus ${bus.plateNumber}`;

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([bus.longitude, bus.latitude])
        .addTo(map);
      current.set(bus.busCode, marker);
    }

    // A bus that stopped reporting has gone out of service.
    for (const [code, marker] of current) {
      if (!seen.has(code)) {
        marker.remove();
        current.delete(code);
      }
    }
  }, [map, buses, color]);

  useEffect(() => {
    const current = markers.current;
    return () => {
      for (const marker of current.values()) marker.remove();
      current.clear();
    };
  }, []);

  return null;
}
