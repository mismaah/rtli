import { enT } from '@/i18n/translate';
import type { T } from '@/i18n/types';
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
    return { minutes: 0, vehicleCode, kind: 'arriving' };
  }

  // "Send in 5 minutes" — dispatch from the terminal, not yet en route.
  const dispatch = /^send in (\d+)\s*min/i.exec(text);
  if (dispatch) {
    const minutes = Number(dispatch[1]);
    return { minutes, vehicleCode, kind: 'dispatch' };
  }

  const mins = /^(\d+)\s*min/i.exec(text);
  if (mins) {
    const minutes = Number(mins[1]);
    return { minutes, vehicleCode, kind: 'due' };
  }

  return null;
}

/**
 * The reading as a sentence. `1 min` covers everything under a minute: RTL
 * counts down to "1 Minutes" and then stops, and "0 min" would read as though
 * the bus were already there when it is not.
 */
export function formatEta(eta: LiveEta, t: T = enT): string {
  switch (eta.kind) {
    case 'arriving':
      return t('etaArriving');
    case 'dispatch':
      return t('etaDispatch', { n: eta.minutes });
    default:
      return t('etaMinutes', { n: Math.max(1, eta.minutes) });
  }
}
