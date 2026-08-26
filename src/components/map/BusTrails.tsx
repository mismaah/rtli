import { useEffect, useMemo } from 'react';
import type { BusTrack } from '@/lib/transit/busTracks';
import { removeLayers } from './removeLayers';
import { useMap } from './MapContext';

/**
 * A fading tail behind each live bus, showing where it has just come from.
 *
 * Between ten-second polls a bus is a dot that moves; the tail is what makes it
 * a bus that is going somewhere. It is drawn from the positions the bus was
 * confirmed to have reached — the same ones the heading is inferred from — so it
 * traces real movement rather than the jitter of a parked vehicle, and it fades
 * out towards the oldest end so the bright end always reads as "now".
 *
 * The colour is the route's own, lightened. A trail in the flat route colour is
 * invisible: buses now ride the drawn line almost exactly, so the tail would be
 * one red line on another. Lightened and drawn narrower than the line, it reads
 * as a bright core running back down the road the bus has just covered.
 */
export function BusTrails({
  routeCode,
  color,
  tracks,
}: {
  routeCode: string;
  color: string;
  tracks: BusTrack[];
}) {
  const map = useMap();

  const data = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: tracks
        .filter((track) => track.trail.length > 0)
        .map((track) => ({
          type: 'Feature' as const,
          properties: { busCode: track.busCode },
          geometry: {
            type: 'LineString' as const,
            // Oldest first, ending at where the bus is now, which is what makes
            // `line-progress` run from the faded tail to the bright head.
            coordinates: [
              ...track.trail.map((p) => [p.lng, p.lat]),
              [track.lng, track.lat],
            ] as [number, number][],
          },
        })),
    }),
    [tracks],
  );

  const sourceId = `bus-trail-${routeCode}`;
  const lineId = `${sourceId}-line`;

  // Built once and then only fed: rebuilding the layer on every ten-second poll
  // would make the trail blink out and back each time it moved.
  useEffect(() => {
    if (map.getSource(sourceId)) return;
    // `lineMetrics` is what makes `line-progress` — and so the gradient —
    // available at all; without it the paint property is silently ignored.
    map.addSource(sourceId, {
      type: 'geojson',
      lineMetrics: true,
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: lineId,
      type: 'line',
      source: sourceId,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        // Never wider than the 4 px route line it usually sits on, so the
        // route's own colour still frames it.
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.75, 16, 3.5],
        'line-gradient': gradientFor(color),
      },
    });

    return () => removeLayers(map, [lineId], sourceId);
  }, [map, sourceId, lineId, color]);

  useEffect(() => {
    const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    source.setData(data);
    // Layers stack in the order they are added, and the route's own shape lands
    // whenever its geometry finishes downloading — after this one, most times,
    // which buries the trail under the very line it runs along. Lifting it back
    // to the top on each poll is what keeps it visible whatever order the two
    // queries resolve in.
    if (map.getLayer(lineId)) map.moveLayer(lineId);
  }, [map, sourceId, lineId, data]);

  return null;
}

/**
 * Transparent at the tail, bright at the bus. The stops are weighted towards the
 * head so a long trail reads as a direction of travel rather than an evenly
 * drawn line — most of its length is a hint, and only the last stretch is loud.
 */
function gradientFor(color: string): maplibregl.ExpressionSpecification {
  const rgb = parseHex(color);
  return [
    'interpolate',
    ['linear'],
    ['line-progress'],
    0,
    trailColor(rgb, 0.35, 0),
    0.45,
    trailColor(rgb, 0.45, 0.3),
    0.8,
    trailColor(rgb, 0.6, 0.72),
    1,
    trailColor(rgb, 0.75, 1),
  ];
}

/** Slate, so a route with a missing or malformed colour still shows a tail. */
const FALLBACK: [number, number, number] = [148, 163, 184];

function parseHex(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return FALLBACK;
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The route colour lifted `towardsWhite` of the way to white, at `alpha`. */
function trailColor(
  [r, g, b]: [number, number, number],
  towardsWhite: number,
  alpha: number,
): string {
  const lift = (channel: number) => Math.round(channel + (255 - channel) * towardsWhite);
  return `rgba(${lift(r)}, ${lift(g)}, ${lift(b)}, ${alpha})`;
}
