import { walkSeconds, type LatLng } from '@/lib/geo';
import type { WalkPath } from '@/api/walking';
import { finalizeItinerary } from './plan';
import type { Itinerary, Leg } from './types';

/**
 * Routed footpaths, folded back into a journey the rider has chosen.
 *
 * The planner has to stay synchronous and cheap — it measures hundreds of stop
 * pairs per search, and no network round trip belongs in that loop — so it
 * settles for the crow flies inflated by a detour factor. Once a rider commits
 * to one trip, though, there are only two or three walks left to describe, and
 * they are worth describing properly: the real path is what the map draws, its
 * real length is what the sheet quotes, and how long it takes follows from that
 * length at the same pace the planner assumed.
 */

/**
 * Identity of a walk between two points, rounded to ~11 m.
 *
 * Nothing about a footpath changes over that distance, so a rider's location
 * drifting a few metres between fixes reuses the answer rather than asking a
 * shared public router the same question again.
 */
export function walkPathKey(from: LatLng, to: LatLng): string {
  return `${point(from)}>${point(to)}`;
}

function point(p: LatLng): string {
  return `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
}

/**
 * `itinerary` with every walk leg that has a routed path measured along it.
 *
 * Returned unchanged, and identically, when no path applies — the trip detail
 * screen re-derives this on every live-times poll, and a fresh object each time
 * would restart the map's fit and redraw the layers underneath the rider.
 */
export function applyWalkPaths(itinerary: Itinerary, paths: Map<string, WalkPath>): Itinerary {
  if (paths.size === 0) return itinerary;

  let routed = false;
  const legs: Leg[] = itinerary.legs.map((leg) => {
    if (leg.kind !== 'walk') return leg;
    const path = paths.get(walkPathKey(leg.from, leg.to));
    if (!path) return leg;
    routed = true;
    return {
      ...leg,
      meters: path.meters,
      // The router's own duration is discarded: it walks at its own pace, and a
      // detail screen that disagreed with the results list about how long the
      // same walk takes would look broken. Only the distance is news.
      seconds: walkSeconds(path.meters),
      path: path.coordinates,
    };
  });

  // Leaving later or arriving earlier than the walk allows is the whole point of
  // measuring it, so the door-to-door times are rebuilt from the new legs.
  return routed ? finalizeItinerary(legs, itinerary.id) : itinerary;
}

/** The `[lng, lat]` line to draw for a walk leg: its real path, else the direct line. */
export function walkLineOf(leg: Extract<Leg, { kind: 'walk' }>): [number, number][] {
  return (
    leg.path ?? [
      [leg.from.lng, leg.from.lat],
      [leg.to.lng, leg.to.lat],
    ]
  );
}
