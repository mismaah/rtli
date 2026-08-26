import { useEffect, useMemo } from 'react';
import { walkLineOf } from '@/lib/transit/walkPaths';
import type { Itinerary, WalkLeg } from '@/lib/transit/types';
import { useMap } from './MapContext';
import { removeLayers } from './removeLayers';

const SOURCE_ID = 'walk-route';
const LINE_ID = `${SOURCE_ID}-line`;

/**
 * The walking half of a journey: getting to the first stop, crossing between
 * routes at a transfer, and the last stretch to the door.
 *
 * Drawn as dots rather than a line, the convention every transit map uses to say
 * "on foot", and in a neutral off-white so it never competes with the route
 * colours RTL assigns — the bus is the part of the trip you have to catch.
 *
 * Legs whose path is still being routed fall back to the direct line, so the
 * trip reads as connected from the moment it opens instead of appearing in
 * pieces as answers land.
 */
export function WalkRouteLayer({ itinerary }: { itinerary: Itinerary }) {
  const map = useMap();

  const data = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: itinerary.legs
        .filter((leg): leg is WalkLeg => leg.kind === 'walk')
        .map((leg) => ({
          type: 'Feature' as const,
          properties: { routed: Boolean(leg.path) },
          geometry: { type: 'LineString' as const, coordinates: walkLineOf(leg) },
        })),
    }),
    [itinerary],
  );

  // Built once and then only fed, so a path arriving does not make the whole
  // set of dots blink out and back.
  useEffect(() => {
    if (map.getSource(SOURCE_ID)) return;
    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: LINE_ID,
      type: 'line',
      source: SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#e2e8f0',
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 16, 5],
        // Dash lengths are multiples of the line width, so a zero-length dash
        // under a round cap stays a round dot at every zoom.
        'line-dasharray': [0, 1.7],
        // The straight-line fallback is a guess at the route, and says so.
        'line-opacity': ['case', ['get', 'routed'], 0.95, 0.5],
      },
    });

    return () => removeLayers(map, [LINE_ID], SOURCE_ID);
  }, [map]);

  useEffect(() => {
    const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    source.setData(data);
    // Route geometry is added whenever its download finishes, which is usually
    // after this layer exists — and a 7 px casing drawn on top would swallow the
    // dots where a walk runs along the road the bus takes.
    if (map.getLayer(LINE_ID)) map.moveLayer(LINE_ID);
  }, [map, data]);

  return null;
}
