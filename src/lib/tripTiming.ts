import { formatClock, MINUTES_PER_DAY, parseClock, serviceDate } from '@/lib/time';
import type { TripTiming } from '@/lib/transit/types';
import type { UrlState } from '@/lib/urlState';

/**
 * How many days ahead a trip can be planned, today included. The backend serves
 * a week; past that a timetable recorded today is a guess about one RTL may
 * well have changed.
 */
export const PLAN_AHEAD_DAYS = 7;

/** `YYYY-MM-DD` plus `days`, in calendar terms. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today's Malé date. */
export function today(now: Date = new Date()): string {
  return serviceDate(now);
}

/**
 * The day a trip is planned for when it is not today, or null.
 *
 * A date already gone counts as today rather than as itself: a link opened the
 * morning after it was written, or an app left open past midnight, is asking
 * about today by then.
 */
export function otherDayOf(timing: TripTiming, todayDate: string): string | null {
  if (timing.kind === 'now' || !timing.date) return null;
  return timing.date > todayDate ? timing.date : null;
}

/** A chosen time as the address bar carries it: `HH:MM`, or `YYYY-MM-DDTHH:MM` for another day. */
function encodeAt(at: number, date: string | undefined, todayDate: string): string {
  const clock = formatClock(at);
  return date && date > todayDate ? `${date}T${clock}` : clock;
}

/**
 * The time read back, or null if it is unreadable or a day already gone — a
 * stale link leaves the rider leaving now, not planning yesterday.
 */
function decodeAt(raw: string | undefined, todayDate: string): { at: number; date?: string } | null {
  if (!raw) return null;
  const dated = /^(\d{4}-\d{2}-\d{2})T(.+)$/.exec(raw);
  const at = parseClock(dated ? dated[2] : raw);
  if (at == null) return null;
  if (!dated || dated[1] === todayDate) return { at };
  if (dated[1] < todayDate || dated[1] > addDays(todayDate, PLAN_AHEAD_DAYS - 1)) return null;
  return { at, date: dated[1] };
}

/** The trip time a link asked for; an arrival wins over a departure. */
export function timingFromUrl(state: UrlState, todayDate: string = today()): TripTiming {
  const arrive = decodeAt(state.arrive, todayDate);
  if (arrive) return { kind: 'arrive', ...arrive };
  const depart = decodeAt(state.depart, todayDate);
  if (depart) return { kind: 'depart', ...depart };
  return { kind: 'now' };
}

export function timingToUrl(
  timing: TripTiming,
  todayDate: string = today(),
): Pick<UrlState, 'depart' | 'arrive'> {
  if (timing.kind === 'now') return {};
  return { [timing.kind]: encodeAt(timing.at, timing.date, todayDate) };
}

/** How far ahead an arrive-by search starts out, before the rider adjusts it. */
const DEFAULT_ARRIVE_AHEAD_MIN = 30;

/** `minutes` from now, past midnight carried into tomorrow. */
function fromNow(minutes: number, todayDate: string): { at: number; date?: string } {
  const rounded = Math.ceil(minutes / 5) * 5;
  return rounded >= MINUTES_PER_DAY
    ? { at: rounded - MINUTES_PER_DAY, date: addDays(todayDate, 1) }
    : { at: rounded };
}

/**
 * The timing after the rider picks a mode. Switching between the two pinned
 * modes keeps the day and time already chosen; coming from "now" starts at the
 * next round five minutes — or half an hour on, to arrive by — and late in the
 * evening that is tomorrow.
 */
export function chooseMode(
  current: TripTiming,
  kind: TripTiming['kind'],
  nowMinutes: number,
  todayDate: string,
): TripTiming {
  if (kind === current.kind) return current;
  if (kind === 'now') return { kind: 'now' };
  if (current.kind !== 'now') return { ...current, kind };
  return {
    kind,
    ...fromNow(kind === 'arrive' ? nowMinutes + DEFAULT_ARRIVE_AHEAD_MIN : nowMinutes, todayDate),
  };
}

/**
 * The timing after the rider sets a time.
 *
 * A time already gone today is taken to mean tomorrow. Nobody plans a trip for
 * this morning at night; asking for 08:00 at 23:00 is asking about tomorrow.
 */
export function chooseTime(
  current: Exclude<TripTiming, { kind: 'now' }>,
  at: number,
  nowMinutes: number,
  todayDate: string,
): TripTiming {
  const onToday = !current.date || current.date === todayDate;
  if (onToday && at < nowMinutes) return { kind: current.kind, at, date: addDays(todayDate, 1) };
  return { ...current, at };
}

/** The timing after the rider picks a day; today is carried as no date at all. */
export function chooseDay(
  current: Exclude<TripTiming, { kind: 'now' }>,
  date: string,
  todayDate: string,
): TripTiming {
  return date === todayDate ? { kind: current.kind, at: current.at } : { ...current, date };
}
