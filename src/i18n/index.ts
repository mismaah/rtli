import { usePrefs } from '@/store/prefs';
import { translatorFor } from './translate';
import type { Language, T } from './types';

export { en } from './en';
export { dv } from './dv';
export * from './types';
export * from './translate';
export * from './names';

export function useLanguage(): Language {
  return usePrefs((s) => s.language);
}

/**
 * `t` for the current language, plus the language itself for the places that
 * branch on it rather than just look a string up.
 */
export function useT(): { t: T; lang: Language; dv: boolean } {
  const lang = useLanguage();
  return { t: translatorFor(lang), lang, dv: lang === 'dv' };
}
