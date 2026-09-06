import { usePrefs } from '@/store/prefs';
import type { Place, Route, Stop, TransitGraph } from '@/lib/transit/types';
import type { Language, T } from './types';

/**
 * Naming, in one place.
 *
 * RTL publishes a Dhivehi name for most stops and every route, but not all of
 * them — 46 of the 197 stop rows come through blank — so "the Dhivehi name" is
 * never something a screen can assume it has. Every caller asks here instead of
 * reaching for `dvName` itself, and gets back a string that is always safe to
 * render: Dhivehi where there is Dhivehi, English where there is not.
 *
 * The split between `…Text` and `…Secondary` is the difference between the two
 * ways a name appears: as the one line there is room for, and as the extra line
 * the `both` mode hangs underneath it.
 */

/** The single name to show. Never empty. */
export function stopText(stop: Stop, lang: Language): string {
  return lang === 'dv' && stop.dvName ? stop.dvName : stop.name;
}

/** The Dhivehi line shown *under* the English one, or '' when there is none. */
export function stopSecondary(stop: Stop, lang: Language): string {
  return lang === 'both' ? stop.dvName : '';
}

export function routeText(route: Route, lang: Language): string {
  return lang === 'dv' && route.dvName ? route.dvName : route.name;
}

export function routeSecondary(route: Route, lang: Language): string {
  return lang === 'both' ? route.dvName : '';
}

/**
 * A `Place` is what survives being chosen as an origin or destination, and it
 * carries no Dhivehi name — widening it would ripple through the saved-place
 * store, the recents store and the URL encoding, all for a string that can be
 * looked back up from the stop it came from.
 */
export function placeDvName(place: Place, graph: TransitGraph | undefined): string {
  if (!place.stopCode) return '';
  return graph?.stops.get(place.stopCode)?.dvName ?? '';
}

export function placeText(
  place: Place,
  lang: Language,
  graph: TransitGraph | undefined,
  t: T,
): string {
  // "My location" is the app's own word for the rider, not a name RTL gave a
  // point, so it is translated rather than looked up.
  if (place.current) return t('myLocation');
  if (lang !== 'dv') return place.name;
  return placeDvName(place, graph) || place.name;
}

export function placeSecondary(
  place: Place,
  lang: Language,
  graph: TransitGraph | undefined,
): string {
  return lang === 'both' && !place.current ? placeDvName(place, graph) : '';
}

/**
 * A run of Thaana.
 *
 * `dir` goes on the element and not only in the stylesheet: these all sit inside
 * `truncate` spans, and an ellipsis follows the element's own direction, so
 * without it Dhivehi is clipped at the wrong end. It also keeps the run right in
 * the accessibility tree and on copy, where CSS does not reach.
 */
export function Dv({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={`dv ${className}`} lang="dv" dir="rtl">
      {children}
    </span>
  );
}

/** The current language, for modules that only need naming and not `t`. */
export function useNameLanguage(): Language {
  return usePrefs((s) => s.language);
}
