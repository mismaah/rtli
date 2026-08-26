import type { LatLng } from '@/lib/geo';

/**
 * Pulling a live bus back onto the road it is driving down.
 *
 * RTL's positions come off a vehicle tracker in a dense low-rise city, and in
 * Malé that regularly means a bus drawn a block off its own route — through
 * buildings, or in the lagoon beside the Hulhumalé link road. The route geometry
 * is known exactly, so a position a little way off it is far more likely to be a
 * bad fix than a bus that has left its route.
 *
 * "A little way" is the whole of the judgement here. A correction is applied in
 * full only within `FULL_SNAP_M`, tapers to nothing by `NO_SNAP_M`, and is never
 * applied beyond it: a bus 200 m from its route is not suffering GPS error, it
 * is on a diversion, running out of service, or the shape is incomplete — and
 * teleporting it onto the line would invent a fact rather than clean one up.
 */

/** Within this, the nearest point on the route is taken as the truth. */
export const FULL_SNAP_M = 40;
/** Past this, the reported position stands. Between the two, it is eased over. */
export const NO_SNAP_M = 120;

/** A route's geometry as flat polylines of [lng, lat], the order GeoJSON uses. */
export type Polyline = [number, number][];

export interface SnapResult extends LatLng {
  /** How far the reported position was from the route, in metres. */
  offsetM: number;
  /** How far the position was moved, in metres. Zero when it was left alone. */
  movedM: number;
}

/** Metres per degree, near enough at Malé's latitude for distances this short. */
const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LNG = 111_320;

/** Every LineString in a route's road shape, ready to snap against. */
export function polylinesOf(shape: GeoJSON.FeatureCollection | null | undefined): Polyline[] {
  if (!shape?.features) return [];
  const lines: Polyline[] = [];

  for (const feature of shape.features) {
    const geometry = feature.geometry;
    if (geometry?.type === 'LineString') {
      lines.push(geometry.coordinates as Polyline);
    } else if (geometry?.type === 'MultiLineString') {
      for (const line of geometry.coordinates) lines.push(line as Polyline);
    }
  }

  return lines.filter((line) => line.length >= 2);
}

/**
 * Nearest point on the route to `point`, or null when there is no geometry.
 *
 * Distances are computed in a local flat projection centred on the point, which
 * is accurate to well under a metre over the tens of metres that matter here and
 * avoids a haversine per segment.
 */
export function nearestOnPath(point: LatLng, lines: readonly Polyline[]): SnapResult | null {
  const scaleLng = M_PER_DEG_LNG * Math.cos((point.lat * Math.PI) / 180);
  const toX = (lng: number) => (lng - point.lng) * scaleLng;
  const toY = (lat: number) => (lat - point.lat) * M_PER_DEG_LAT;

  let best = Infinity;
  let bestLat = point.lat;
  let bestLng = point.lng;

  for (const line of lines) {
    let ax = toX(line[0][0]);
    let ay = toY(line[0][1]);

    for (let i = 1; i < line.length; i++) {
      const bx = toX(line[i][0]);
      const by = toY(line[i][1]);
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSq = dx * dx + dy * dy;
      // The origin of this projection is the bus itself, so the distance to a
      // point on the segment is just its own magnitude.
      const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
      const px = ax + t * dx;
      const py = ay + t * dy;
      const distSq = px * px + py * py;

      if (distSq < best) {
        best = distSq;
        bestLng = point.lng + px / scaleLng;
        bestLat = point.lat + py / M_PER_DEG_LAT;
      }

      ax = bx;
      ay = by;
    }
  }

  if (best === Infinity) return null;
  const offsetM = Math.sqrt(best);
  return { lat: bestLat, lng: bestLng, offsetM, movedM: offsetM };
}

/**
 * The reported position, corrected towards the route as far as it deserves.
 *
 * Returns the point unchanged when there is no geometry to snap to, so a route
 * whose shape has not loaded yet simply behaves as it did before.
 */
export function snapToRoute(
  point: LatLng,
  lines: readonly Polyline[],
  fullSnapM = FULL_SNAP_M,
  noSnapM = NO_SNAP_M,
): SnapResult {
  const nearest = nearestOnPath(point, lines);
  if (!nearest) return { lat: point.lat, lng: point.lng, offsetM: 0, movedM: 0 };

  const { offsetM } = nearest;
  const pull =
    offsetM <= fullSnapM
      ? 1
      : offsetM >= noSnapM
        ? 0
        : (noSnapM - offsetM) / (noSnapM - fullSnapM);

  if (pull <= 0) return { lat: point.lat, lng: point.lng, offsetM, movedM: 0 };
  if (pull >= 1) return nearest;

  return {
    lat: point.lat + (nearest.lat - point.lat) * pull,
    lng: point.lng + (nearest.lng - point.lng) * pull,
    offsetM,
    movedM: offsetM * pull,
  };
}
