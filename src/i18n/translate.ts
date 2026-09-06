import { en } from './en';
import { dv } from './dv';
import type { Catalog, CatalogKey, Language, T, TranslateParams } from './types';

/**
 * Translation without a library.
 *
 * The app has one catalogue per written language and no runtime loading — both
 * are a few kilobytes and the whole thing has to work offline anyway — so this
 * is a lookup and a token substitution, and nothing else.
 *
 * Kept apart from `index.ts` so the formatters in `lib/` can reach `enT` for
 * their English default without pulling in the store or React behind it.
 */
function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  // An unknown token is left as written rather than blanked: a missing value is
  // a bug worth seeing, and `{name}` on screen says so where an empty gap does not.
  return template.replace(/\{(\w+)\}/g, (whole, token: string) =>
    token in params ? String(params[token]) : whole,
  );
}

/** The catalogue a language reads from. `both` keeps its chrome in English. */
export function catalogFor(lang: Language): Catalog {
  return lang === 'dv' ? dv : en;
}

export function makeT(lang: Language): T {
  const catalog = catalogFor(lang);
  // Falls back to English per key: a Dhivehi catalogue that has lost a key at
  // runtime should read oddly, not render `undefined`.
  return (key: CatalogKey, params?: TranslateParams) =>
    interpolate(catalog[key] ?? en[key], params);
}

/**
 * One bound translator per language, made once. Components hold onto these
 * across renders, so they must be stable — a fresh `t` each render would
 * invalidate every `useMemo` keyed on it.
 */
const TRANSLATORS: Record<Language, T> = {
  both: makeT('both'),
  en: makeT('en'),
  dv: makeT('dv'),
};

/** The English translator, for the default argument of non-React formatters. */
export const enT: T = TRANSLATORS.en;

export function translatorFor(lang: Language): T {
  return TRANSLATORS[lang];
}
