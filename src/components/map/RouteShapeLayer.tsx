import { useEffect, useMemo } from 'react';
import { useRoadShape } from '@/hooks/useRoadShape';
import { riddenShape } from '@/lib/transit/routeShape';
import type { LatLng } from '@/lib/geo';
import { useMap } from './MapContext';
import { removeLayers } from './removeLayers';

interface Props {
  routeCode: string;
  color: string;
  /** The route's stops in calling order, index-aligned to its `stops`. */
  stopPoints: readonly LatLng[];
  /** Where along that order the rider boards and alights. */
  boardIndex: number;
  alightIndex: number;
}

/**
 * Draws one route's real road geometry, in that route's own colour.
 *
 * The loop continues well past where the rider gets off, and often starts well
 * before they get on. Those stretches are drawn faint: they are context for
 * where the bus is headed, not part of anyone's journey, and at full strength
 * they read as a much longer trip than the one being taken.
 */
export function RouteShapeLayer({ routeCode, color, stopPoints, boardIndex, alightIndex }: Props) {
  const map = useMap();
  const { data } = useRoadShape(routeCode);

  // Falls back to the shape as it came, drawn whole, when the ride cannot be
  // placed on it — a faded route is worse than an undifferentiated one.
  const shape = useMemo(
    () => (data ? (riddenShape(data, stopPoints, boardIndex, alightIndex) ?? data) : null),
    [data, stopPoints, boardIndex, alightIndex],
  );

  useEffect(() => {
    if (!shape) return;
    const sourceId = `shape-${routeCode}`;
    const casingId = `${sourceId}-casing`;
    const lineId = `${sourceId}-line`;

    if (!map.getSource(sourceId)) {
      map.addSource(sourceId, { type: 'geojson', data: shape });
      // A dark casing underneath keeps bright route colours legible on the map.
      map.addLayer({
        id: casingId,
        type: 'line',
        source: sourceId,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#0b1120',
          'line-width': 7,
          // Untagged features are a whole route with no ride to pick out of it.
          'line-opacity': ['case', ['==', ['get', 'ridden'], false], 0.2, 0.65],
        },
      });
      map.addLayer({
        id: lineId,
        type: 'line',
        source: sourceId,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': color,
          'line-width': 4,
          'line-opacity': ['case', ['==', ['get', 'ridden'], false], 0.3, 1],
        },
      });
    } else {
      (map.getSource(sourceId) as maplibregl.GeoJSONSource).setData(shape);
      map.setPaintProperty(lineId, 'line-color', color);
    }

    return () => removeLayers(map, [lineId, casingId], sourceId);
  }, [map, shape, routeCode, color]);

  return null;
}
