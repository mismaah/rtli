import { haversineMeters, type LatLng } from '@/lib/geo';
import { nearestOnPath } from './snapToRoute';
import type { BusLeg, Itinerary, WalkLeg } from './types';

/**
 * A planned trip turned into the sequence of things the rider actually does.
 *
 * The planner thinks in legs — walk, ride, walk — but a bus leg is two different
 * situations to be in: standing at a stop watching for a bus that has not come
 * yet, and sitting on it counting stops. They need different instructions, a
 * different button and a different map, so a bus leg becomes two steps here.
 *
 * Steps carry stable ids rather than positions, because the itinerary underneath
 * is re-planned as live times land and the address bar has to keep pointing at
 * the same step across all of it.
 */

export type JourneyStepKind = 'walk' | 'wait' | 'ride' | 'arrive';

export interface JourneyStep {
  /** Stable and URL-safe — `walk-0`, `wait-1`, `ride-1`, `arrive`. */
  id: string;
  kind: JourneyStepKind;
  /** Index into `itinerary.legs`, or -1 for the closing arrival step. */
  legIndex: number;
  /** Where the rider is headed by the end of this step. */
  target: LatLng;
  targetName: string;
  walk?: WalkLeg;
  bus?: BusLeg;
}

/**
 * How close counts as "there".
 *
 * A bus stop is a pole on a pavement and a consumer GPS in Malé is good to
 * something like 20 m on a clear day and much worse between the tower blocks, so
 * the radius follows the accuracy the browser reports rather than pretending to
 * a precision the fix does not have.
 */
export const ARRIVE_RADIUS_M = 40;
export const MAX_ARRIVE_RADIUS_M = 120;

/** Far enough out that pressing the bell still leaves the rider time to stand up. */
export const APPROACH_RADIUS_M = 250;

/**
 * How far a fix may sit from what the rider has told the app before it stops
 * being believed. Wide enough to cover a step made on foot, since walking away
 * from where you last confirmed being is the whole point of a walking step.
 */
export const TRUST_M = 800;

/**
 * The same, for a ride, measured against the whole ride rather than its ends —
 * a rider halfway along is far from both. Loose enough that a loop through Malé
 * never strays outside the line drawn across it, tight enough that a fix left
 * behind on another island does.
 */
export const TRUST_RIDE_M = 1500;

/**
 * How far the bus being tracked may sit from the rider's own fix before the bus
 * stops being taken as where the rider is.
 *
 * Wide enough for a feed that polls every ten seconds and a phone that reports
 * from between the tower blocks, tight enough that a bus latched onto by mistake
 * — the one behind, at a stop where two were bunched — is noticed and dropped.
 */
export const VEHICLE_TRUST_M = 400;

/**
 * How close a tracked bus must be to the stop the rider just boarded at, or to
 * the rider themselves, to be taken as the one they are on. A poll can be ten
 * seconds old and a bus pulling away covers ground, so this is generous.
 */
export const BOARD_MATCH_M = 250;

export function arrivalRadius(accuracy?: number | null): number {
  if (!accuracy || !Number.isFinite(accuracy)) return ARRIVE_RADIUS_M;
  return Math.min(MAX_ARRIVE_RADIUS_M, Math.max(ARRIVE_RADIUS_M, accuracy));
}

export function buildJourney(itinerary: Itinerary | null | undefined): JourneyStep[] {
  if (!itinerary || itinerary.legs.length === 0) return [];

  const steps: JourneyStep[] = [];
  for (const [index, leg] of itinerary.legs.entries()) {
    if (leg.kind === 'walk') {
      steps.push({
        id: `walk-${index}`,
        kind: 'walk',
        legIndex: index,
        target: { lat: leg.to.lat, lng: leg.to.lng },
        targetName: leg.to.name,
        walk: leg,
      });
      continue;
    }
    steps.push({
      id: `wait-${index}`,
      kind: 'wait',
      legIndex: index,
      target: { lat: leg.boardStop.lat, lng: leg.boardStop.lng },
      targetName: leg.boardStop.name,
      bus: leg,
    });
    steps.push({
      id: `ride-${index}`,
      kind: 'ride',
      legIndex: index,
      target: { lat: leg.alightStop.lat, lng: leg.alightStop.lng },
      targetName: leg.alightStop.name,
      bus: leg,
    });
  }

  const last = itinerary.legs[itinerary.legs.length - 1];
  const end =
    last.kind === 'walk'
      ? { point: { lat: last.to.lat, lng: last.to.lng }, name: last.to.name }
      : { point: { lat: last.alightStop.lat, lng: last.alightStop.lng }, name: last.alightStop.name };

  steps.push({
    id: 'arrive',
    kind: 'arrive',
    legIndex: -1,
    target: end.point,
    targetName: end.name,
  });

  return steps;
}

/**
 * Where the rider is, reconciling what they have said with what the phone says.
 *
 * A tap is a statement of fact: someone who presses *I've got off* is standing
 * at that stop. A fix is an inference, and a stale or refused one is not even
 * that — a phone that last saw the sky in Malé will happily report Malé while
 * its owner steps off a bus in Hulhumalé. So the last stop the rider confirmed
 * is the anchor, and the fix is taken over it only when the two are close enough
 * to be telling the same story.
 *
 * Riding is the exception only in how it is judged: a bus covers kilometres
 * between one confirmation and the next, so the fix is measured against the ride
 * itself instead of its ends. A rider who has just told the app they boarded in
 * Hulhumalé is not in Malé, however sure the phone is that they are.
 *
 * And riding is where a better answer than the phone exists. Once the bus the
 * rider boarded has been identified in the live feed, `vehicle` is that bus's
 * position, and it wins: it is reported by a tracker with a roof aerial and a
 * power supply, it is already pulled back onto the route, and it keeps coming
 * while the rider's phone is face-down in a bag. See `pickBoardedBus`.
 */
export function believedPosition(
  step: JourneyStep | null,
  anchor: LatLng | null,
  fix: (LatLng & { accuracy?: number }) | null,
  vehicle?: LatLng | null,
): (LatLng & { accuracy?: number }) | null {
  if (step?.kind === 'ride' && vehicle) {
    // A rider who has said they boarded is wherever that bus is, and the fleet
    // tracker keeps reporting while their phone is in a pocket losing the sky.
    // The fix is still the check on it: if the two have drifted apart, the bus
    // being followed is the wrong one, and the phone is the better guess again.
    if (!fix || haversineMeters(fix, vehicle) <= VEHICLE_TRUST_M) {
      return { lat: vehicle.lat, lng: vehicle.lng };
    }
  }

  if (!fix) return anchor;
  if (!anchor || !step) return fix;

  if (step.kind === 'ride') {
    const chord = [
      [anchor.lng, anchor.lat],
      [step.target.lng, step.target.lat],
    ] as [number, number][];
    const offset = nearestOnPath(fix, [chord])?.offsetM ?? Infinity;
    return offset <= TRUST_RIDE_M ? fix : anchor;
  }

  const agrees =
    haversineMeters(fix, anchor) <= TRUST_M || haversineMeters(fix, step.target) <= TRUST_M;
  return agrees ? fix : anchor;
}

export interface StepProgress {
  /** Metres from the rider to where this step ends, or null with no fix. */
  metersToTarget: number | null;
  /** Close enough that this step can be considered done. */
  atTarget: boolean;
  /** Riding, and the stop to get off at is coming up — time to press the bell. */
  approaching: boolean;
}

const NO_FIX: StepProgress = { metersToTarget: null, atTarget: false, approaching: false };

export function stepProgress(
  step: JourneyStep | null,
  position: (LatLng & { accuracy?: number }) | null,
): StepProgress {
  if (!step || !position) return NO_FIX;
  const meters = haversineMeters(position, step.target);
  const radius = arrivalRadius(position.accuracy);
  return {
    metersToTarget: meters,
    atTarget: meters <= radius,
    approaching: step.kind === 'ride' && meters <= APPROACH_RADIUS_M,
  };
}

/**
 * Whether the app may move the rider on by itself.
 *
 * Only walking does. Arriving at a stop on foot is unambiguous — the rider is
 * standing where the step told them to stand — but being beside a bus and being
 * on it are the same coordinates, and a journey that boarded the rider onto a
 * bus they watched pull away would be worse than one that waits to be told. The
 * same goes for getting off: the bus passes the alighting stop whether or not
 * the rider stands up. Those two stay on the button.
 */
export function shouldAutoAdvance(step: JourneyStep | null, progress: StepProgress): boolean {
  return step?.kind === 'walk' && progress.atTarget;
}

/**
 * Stops still to go before the rider gets off, counted from where they are.
 *
 * `stops` is the run the rider is aboard for, board to alight inclusive. The
 * nearest one is taken as the one just passed, which is exactly right in the
 * seconds around a stop and never worse than one out between them — enough for
 * "3 stops to go", which is how riders track a bus anyway.
 */
export function stopsRemaining(
  stops: readonly LatLng[],
  position: LatLng | null | undefined,
): number | null {
  if (!position || stops.length < 2) return null;

  let nearest = 0;
  let best = Infinity;
  for (const [index, stop] of stops.entries()) {
    const meters = haversineMeters(position, stop);
    if (meters < best) {
      best = meters;
      nearest = index;
    }
  }
  return stops.length - 1 - nearest;
}

/**
 * Which of a route's live buses is the one the rider just boarded.
 *
 * The rider's tap is the timing: at that moment the bus they got on is at the
 * stop they were standing at, so proximity identifies it. Where the ETA feed
 * named a vehicle for that stop, that name breaks the tie between two buses
 * bunched at the same kerb — which is exactly when proximity alone is weakest.
 *
 * A named bus that the feed puts nowhere near is still accepted as a last
 * resort: it is a claim about this stop from the operator, and following the
 * wrong bus is caught later by `believedPosition` comparing it to the fix.
 */
export function pickBoardedBus(
  tracks: readonly (LatLng & { busCode: string })[],
  near: LatLng,
  expectedCode?: string | null,
): string | null {
  let nearest: string | null = null;
  let best = BOARD_MATCH_M;

  for (const track of tracks) {
    const meters = haversineMeters(near, track);
    if (meters > BOARD_MATCH_M) continue;
    if (expectedCode && track.busCode === expectedCode) return track.busCode;
    if (meters < best) {
      best = meters;
      nearest = track.busCode;
    }
  }

  if (nearest) return nearest;
  if (expectedCode && tracks.some((t) => t.busCode === expectedCode)) return expectedCode;
  return null;
}

/** Where the rider is up to, as a fraction, for the progress bar. */
export function journeyFraction(steps: readonly JourneyStep[], index: number): number {
  if (steps.length <= 1) return index > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, index / (steps.length - 1)));
}
