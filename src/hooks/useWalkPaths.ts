import { useMemo } from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { fetchWalkPath, type WalkPath } from '@/api/walking';
import { walkPathKey } from '@/lib/transit/walkPaths';
import type { Itinerary, WalkLeg } from '@/lib/transit/types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The answer carries its own key so `combine` needs nothing from the render. */
interface Answer {
  key: string;
  path: WalkPath | null;
}

export interface WalkPaths {
  /** Keyed by `walkPathKey`; a leg with no entry keeps the planner's estimate. */
  paths: Map<string, WalkPath>;
  pending: boolean;
}

/**
 * Real footpaths for one itinerary's walking legs.
 *
 * Only ever asked for the trip on screen. Every walk in Greater Malé is between
 * two of the same hundred-odd bus stops, so the cache fills quickly and a rider
 * comparing options pays for each walk once; footpaths do not move, hence the
 * infinite stale time.
 */
export function useWalkPaths(itinerary: Itinerary | null): WalkPaths {
  const legs = useMemo(
    () => itinerary?.legs.filter((leg): leg is WalkLeg => leg.kind === 'walk') ?? [],
    [itinerary],
  );

  return useQueries({
    queries: legs.map((leg) => {
      const key = walkPathKey(leg.from, leg.to);
      return {
        queryKey: ['walkpath', key],
        queryFn: async ({ signal }: { signal: AbortSignal }): Promise<Answer> => ({
          key,
          path: await fetchWalkPath(leg.from, leg.to, signal),
        }),
        staleTime: Infinity,
        gcTime: DAY_MS,
      };
    }),
    combine,
  });
}

/**
 * Declared at module scope: react-query memoises the combined value against
 * this function's identity, and a fresh closure per render would hand the
 * map a new Map on every poll.
 */
function combine(results: UseQueryResult<Answer, Error>[]): WalkPaths {
  const paths = new Map<string, WalkPath>();
  for (const result of results) {
    if (result.data?.path) paths.set(result.data.key, result.data.path);
  }
  return { paths, pending: results.some((r) => r.isPending) };
}
