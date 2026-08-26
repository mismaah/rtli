/**
 * The trip in the address bar.
 *
 * Keeping origin, destination and the chosen route in the URL is what makes a
 * refresh land back on the same screen and a link land someone else on it too.
 * The state is written with `replaceState`: these are edits to one journey, not
 * separate pages, and pushing every retyped stop into history would leave the
 * back button walking through a rider's typing.
 */

export interface UrlState {
  /** Origin, as encoded by `encodePlace`. */
  from?: string;
  /** Destination, as encoded by `encodePlace`. */
  to?: string;
  /** The chosen itinerary, as `itinerarySignature` writes it. */
  route?: string;
}

const KEYS = ['from', 'to', 'route'] as const;

export function readUrlState(search: string = window.location.search): UrlState {
  const params = new URLSearchParams(search);
  const state: UrlState = {};
  for (const key of KEYS) {
    const value = params.get(key);
    if (value) state[key] = value;
  }
  return state;
}

/**
 * Serialises to a query string, leaving the punctuation this app's own values
 * use unescaped. `?from=me&to=stop:T02` is a link someone can read; the
 * percent-encoded spelling of the same thing is not, and every character left
 * bare here is legal in a query string.
 */
export function toQueryString(state: UrlState): string {
  const parts: string[] = [];
  for (const key of KEYS) {
    const value = state[key];
    if (!value) continue;
    parts.push(`${key}=${encodeURIComponent(value).replace(/%2C|%3A|%40|%7C/g, decodeURIComponent)}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/** Replaces the query string, preserving the path and hash. */
export function writeUrlState(state: UrlState): void {
  if (typeof window === 'undefined') return;
  const next = `${window.location.pathname}${toQueryString(state)}${window.location.hash}`;
  if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  window.history.replaceState(window.history.state, '', next);
}
