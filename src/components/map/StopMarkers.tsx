import { useEffect } from 'react';
import type { Stop } from '@/lib/transit/types';
import { useMap } from './MapContext';
import { removeLayers } from './removeLayers';

interface Props {
  stops: Stop[];
  onSelect?: (stopCode: string) => void;
  /** Stops to draw larger, e.g. the ones on the chosen itinerary. */
  highlighted?: string[];
}

/**
 * Bus stops as a single symbol layer rather than DOM markers — 101 markers is
 * enough to cost noticeable scroll performance on a mid-range phone.
 */
export function StopMarkers({ stops, onSelect, highlighted = [] }: Props) {
  const map = useMap();

  useEffect(() => {
    const sourceId = 'stops';
    const layerId = 'stops-circles';
    const labelId = 'stops-labels';

    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: stops.map((s) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
        properties: {
          code: s.code,
          name: s.name,
          highlighted: highlighted.includes(s.code) ? 1 : 0,
        },
      })),
    };

    if (!map.getSource(sourceId)) {
      map.addSource(sourceId, { type: 'geojson', data });
      map.addLayer({
        id: layerId,
        type: 'circle',
        source: sourceId,
        paint: {
          // 101 stops swamp the islands when drawn at a fixed size, so ordinary
          // stops stay tiny until zoomed in. Stops on the chosen trip keep their
          // size at every zoom, since those are the ones being looked for.
          //
          // Zoom must be the top-level input to the interpolation — MapLibre
          // rejects a `zoom` expression nested inside a `case`.
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            11, ['case', ['==', ['get', 'highlighted'], 1], 5, 1.5],
            13, ['case', ['==', ['get', 'highlighted'], 1], 6, 2.5],
            15, ['case', ['==', ['get', 'highlighted'], 1], 8, 5],
          ],
          'circle-color': ['case', ['==', ['get', 'highlighted'], 1], '#ffffff', '#94a3b8'],
          'circle-stroke-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12, ['case', ['==', ['get', 'highlighted'], 1], 2, 0],
            14, ['case', ['==', ['get', 'highlighted'], 1], 2, 1.5],
          ],
          'circle-stroke-color': '#0b1120',
          'circle-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            11, ['case', ['==', ['get', 'highlighted'], 1], 1, 0.45],
            14, ['case', ['==', ['get', 'highlighted'], 1], 1, 0.9],
          ],
        },
      });
      map.addLayer({
        id: labelId,
        type: 'symbol',
        source: sourceId,
        // Labels only once zoomed in, otherwise they collide into mush.
        minzoom: 14,
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 11,
          'text-offset': [0, 1.1],
          'text-anchor': 'top',
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#e2e8f0',
          'text-halo-color': '#0b1120',
          'text-halo-width': 1.4,
        },
      });
    } else {
      (map.getSource(sourceId) as maplibregl.GeoJSONSource).setData(data);
    }

    const handleClick = (e: maplibregl.MapMouseEvent) => {
      const feature = map.queryRenderedFeatures(e.point, { layers: [layerId] })[0];
      const code = feature?.properties?.code;
      if (typeof code === 'string') onSelect?.(code);
    };
    const setPointer = () => (map.getCanvas().style.cursor = 'pointer');
    const clearPointer = () => (map.getCanvas().style.cursor = '');

    if (onSelect) {
      map.on('click', layerId, handleClick);
      map.on('mouseenter', layerId, setPointer);
      map.on('mouseleave', layerId, clearPointer);
    }

    return () => {
      if (onSelect) {
        map.off('click', layerId, handleClick);
        map.off('mouseenter', layerId, setPointer);
        map.off('mouseleave', layerId, clearPointer);
      }
    };
  }, [map, stops, onSelect, highlighted]);

  useEffect(() => {
    return () => removeLayers(map, ['stops-labels', 'stops-circles'], 'stops');
  }, [map]);

  return null;
}
