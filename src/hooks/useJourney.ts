import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  believedPosition,
  buildJourney,
  shouldAutoAdvance,
  stepProgress,
  type JourneyStep,
  type StepProgress,
} from '@/lib/transit/journey';
import { minutesOfDay } from '@/lib/time';
import { useBoardedBus, type BoardedBus } from './useBoardedBus';
import type { LatLng } from '@/lib/geo';
import type { Itinerary } from '@/lib/transit/types';

/**
 * What the believed position is actually standing on: the bus being followed,
 * the phone's own fix, or nothing but the last stop the rider confirmed — which
 * is a memory rather than an observation, and cannot be counted from.
 */
export type PositionSource = 'vehicle' | 'fix' | 'anchor';

export interface Journey {
  /** True while the rider is travelling rather than reading about travelling. */
  active: boolean;
  steps: JourneyStep[];
  step: JourneyStep | null;
  index: number;
  progress: StepProgress;
  /**
   * Where the rider is taken to be — the bus they boarded while that is being
   * followed, otherwise the fix, otherwise the last stop they confirmed. See
   * `believedPosition`.
   */
  position: (LatLng & { accuracy?: number }) | null;
  /** The bus being followed, while riding one the live feed can find. */
  vehicle: BoardedBus | null;
  /** Where `position` came from, or null when there is no position at all. */
  positionSource: PositionSource | null;
  /** Minutes since Malé midnight the journey began, for the elapsed clock. */
  startedAt: number | null;
  /** True once the rider is on the closing step. */
  finished: boolean;
  start: () => void;
  advance: () => void;
  rewind: () => void;
  end: () => void;
}

interface Options {
  /** A step id from the address bar, resumed once the itinerary behind it exists. */
  initialStepId?: string | null;
  /** Minutes since Malé midnight the resumed journey began. */
  initialStartedAt?: number | null;
}

/**
 * The rider's position within a journey they are actually making.
 *
 * Held by step id rather than by index, because the itinerary underneath is
 * replanned every time live times land: the same journey comes back as a new
 * object, and an index into the old one would quietly slide the rider to a
 * different instruction. An id survives that, and is also what goes in the URL.
 *
 * Steps advance on a tap. The one exception is walking, which the fix can settle
 * on its own — see `shouldAutoAdvance` for why boarding and alighting may not.
 *
 * Progress through a ride is read off the bus rather than the rider wherever the
 * live feed can identify it, because a phone in a pocket is the one witness that
 * stops reporting halfway through — see `useBoardedBus`.
 */
export function useJourney(
  itinerary: Itinerary | null,
  position: (LatLng & { accuracy?: number }) | null,
  { initialStepId = null, initialStartedAt = null }: Options = {},
): Journey {
  const [stepId, setStepId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const pendingStepId = useRef(initialStepId);
  const pendingStartedAt = useRef(initialStartedAt);

  const steps = useMemo(() => buildJourney(itinerary), [itinerary]);

  /**
   * Picks up a journey a shared link or a reload arrived in the middle of. One
   * shot: once the itinerary has produced its steps the request is spent, so a
   * later replan cannot drag the rider back to where the URL found them.
   */
  useEffect(() => {
    const wanted = pendingStepId.current;
    if (!wanted || steps.length === 0) return;
    pendingStepId.current = null;
    if (!steps.some((s) => s.id === wanted)) return;
    setStepId(wanted);
    setStartedAt(pendingStartedAt.current ?? Math.floor(minutesOfDay()));
    pendingStartedAt.current = null;
  }, [steps]);

  const index = stepId ? steps.findIndex((s) => s.id === stepId) : -1;
  const step = index >= 0 ? steps[index] : null;
  const active = step !== null;

  /**
   * The last place the rider said they were: the end of the step they completed.
   * Nothing is assumed before the first tap — at the opening step the fix is all
   * anyone has, and a planned origin is not something the rider has confirmed.
   */
  const anchor = index > 0 ? steps[index - 1].target : null;
  const vehicle = useBoardedBus(step, position);
  const believed = useMemo(
    () => believedPosition(step, anchor, position, vehicle),
    [step, anchor, position, vehicle],
  );
  // `believedPosition` hands back one of the three it was given, so which one it
  // chose is readable off identity rather than by repeating its reasoning here.
  const positionSource: PositionSource | null =
    believed === null
      ? null
      : believed === position
        ? 'fix'
        : believed === anchor
          ? 'anchor'
          : 'vehicle';

  /**
   * A ride falls back to the stop the rider boarded at, which is a fact about
   * the past and says nothing about how far along they now are. Measuring the
   * alighting stop against it would ring the get-off alert on a short hop the
   * moment the rider sat down, so an unobserved ride reports no progress at all.
   */
  const observed = step?.kind !== 'ride' || positionSource !== 'anchor';
  const progress = useMemo(
    () => stepProgress(step, observed ? believed : null),
    [step, believed, observed],
  );

  const start = useCallback(() => {
    const first = steps[0];
    if (!first) return;
    setStepId(first.id);
    setStartedAt(Math.floor(minutesOfDay()));
  }, [steps]);

  const advance = useCallback(() => {
    setStepId((current) => {
      const at = steps.findIndex((s) => s.id === current);
      if (at < 0) return current;
      return steps[Math.min(at + 1, steps.length - 1)].id;
    });
  }, [steps]);

  const rewind = useCallback(() => {
    setStepId((current) => {
      const at = steps.findIndex((s) => s.id === current);
      if (at <= 0) return current;
      return steps[at - 1].id;
    });
  }, [steps]);

  const end = useCallback(() => {
    pendingStepId.current = null;
    setStepId(null);
    setStartedAt(null);
  }, []);

  // A journey whose itinerary has gone — a different trip chosen, the plan
  // emptied — has nothing left to instruct anyone about.
  useEffect(() => {
    if (stepId && steps.length === 0) end();
  }, [stepId, steps, end]);

  useEffect(() => {
    if (active && shouldAutoAdvance(step, progress)) advance();
  }, [active, step, progress, advance]);

  // A short buzz on every change of instruction, for the rider whose phone is in
  // a pocket on the walk over or who is watching the road rather than the screen.
  const previousStep = useRef<string | null>(null);
  useEffect(() => {
    const changed = previousStep.current !== null && previousStep.current !== stepId;
    previousStep.current = stepId;
    if (changed && stepId) buzz(30);
  }, [stepId]);

  // And a longer one when the stop to get off at comes into range, which is the
  // moment a rider most needs telling and least likely to be looking.
  const alerted = useRef<string | null>(null);
  useEffect(() => {
    if (!step || step.kind !== 'ride' || !progress.approaching) return;
    if (alerted.current === step.id) return;
    alerted.current = step.id;
    buzz([60, 80, 60]);
  }, [step, progress.approaching]);

  return {
    active,
    steps,
    step,
    index,
    progress,
    position: believed,
    vehicle,
    positionSource,
    startedAt,
    finished: active && index === steps.length - 1,
    start,
    advance,
    rewind,
    end,
  };
}

function buzz(pattern: number | number[]): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Blocked by the browser, or unsupported despite being present. Cosmetic.
  }
}
