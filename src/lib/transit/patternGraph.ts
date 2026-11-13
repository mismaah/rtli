import type { HistorySummary } from '@/api/history';
import type { RouteDetailsResponse } from '@/api/rtl';
import { MALE_UTC_OFFSET_MIN } from '@/lib/time';
import { applyHistory, dayTypeOf } from './applyHistory';
import { buildGraph } from './buildGraph';
import type { TransitGraph } from './types';

/** Midday Malé time on a service date, so a graph built with it is stamped with that day. */
export function middayOf(date: string): Date {
  return new Date(Date.parse(`${date}T12:00:00Z`) - MALE_UTC_OFFSET_MIN * 60_000);
}

/**
 * A day planned on how its buses have been seen to run, for when no timetable
 * for it has been recorded.
 *
 * RTL publishes only what is left of today, so a day still to come has a
 * timetable only once the backend has recorded one like it. Until then, what it
 * does have is weeks of watching the buses: which routes run at each hour of
 * each kind of day, how long riders wait for them, and how long the rides take.
 * That is exactly what the planner already plans a minibus route on, so here
 * every route is planned that way — today's routes and stops with the published
 * times taken out, and that day type's measurements laid over them.
 *
 * The answer is an estimate and is flagged as one: it knows a bus comes about
 * every ten minutes at eight on a Saturday, not that one leaves at 07:52.
 *
 * Null when nothing has been measured for that kind of day, since a plan on the
 * planner's bare assumptions would be a guess dressed up as an estimate.
 */
export function patternGraph(
  today: RouteDetailsResponse,
  date: string,
  history: HistorySummary | null,
): TransitGraph | null {
  if (!history || !(history.dayTypeDays?.[dayTypeOf(date)] ?? 0)) return null;
  const untimed: RouteDetailsResponse = {
    ...today,
    routeResponse: (today.routeResponse ?? []).map((route) => ({
      ...route,
      busRouteStopList: (route.busRouteStopList ?? []).map((stop) => ({ ...stop, timings: [] })),
    })),
  };
  return applyHistory(buildGraph(untimed, middayOf(date)), history);
}
