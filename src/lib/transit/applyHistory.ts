/**
 * Folds the recorder's measurements into a built graph.
 *
 * Deliberately a separate step rather than part of `buildGraph`. That function
 * is the single normalizer both network paths run through — the backend's copy
 * and the direct-to-RTL fallback — and it has to stay a pure function of RTL's
 * own JSON, or the two paths could disagree about what a route is. Measurements
 * come from one of those paths only, may be absent, and are an overlay on the
 * result rather than an input to it.
 *
 * The graph is mutated in place. It has just been built by the caller and is not
 * yet shared with anything, and copying it would mean rebuilding every stop and
 * transfer map to change two fields per route.
 */
import type { DayType, HistorySummary, RouteHistory } from '@/api/history';
import type { RouteActivity, RouteMeasurements, TransitGraph } from './types';

/**
 * The fewest observations behind a headway before it is allowed to replace the
 * assumption.
 *
 * The server already withholds thin buckets, so this is a second, independent
 * floor rather than the only one — it is the client saying what it is willing to
 * plan a rider's journey on, which is not the same question as what is worth
 * publishing. A number here that is wrong in the rider's favour costs them a bus.
 */
export const MIN_HEADWAY_SAMPLES = 20;

/**
 * Whole days the recorder must have watched before a route's absence from an
 * hour — or from the record altogether — is taken to mean it is not running.
 */
export const MIN_ACTIVITY_DAYS = 7;

/**
 * Days of one type (Friday, say) needed before that type's own figures replace
 * the pooled ones. Fewer than this and one odd Friday would be the whole story.
 */
export const MIN_DAY_TYPE_DAYS = 3;

/**
 * A route seen on fewer than this share of days is not one to send a rider to
 * wait for. R11 was seen twice in 73 days.
 */
export const RARE_ROUTE_SHARE = 0.2;

/**
 * A frequency route seen in a given hour on fewer than this share of days is
 * treated as not running then. R12 is seen at 18:00 on nearly every day and at
 * 19:00 on one in twenty-five.
 */
export const MIN_HOUR_ACTIVE_SHARE = 0.25;

/**
 * Matched arrivals a route needs before its lateness or earliness is put in
 * front of a rider.
 */
export const MIN_LATENESS_SAMPLES = 50;

/**
 * The most margin a rider is ever asked to allow. R1 and R2 come out around six
 * and a half minutes; past this the answer is the next bus, not a longer wait.
 */
export const MAX_EARLY_BUFFER_MIN = 8;

/** Typical lateness below this is within the noise of a printed timetable. */
export const NOTABLE_LATENESS_MIN = 3;

/** The day type a service date (`YYYY-MM-DD`) runs to. */
export function dayTypeOf(serviceDate: string): DayType {
  const day = new Date(`${serviceDate}T00:00:00Z`).getUTCDay();
  if (day === 5) return 'fri';
  if (day === 6) return 'sat';
  return 'week';
}

/**
 * Applies measurements to a graph, returning it.
 *
 * A null summary is the ordinary case on a client with no backend configured, or
 * one whose backend has no store, and leaves the graph exactly as built: every
 * assumption it already had, unchanged.
 */
export function applyHistory(graph: TransitGraph, history: HistorySummary | null): TransitGraph {
  if (!history) return graph;

  // Today's kind of day, and whether enough of them were watched for their own
  // figures to stand: R14 waits 8 minutes on a Friday and 76 on a Saturday, and
  // the pooled week describes neither.
  const dayType = dayTypeOf(graph.serviceDate);
  const typeDays = history.dayTypeDays?.[dayType] ?? 0;
  const useDayType = typeDays >= MIN_DAY_TYPE_DAYS;
  const pooledDays = history.days ?? 0;

  for (const [code, route] of graph.routes) {
    const measured = history.routes[code];
    if (!measured) {
      // Watched for weeks and never once seen arriving at a stop. Recorded as
      // exactly that, so the planner stops offering a bus every 15 minutes on a
      // route that has not run — R11's case.
      if (pooledDays >= MIN_ACTIVITY_DAYS) {
        route.measured = {
          headwaySamples: 0,
          headwayIsLap: false,
          latenessSamples: 0,
          activity: { days: pooledDays, activeDays: 0, byHour: {} },
        };
      }
      continue;
    }

    const attached: RouteMeasurements = {
      headwaySamples: measured.headwaySamples ?? 0,
      headwayIsLap: measured.headwayIsLap === true,
      latenessSamples: measured.latenessSamples ?? 0,
    };
    if (typeof measured.headwayMin === 'number') attached.headwayMin = measured.headwayMin;
    if (measured.headwayByHour) attached.headwayByHour = measured.headwayByHour;
    if (measured.latenessByHour) attached.latenessByHour = measured.latenessByHour;
    if (typeof measured.waitMin === 'number') attached.waitMin = measured.waitMin;
    if (measured.waitByHour) attached.waitByHour = measured.waitByHour;
    if (typeof measured.earlyMin === 'number') attached.earlyMin = measured.earlyMin;
    if (measured.earlyByHour) attached.earlyByHour = measured.earlyByHour;
    const activity = activityOf(measured, pooledDays, useDayType ? dayType : null, typeDays);
    if (activity) attached.activity = activity;
    if (useDayType) {
      const typed = measured.dayTypes?.[dayType];
      attached.dayType = dayType;
      // Hour by hour, today's kind of day wins where it measured that hour, and
      // the pooled figure stands in where it did not.
      if (typed?.headwayByHour) attached.headwayByHour = { ...attached.headwayByHour, ...typed.headwayByHour };
      if (typed?.waitByHour) attached.waitByHour = { ...attached.waitByHour, ...typed.waitByHour };
      if (typed?.latenessByHour) attached.latenessByHour = { ...attached.latenessByHour, ...typed.latenessByHour };
      if (typed?.earlyByHour) attached.earlyByHour = { ...attached.earlyByHour, ...typed.earlyByHour };
    }
    if (measured.segmentSecs) {
      // Seconds on the wire, minutes in the planner. Converted once here rather
      // than at each of the thousands of lookups a search performs.
      const segmentMin: Record<string, number> = {};
      for (const [pair, secs] of Object.entries(measured.segmentSecs)) {
        if (typeof secs === 'number' && secs > 0) segmentMin[pair] = secs / 60;
      }
      if (Object.keys(segmentMin).length > 0) attached.segmentMin = segmentMin;
    }
    if (measured.rideSecs) {
      const rideMin: Record<string, number> = {};
      for (const [pair, secs] of Object.entries(measured.rideSecs)) {
        if (typeof secs === 'number' && secs > 0) rideMin[pair] = secs / 60;
      }
      if (Object.keys(rideMin).length > 0) attached.rideMin = rideMin;
    }
    if (measured.segmentSecsByHour) {
      const segmentMinByHour: Record<string, Record<string, number>> = {};
      for (const [pair, byHour] of Object.entries(measured.segmentSecsByHour)) {
        const hours: Record<string, number> = {};
        for (const [hour, secs] of Object.entries(byHour ?? {})) {
          if (typeof secs === 'number' && secs > 0) hours[hour] = secs / 60;
        }
        if (Object.keys(hours).length > 0) segmentMinByHour[pair] = hours;
      }
      if (Object.keys(segmentMinByHour).length > 0) {
        attached.segmentMinByHour = segmentMinByHour;
      }
    }
    route.measured = attached;

    // The assumed headway is replaced only on the routes that have one — the
    // frequency routes with no timetable. A scheduled route's real departures
    // are better than any median of the gaps between them.
    if (
      route.trips.length === 0 &&
      attached.headwayMin != null &&
      attached.headwaySamples >= MIN_HEADWAY_SAMPLES
    ) {
      route.headwayMin = attached.headwayMin;
    }
  }
  return graph;
}

/**
 * The measured wait at a given time of day, falling back to the route's
 * all-hours median and then to whatever the route already assumed.
 *
 * Hour-of-day matters more here than anywhere else in the planner: a route every
 * 15 minutes at 08:00 is not one every 15 minutes at 23:00, and a rider planning
 * a late journey is the one who most needs to be told the wait is long.
 */
export function headwayMinutesAt(
  measured: RouteMeasurements | undefined,
  maleMinutes: number,
  fallback: number,
): number {
  if (!measured || measured.headwaySamples < MIN_HEADWAY_SAMPLES) return fallback;
  const hour = Math.floor(((maleMinutes % 1440) + 1440) % 1440 / 60);
  const hourly = measured.headwayByHour?.[String(hour)];
  if (typeof hourly === 'number' && hourly > 0) return hourly;
  return measured.headwayMin ?? fallback;
}

/**
 * When the route runs, on the evidence that is deep enough to trust: today's
 * day type where enough such days were watched, every day pooled otherwise,
 * and nothing at all — so the planner assumes it runs — when neither is.
 */
function activityOf(
  measured: RouteHistory,
  pooledDays: number,
  dayType: DayType | null,
  typeDays: number,
): RouteActivity | undefined {
  if (dayType) {
    // A day type the route has no entry for is one it was never seen on.
    const typed = measured.dayTypes?.[dayType];
    return {
      days: typeDays,
      activeDays: typed?.activeDays ?? 0,
      byHour: typed?.activeByHour ?? {},
    };
  }
  if (pooledDays >= MIN_ACTIVITY_DAYS && typeof measured.activeDays === 'number') {
    return { days: pooledDays, activeDays: measured.activeDays, byHour: measured.activeByHour ?? {} };
  }
  return undefined;
}

function hourKey(maleMinutes: number): string {
  return String(Math.floor((((maleMinutes % 1440) + 1440) % 1440) / 60));
}

/**
 * Whether the route can be expected to be running at a given time of day.
 *
 * True whenever there is not enough evidence to say otherwise: an unmeasured
 * route keeps the benefit of the doubt it has always had. False for a route
 * seen on too few days to be worth waiting for, and for an hour it is rarely
 * seen in — R12 after about 19:00, which a missing hourly headway alone would
 * have filled in with its all-day median.
 */
export function runsAt(measured: RouteMeasurements | undefined, maleMinutes: number): boolean {
  const activity = measured?.activity;
  if (!activity || activity.days <= 0) return true;
  if (activity.activeDays / activity.days < RARE_ROUTE_SHARE) return false;
  return (activity.byHour[hourKey(maleMinutes)] ?? 0) >= MIN_HOUR_ACTIVE_SHARE;
}

/**
 * The expected wait for a rider turning up at random on a frequency route.
 *
 * The measured wait where there is one, which accounts for gaps being uneven;
 * failing that, half the headway, which assumes they are even and so
 * understates it.
 */
export function waitMinutesAt(
  measured: RouteMeasurements | undefined,
  maleMinutes: number,
  fallbackHeadway: number,
): number {
  if (measured && measured.headwaySamples >= MIN_HEADWAY_SAMPLES) {
    const hourly = measured.waitByHour?.[hourKey(maleMinutes)];
    if (typeof hourly === 'number' && hourly > 0) return hourly;
    if (typeof measured.waitMin === 'number' && measured.waitMin > 0) return measured.waitMin;
  }
  return headwayMinutesAt(measured, maleMinutes, fallbackHeadway) / 2;
}

/**
 * How many whole minutes before a timetabled departure the rider should be at
 * the stop, because the route often runs early. Zero where it does not, or
 * where too little is known to ask anyone to wait longer.
 */
export function earlyBufferAt(measured: RouteMeasurements | undefined, maleMinutes: number): number {
  if (!measured || measured.latenessSamples < MIN_LATENESS_SAMPLES) return 0;
  const early = measured.earlyByHour?.[hourKey(maleMinutes)] ?? measured.earlyMin ?? 0;
  if (!(early > 0)) return 0;
  return Math.min(MAX_EARLY_BUFFER_MIN, Math.round(early));
}

/** The most delay an arrival estimate is ever stretched by. */
export const MAX_EXPECTED_LATE_MIN = 20;

/**
 * Minutes a timetabled bus is expected to be behind its published time at this
 * hour — the measured median, or zero where it runs early, on time, or too
 * little is known.
 *
 * For when the rider *arrives*, never for when they should be at the stop: that
 * stays the published time (or earlier, see `earlyBufferAt`), since telling them
 * to turn up at the median delay would have them miss half the buses. But once
 * they are on, a bus that typically leaves six minutes behind gets there six
 * minutes behind, and the arrival — and every connection judged against it —
 * should say so. What the buses have been seen to do outranks what was printed.
 */
export function expectedLateMinAt(
  measured: RouteMeasurements | undefined,
  maleMinutes: number,
): number {
  if (!measured || measured.latenessSamples < MIN_LATENESS_SAMPLES) return 0;
  const late = measured.latenessByHour?.[hourKey(maleMinutes)];
  return typeof late === 'number' && late > 0 ? Math.min(late, MAX_EXPECTED_LATE_MIN) : 0;
}

/**
 * Whole minutes this route typically runs late at a given time, when that is
 * enough to mention; otherwise undefined.
 */
export function typicalLateMinAt(
  measured: RouteMeasurements | undefined,
  maleMinutes: number,
): number | undefined {
  if (!measured || measured.latenessSamples < MIN_LATENESS_SAMPLES) return undefined;
  const late = measured.latenessByHour?.[hourKey(maleMinutes)];
  if (typeof late !== 'number' || late < NOTABLE_LATENESS_MIN) return undefined;
  return Math.round(late);
}
