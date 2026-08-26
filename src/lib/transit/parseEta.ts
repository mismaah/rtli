import type { LiveEta } from './types';

/**
 * RTL returns ETAs as free text, not numbers. Observed across all 15 routes:
 *   "5 Minutes " (note the trailing space), "1 Minutes ",
 *   "Entering the station", "Send in 5 minutes"
 * Anything unrecognised yields null rather than a bogus number.
 */
export function parseEta(raw: string | null | undefined, vehicleCode = ''): LiveEta | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;

  const lower = text.toLowerCase();

  // Bus is pulling into the stop right now.
  if (lower.includes('entering the station')) {
    return { minutes: 0, vehicleCode, label: 'Arriving' };
  }

  // "Send in 5 minutes" — dispatch from the terminal, not yet en route.
  const dispatch = /^send in (\d+)\s*min/i.exec(text);
  if (dispatch) {
    const minutes = Number(dispatch[1]);
    return { minutes, vehicleCode, label: `Departs terminal in ${minutes} min` };
  }

  const mins = /^(\d+)\s*min/i.exec(text);
  if (mins) {
    const minutes = Number(mins[1]);
    return { minutes, vehicleCode, label: minutes <= 1 ? '1 min' : `${minutes} min` };
  }

  return null;
}
