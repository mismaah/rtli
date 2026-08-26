import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { haversineMeters, type LatLng } from '@/lib/geo';
import type { Place } from '@/lib/transit/types';
import { useMap } from './MapContext';

/** Origin and destination pins for the itinerary currently being shown. */
export function EndpointMarkers({
  origin,
  destination,
  userPosition,
}: {
  origin: Place | null;
  destination: Place | null;
  userPosition?: LatLng | null;
}) {
  const map = useMap();
  const markers = useRef<maplibregl.Marker[]>([]);

  useEffect(() => {
    for (const m of markers.current) m.remove();
    markers.current = [];

    const add = (place: Place, kind: 'origin' | 'destination') => {
      const el = document.createElement('div');
      const color = kind === 'origin' ? '#3b82f6' : '#ef4444';
      el.style.cssText = `width:22px;height:22px;border-radius:9999px 9999px 9999px 2px;transform:rotate(-45deg);background:${color};box-shadow:0 0 0 3px rgba(11,17,32,.9),0 3px 10px rgba(0,0,0,.5)`;
      el.title = place.name;
      markers.current.push(
        new maplibregl.Marker({ element: el, anchor: 'bottom' })
          .setLngLat([place.lng, place.lat])
          .addTo(map),
      );
    };

    // When the trip starts where the rider is standing, the blue location dot
    // already marks it — a pin on top of it is just clutter.
    const originIsUser =
      Boolean(userPosition && origin && haversineMeters(origin, userPosition) < 25);
    if (origin && !originIsUser) add(origin, 'origin');
    if (destination) add(destination, 'destination');

    return () => {
      for (const m of markers.current) m.remove();
      markers.current = [];
    };
  }, [map, origin, destination, userPosition]);

  return null;
}
