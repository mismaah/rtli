import { useEffect } from 'react';
import { useMap } from './MapContext';

/**
 * Reserves the area the bottom sheet covers.
 *
 * Without this the map centres on the middle of its container, which sits behind
 * the sheet — so the trip you asked about is hidden and you see open sea instead.
 * Padding shifts both `center` and `fitBounds` into the part still visible.
 */
export function MapPadding({ bottom }: { bottom: number }) {
  const map = useMap();

  useEffect(() => {
    map.setPadding({ top: 80, right: 24, bottom, left: 24 }, { duration: 300 });
  }, [map, bottom]);

  return null;
}
