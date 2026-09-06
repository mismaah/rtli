import type { en } from './en';

/**
 * How much of the app is shown in which language.
 *
 * `both` is the default: the chrome stays English, and a stop that has a
 * Dhivehi name shows it under the English one. `dv` puts everything in
 * Dhivehi, falling back to English per-stop where RTL publishes no `dvname`.
 */
export type Language = 'both' | 'en' | 'dv';

export const LANGUAGES: readonly Language[] = ['both', 'en', 'dv'];

export function isLanguage(value: unknown): value is Language {
  return value === 'both' || value === 'en' || value === 'dv';
}

/** Every string the app can say, keyed. Shape is fixed by the English catalogue. */
export type Catalog = typeof en;
export type CatalogKey = keyof Catalog;

export type TranslateParams = Record<string, string | number>;

/** Looks a string up and fills in its `{tokens}`. */
export type T = (key: CatalogKey, params?: TranslateParams) => string;
