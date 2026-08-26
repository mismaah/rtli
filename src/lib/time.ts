/**
 * All RTL schedule times are Malé local time (UTC+05:00, no DST ever).
 * Everything here is pinned to that offset so the app stays correct even when
 * the device clock is set to another timezone.
 */
export const MALE_UTC_OFFSET_MIN = 5 * 60;

export const MINUTES_PER_DAY = 24 * 60;

/** Minutes since local midnight in Malé, for a given instant. */
export function minutesOfDay(now: Date = new Date()): number {
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes() + now.getUTCSeconds() / 60;
  return (((utcMin + MALE_UTC_OFFSET_MIN) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** Malé-local calendar date as `YYYY-MM-DD`. Used to key the daily timetable cache. */
export function serviceDate(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + MALE_UTC_OFFSET_MIN * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** `"13:40:00"` -> 820. Returns null for blank/malformed input. */
export function parseClock(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 820 -> "13:40". Wraps past midnight so post-midnight arrivals render sanely. */
export function formatClock(minutes: number): string {
  const m = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Compact human duration: 5 -> "5 min", 95 -> "1 hr 35 min". */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/**
 * Relative age of a live reading: 0 -> "just now", 45_000 -> "45s ago".
 * Seconds matter here — a rider deciding whether to trust a bus dot on the map
 * wants to know if it is four seconds old or four minutes.
 */
export function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 3) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ago`;
}
