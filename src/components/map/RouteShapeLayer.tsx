import { useEffect } from 'react';
import { useRoadShape } from '@/hooks/useRoadShape';
import { useMap } from './MapContext';
import { removeLayers } from './removeLayers';

/** Draws one route's real road geometry, in that route's own colour. */
export function RouteShapeLayer({ routeCode, color }: { routeCode: string; color: string }) {
  const map = useMap();
  const { data } = useRoadShape(routeCode);

  useEffect(() => {
    if (!data) return;
    const sourceId = `shape-${routeCode}`;
    const casingId = `${sourceId}-casing`;
    const lineId = `${sourceId}-line`;

    if (!map.getSource(sourceId)) {
      map.addSource(sourceId, { type: 'geojson', data });
      // A dark casing underneath keeps bright route colours legible on the map.
      map.addLayer({
        id: casingId,
        type: 'line',
        source: sourceId,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#0b1120', 'line-width': 7, 'line-opacity': 0.65 },
      });
      map.addLayer({
        id: lineId,
        type: 'line',
        source: sourceId,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': color, 'line-width': 4 },
      });
    } else {
      (map.getSource(sourceId) as maplibregl.GeoJSONSource).setData(data);
      map.setPaintProperty(lineId, 'line-color', color);
    }

    return () => removeLayers(map, [lineId, casingId], sourceId);
  }, [map, data, routeCode, color]);

  return null;
}
