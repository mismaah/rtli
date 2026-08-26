import type { LatLng } from '@/lib/geo';
import { polylinesOf, type Polyline } from './snapToRoute';

/**
 * Working out which part of a route's road geometry a rider actually sits on.
 *
 * RTL's `roadshape` is one unbroken line around the whole loop — out to the far
 * end and back — while a journey uses one arc of it. Drawing the whole thing at
 * full strength tells the rider that the loop matters when only their arc does,
 * so the arc has to be cut out of the line before it can be drawn differently
 * from the rest.
 *
 * Cutting it means knowing where each stop sits along the line, and that is not
 * the nearest point: out and back share the same streets in Malé, so a stop's
 * nearest point is often the opposite carriageway, half a loop from where the
 * bus passes it. What disambiguates them is the order the route calls at them —
 * so every plausible point per stop is found first, then the sequence is chosen
 * that runs forward around the loop, which is the only one a bus could drive.
 */

/** Beyond this, geometry is not passing the stop at all. Stops sit ~10 m off. */
const MAX_STOP_OFFSET_M = 60;

/** Metres per degree, near enough at Malé's latitude. */
const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LNG = 111_320;

export interface ShapePath {
  line: Polyline;
  /** Metres from the line's start to each of its points, index-aligned to `line`. */
  cumulative: number[];
  /** Length of the whole line, in metres. */
  length: number;
}

/**
 * The route's geometry as one measured line, or null when it isn't one.
 *
 * Every Greater Malé route comes back as a single LineString covering the whole
 * loop. A route that ever arrives in pieces has no unambiguous "along", so it
 * returns null and the caller draws the shape whole rather than guessing.
 */
export function shapePath(shape: GeoJSON.FeatureCollection | null | undefined): ShapePath | null {
  const lines = polylinesOf(shape);
  if (lines.length !== 1) return null;

  const line = lines[0];
  const cumulative = [0];
  for (let i = 1; i < line.length; i++) {
    cumulative.push(cumulative[i - 1] + metersBetween(line[i - 1], line[i]));
  }

  const length = cumulative[cumulative.length - 1];
  return length > 0 ? { line, cumulative, length } : null;
}

function metersBetween(a: [number, number], b: [number, number]): number {
  const dx = (b[0] - a[0]) * M_PER_DEG_LNG * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

interface Candidate {
  /** Metres along the line. */
  along: number;
  offsetM: number;
}

/**
 * Every place the line passes close to `point`, one per approach.
 *
 * A stop the bus passes twice — once each way down the same street — produces
 * two candidates, and it is the caller's job to pick between them.
 */
function candidatesFor(path: ShapePath, point: LatLng): Candidate[] {
  const { line, cumulative } = path;
  const scaleLng = M_PER_DEG_LNG * Math.cos((point.lat * Math.PI) / 180);
  const found: Candidate[] = [];
  let closest: Candidate | null = null;

  let ax = (line[0][0] - point.lng) * scaleLng;
  let ay = (line[0][1] - point.lat) * M_PER_DEG_LAT;

  for (let i = 1; i < line.length; i++) {
    const bx = (line[i][0] - point.lng) * scaleLng;
    const by = (line[i][1] - point.lat) * M_PER_DEG_LAT;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    // The projection is centred on the stop, so a point's distance from the stop
    // is just its own magnitude.
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
    const px = ax + t * dx;
    const py = ay + t * dy;
    const offsetM = Math.hypot(px, py);

    if (offsetM <= MAX_STOP_OFFSET_M) {
      // One pass may run close for many segments; only its nearest point counts.
      if (!closest || offsetM < closest.offsetM) {
        closest = { along: cumulative[i - 1] + (cumulative[i] - cumulative[i - 1]) * t, offsetM };
      }
    } else if (closest) {
      found.push(closest);
      closest = null;
    }

    ax = bx;
    ay = by;
  }

  if (closest) found.push(closest);
  return found;
}

/**
 * How far along the line each stop sits, in the order the route calls at them.
 *
 * Returns metres that only increase, so a loop's return leg lands past its
 * outbound one rather than back at the start; values may therefore exceed the
 * line's length by up to one lap. Null when any stop is nowhere near the
 * geometry, or when no forward-running sequence fits it at all.
 */
export function stopOffsets(path: ShapePath, points: readonly LatLng[]): number[] | null {
  if (points.length === 0) return null;

  const columns: Candidate[][] = [];
  for (const point of points) {
    const found = candidatesFor(path, point);
    if (found.length === 0) return null;
    // A stop late in the route may be a lap on from where the line first passes
    // it, so each candidate is offered again one full loop further along.
    columns.push([...found, ...found.map((c) => ({ ...c, along: c.along + path.length }))]);
  }

  // Cheapest forward-running assignment, scored on squared offset so one badly
  // placed stop is never traded for small gains across the rest.
  const cost: number[][] = [];
  const from: number[][] = [];

  columns.forEach((column, k) => {
    cost.push(column.map((c) => (k === 0 ? c.offsetM * c.offsetM : Infinity)));
    from.push(column.map(() => -1));
    if (k === 0) return;

    column.forEach((candidate, j) => {
      columns[k - 1].forEach((previous, i) => {
        if (previous.along > candidate.along) return;
        const total = cost[k - 1][i] + candidate.offsetM * candidate.offsetM;
        if (total < cost[k][j]) {
          cost[k][j] = total;
          from[k][j] = i;
        }
      });
    });
  });

  const last = cost.length - 1;
  let best = -1;
  cost[last].forEach((c, j) => {
    if (c < Infinity && (best < 0 || c < cost[last][best])) best = j;
  });
  if (best < 0) return null;

  const offsets = new Array<number>(columns.length);
  for (let k = last; k >= 0; k--) {
    offsets[k] = columns[k][best].along;
    best = from[k][best];
    if (best < 0 && k > 0) return null;
  }
  return offsets;
}

/** The `[lng, lat]` a given distance along the line. */
function pointAt(path: ShapePath, along: number): [number, number] {
  const { line, cumulative } = path;
  const target = Math.max(0, Math.min(path.length, along));

  let low = 0;
  let high = line.length - 1;
  while (low < high - 1) {
    const mid = (low + high) >> 1;
    if (cumulative[mid] <= target) low = mid;
    else high = mid;
  }

  const span = cumulative[high] - cumulative[low];
  const t = span === 0 ? 0 : (target - cumulative[low]) / span;
  return [
    line[low][0] + (line[high][0] - line[low][0]) * t,
    line[low][1] + (line[high][1] - line[low][1]) * t,
  ];
}

/** The stretch of line between two distances along it, cut exactly at each end. */
function sliceRange(path: ShapePath, from: number, to: number): Polyline {
  const { line, cumulative } = path;
  const out: Polyline = [pointAt(path, from)];
  for (let i = 0; i < line.length; i++) {
    if (cumulative[i] <= from) continue;
    if (cumulative[i] >= to) break;
    out.push(line[i]);
  }
  out.push(pointAt(path, to));
  return out;
}

export interface ShapeSplit {
  /** The stretch between boarding and alighting. */
  ridden: Polyline[];
  /** The rest of the loop, which this journey never sits on. */
  rest: Polyline[];
}

/**
 * The loop cut in two at the boarding and alighting points.
 *
 * A ride that runs past the end of the line — the return leg of a loop whose
 * geometry starts mid-journey — comes back as two pieces rather than one wrong
 * one spanning the wrong way round.
 */
export function splitAlong(path: ShapePath, fromAlong: number, toAlong: number): ShapeSplit | null {
  const { length } = path;
  const from = wrap(fromAlong, length);
  const to = wrap(toAlong, length);
  // Boarding and alighting at the same point leaves nothing to draw either way.
  if (Math.abs(to - from) < 1) return null;

  const split =
    to > from
      ? {
          ridden: [sliceRange(path, from, to)],
          rest: [sliceRange(path, 0, from), sliceRange(path, to, length)],
        }
      : {
          ridden: [sliceRange(path, from, length), sliceRange(path, 0, to)],
          rest: [sliceRange(path, to, from)],
        };

  return {
    ridden: split.ridden.filter(drawable),
    rest: split.rest.filter(drawable),
  };
}

function drawable(line: Polyline): boolean {
  return line.length >= 2;
}

function wrap(value: number, length: number): number {
  return ((value % length) + length) % length;
}

/**
 * A route's geometry tagged with whether the rider is on it, ready for the map.
 *
 * Null when the ride cannot be located on the shape — a route that arrives in
 * pieces, a stop the geometry misses, or a board and alight that land on the
 * same spot — so the caller can draw the route whole instead of drawing a guess.
 */
export function riddenShape(
  shape: GeoJSON.FeatureCollection | null | undefined,
  stopPoints: readonly LatLng[],
  boardIndex: number,
  alightIndex: number,
): GeoJSON.FeatureCollection | null {
  if (boardIndex < 0 || alightIndex <= boardIndex || alightIndex >= stopPoints.length) return null;

  const path = shapePath(shape);
  if (!path) return null;

  const offsets = stopOffsets(path, stopPoints);
  if (!offsets) return null;

  const split = splitAlong(path, offsets[boardIndex], offsets[alightIndex]);
  if (!split || split.ridden.length === 0) return null;

  return {
    type: 'FeatureCollection',
    features: [
      ...split.rest.map((line) => lineFeature(line, false)),
      ...split.ridden.map((line) => lineFeature(line, true)),
    ],
  };
}

function lineFeature(coordinates: Polyline, ridden: boolean): GeoJSON.Feature {
  return {
    type: 'Feature',
    properties: { ridden },
    geometry: { type: 'LineString', coordinates },
  };
}

/** Every stop the route calls at between boarding and alighting, inclusive. */
export function riddenStopCodes(
  stopCodes: readonly string[],
  boardIndex: number,
  alightIndex: number,
): string[] {
  if (boardIndex < 0 || alightIndex < boardIndex) return [];
  return stopCodes.slice(boardIndex, alightIndex + 1);
}
