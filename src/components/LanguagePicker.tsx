import { useEffect, useRef, useState } from 'react';
import { usePrefs } from '@/store/prefs';
import { Dv, useT } from '@/i18n';
import type { CatalogKey, Language } from '@/i18n';

/**
 * Which language the app is read in, from anywhere in it.
 *
 * It lives in the header rather than behind a settings screen because it is not
 * really a setting: a rider who cannot read the screen cannot navigate to the
 * place where they would fix that, and someone reading a stop name mid-journey
 * should not have to leave the journey to see it in the other script.
 *
 * Each option is written in its own language, so the way out of a mode you
 * cannot read is always legible.
 */
const OPTIONS: { value: Language; key: CatalogKey; thaana: boolean }[] = [
  { value: 'both', key: 'languageBoth', thaana: true },
  { value: 'en', key: 'languageEn', thaana: false },
  { value: 'dv', key: 'languageDv', thaana: true },
];

/** Two characters of the current mode, for the closed button. */
const BADGE: Record<Language, string> = { both: 'EN·ދި', en: 'EN', dv: 'ދި' };

export function LanguagePicker() {
  const language = usePrefs((s) => s.language);
  const setLanguage = usePrefs((s) => s.setLanguage);
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={root} className="pointer-events-auto relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={t('languageLabel')}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-ink-900/85 px-3 text-xs font-medium text-ink-300 backdrop-blur active:bg-ink-800"
      >
        <GlobeIcon />
        <span>{BADGE[language]}</span>
      </button>

      {open && (
        <div
          role="radiogroup"
          aria-label={t('languageLabel')}
          className="absolute right-0 top-full z-20 mt-1.5 w-44 overflow-hidden rounded-xl border border-white/10 bg-ink-900/95 shadow-lg backdrop-blur"
        >
          {OPTIONS.map((option) => {
            const selected = option.value === language;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  setLanguage(option.value);
                  setOpen(false);
                }}
                className={`flex min-h-11 w-full items-center gap-2 border-b border-white/5 px-3 text-left text-sm last:border-0 ${
                  selected ? 'bg-brand-500/15 text-brand-400' : 'text-ink-300 active:bg-white/5'
                }`}
              >
                <span className="w-4 shrink-0 text-center text-xs">{selected ? '✓' : ''}</span>
                {option.thaana ? (
                  <Dv className="min-w-0 flex-1">{t(option.key)}</Dv>
                ) : (
                  <span className="min-w-0 flex-1">{t(option.key)}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 fill-current" aria-hidden>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm6.9 6h-2.5a15.6 15.6 0 0 0-1.4-3.6A8 8 0 0 1 18.9 8ZM12 4.1c.7 1 1.3 2.3 1.7 3.9h-3.4c.4-1.6 1-2.9 1.7-3.9ZM4.3 14a8 8 0 0 1 0-4h2.9a17 17 0 0 0 0 4Zm.8 2h2.5c.3 1.3.8 2.5 1.4 3.6A8 8 0 0 1 5.1 16Zm2.5-8H5.1a8 8 0 0 1 3.9-3.6A15.6 15.6 0 0 0 7.6 8ZM12 19.9c-.7-1-1.3-2.3-1.7-3.9h3.4c-.4 1.6-1 2.9-1.7 3.9Zm2.1-5.9H9.9a15 15 0 0 1 0-4h4.2a15 15 0 0 1 0 4Zm.9 5.6c.6-1.1 1-2.3 1.4-3.6h2.5a8 8 0 0 1-3.9 3.6Zm1.8-5.6a17 17 0 0 0 0-4h2.9a8 8 0 0 1 0 4Z" />
    </svg>
  );
}
