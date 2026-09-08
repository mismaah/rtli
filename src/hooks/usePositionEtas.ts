import { useEffect, useReducer, useRef } from 'react';
import { useQueries } from '@tanstack/react-query';
import { commitTracks, readTracks, subscribeTracks } from '@/lib/transit/trackStore';
import { polylinesOf, snapToRoute } from '@/lib/transit/snapToRoute';
import { shapePath, type ShapePath } from '@/lib/transit/routeShape';
import { hourOf, positionEtas, routeProgress, type RouteProgress } from '@/lib/transit/positionEta';
import type { TrackedBus } from '@/lib/transit/busTracks';
import type { LiveEtaIndex, RouteMeasurements, TransitGraph } from '@/lib/transit/types';
import { liveBusesQuery } from './useLiveBuses';
import { roadShapeQuery } from './useRoadShape';
import { useStreamedRoutes } from './useLiveStream';
import { usePageVisible } from './usePageVisible';
import { useNowMinutes } from './useNowMinutes';

/**
 * Arrivals this app works out for itself, from where the buses actually are.
 *
 * RTL's own ETA feed cannot answer "when is the next bus at this stop" — it
 * projects one vehicle around the whole loop and hands every stop on the way the
 * time that vehicle would reach it, ignoring the buses already in between. See
 * `positionEta.ts` for the measurements behind that. This hook gathers the three
 * things needed to answer it properly and hands the planner an index in exactly
 * the shape RTL's own readings arrive in, so the two are interchangeable.
 *
 * Nothing here is fetched that the app was not already fetching. The geometry
 * and the positions come from the same react-query keys the map draws from, so a
 * route already on screen costs nothing, and the positions are fed by the SSE
 * stream wherever one is open rather than polled a second time.
 */

/**
 * A route's geometry and its stop ladder, kept between renders.
 *
 * Both are pure functions of the shape, the measurements and the hour, and both
 * walk a few hundred coordinates to build. They live at module scope for the
 * same reason the track history does: they are not render state, they outlive
 * any one screen, and rebuilding them on a poll would be the only expensive
 * thing this hook does.
 */
interface Ladder {
  shape: GeoJSON.FeatureCollection | null;
  measured: RouteMeasurements | undefined;
  hour: number;
  path: ShapePath | null;
  progress: RouteProgress | null;
}

const ladders = new Map<string, Ladder>();

function ladderFor(
  graph: TransitGraph,
  routeCode: string,
  shape: GeoJSON.FeatureCollection | null | undefined,
  hour: number,
): Ladder | null {
  if (!shape) return null;

  const route = graph.routes.get(routeCode);
  if (!route) return null;

  const cached = ladders.get(routeCode);
  // The measurements arrive once, well after the shape, and change the ladder
  // without changing the geometry — so they are part of what makes it stale.
  if (cached && cached.shape === shape && cached.hour === hour && cached.measured === route.measured) {
    return cached;
  }

  const path = shapePath(shape);
  const points = route.stops.map((stop) => graph.stops.get(stop.stopCode)).filter((s) => s != null);
  const progress =
    path && points.length === route.stops.length
      ? routeProgress(route, path, points, hour * 60)
      : null;

  const built: Ladder = { shape, measured: route.measured, hour, path, progress };
  ladders.set(routeCode, built);
  return built;
}

/**
 * Where each route's buses were last placed on their loop.
 *
 * Fed back in on the next read so a bus on a street the route runs down twice
 * stays on the pass it was already on. Module scope because it is continuity
 * across polls, not state belonging to whichever screen happens to be mounted.
 */
const placements = new Map<string, Map<string, number>>();

const NO_ETAS: LiveEtaIndex = new Map();

export function usePositionEtas(
  graph: TransitGraph | undefined,
  routeCodes: string[],
): LiveEtaIndex {
  const visible = usePageVisible();
  const nowMinutes = useNowMinutes();
  const streamed = useStreamedRoutes();
  const [, bump] = useReducer((n: number) => n + 1, 0);

  // Sorted and joined so the work below re-runs on a real change of routes
  // rather than on every render that rebuilds the caller's array.
  const key = [...routeCodes].sort().join(',');
  const codes = key.length > 0 ? key.split(',') : [];

  const shapes = useQueries({ queries: codes.map((code) => roadShapeQuery(code)) });
  const positions = useQueries({
    queries: codes.map((code) => liveBusesQuery(code, visible && !streamed.has(code))),
  });

  // Snapped onto their route and folded into the shared history, exactly as
  // `useTrackedBuses` does for the route on screen. `commitTracks` ignores a
  // poll it has already folded, so the two never double-count each other.
  const buses = positions.map((result) => result.data);
  const updatedAt = positions.map((result) => result.dataUpdatedAt);
  const shapeData = shapes.map((result) => result.data);

  /**
   * One scalar standing for "there is something new to fold".
   *
   * A dependency array has to keep its length between renders, and the number of
   * routes being planned does not, so the per-route values cannot be spread into
   * one. A poll is identified by when it answered, and the shape matters only by
   * its presence — it decides whether the fix can be snapped before folding, and
   * it arrives once and never changes again.
   */
  const foldKey = codes.map((code, i) => `${code}:${updatedAt[i]}:${shapeData[i] ? 1 : 0}`).join('|');

  useEffect(() => {
    codes.forEach((code, i) => {
      const fixes = buses[i];
      const shape = shapeData[i];
      if (!fixes || !shape) return;

      const lines = polylinesOf(shape);
      if (lines.length === 0) return;

      const snapped: TrackedBus[] = fixes.map((bus) => {
        if (!Number.isFinite(bus.latitude) || !Number.isFinite(bus.longitude)) return bus;
        const at = snapToRoute({ lat: bus.latitude, lng: bus.longitude }, lines);
        return { ...bus, latitude: at.lat, longitude: at.lng };
      });
      commitTracks(code, snapped, updatedAt[i] || Date.now());
    });
  }, [foldKey]); // eslint-disable-line react-hooks/exhaustive-deps -- see above

  // The store is what actually holds the tracks, and it changes on commit rather
  // than on a query settling, so the render that reads it has to be woken by it.
  useEffect(() => {
    const stop = codes.map((code) => subscribeTracks(code, bump));
    return () => stop.forEach((off) => off());
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- `key` is `codes`

  const previous = useRef<{ deps: unknown[]; index: LiveEtaIndex } | null>(null);

  if (!graph || codes.length === 0) return NO_ETAS;

  const hour = hourOf(nowMinutes);
  const tracks = codes.map((code) => readTracks(code));
  const deps: unknown[] = [key, nowMinutes, graph, ...tracks, ...shapeData];

  // Recomputed only when something it reads has actually changed. The index
  // feeds a replan, and handing back a fresh Map on every render would have the
  // planner re-running on renders that told it nothing.
  const before = previous.current;
  if (before && before.deps.length === deps.length && before.deps.every((d, i) => d === deps[i])) {
    return before.index;
  }

  const now = Date.now();
  const index: LiveEtaIndex = new Map();

  codes.forEach((code, i) => {
    const ladder = ladderFor(graph, code, shapeData[i], hour);
    const route = graph.routes.get(code);
    if (!ladder?.path || !ladder.progress || !route || tracks[i].length === 0) return;

    const { etas, placed } = positionEtas(
      route,
      ladder.progress,
      ladder.path,
      tracks[i],
      nowMinutes,
      now,
      placements.get(code),
    );
    placements.set(code, placed);
    if (etas.size > 0) index.set(code, etas);
  });

  previous.current = { deps, index };
  return index;
}
