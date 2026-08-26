import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import type { LatLng } from '@/lib/geo';
import { useMap } from './MapContext';

/** The blue "you are here" dot, with a ring sized to the reported accuracy. */
export function UserMarker({ position }: { position: (LatLng & { accuracy?: number }) | null }) {
  const map = useMap();
  const marker = useRef<maplibregl.Marker | null>(null);

  useEffect(() => {
    if (!position) {
      marker.current?.remove();
      marker.current = null;
      return;
    }

    if (!marker.current) {
      const el = document.createElement('div');
      el.style.cssText =
        'width:18px;height:18px;border-radius:9999px;background:#3b82f6;box-shadow:0 0 0 3px #fff,0 0 0 9px rgba(59,130,246,.22)';
      marker.current = new maplibregl.Marker({ element: el }).setLngLat([
        position.lng,
        position.lat,
      ]).addTo(map);
    } else {
      marker.current.setLngLat([position.lng, position.lat]);
    }
  }, [map, position]);

  useEffect(() => {
    return () => {
      marker.current?.remove();
      marker.current = null;
    };
  }, []);

  return null;
}
