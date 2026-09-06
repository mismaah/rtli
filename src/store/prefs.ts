import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { WalkPreference } from '@/lib/transit/plan';
import { isLanguage, type Language } from '@/i18n/types';

interface PrefsState {
  /** Furthest the rider is willing to walk to or from a stop, in metres. */
  maxWalkM: number;
  /** How hard the planner works to keep an itinerary's walking down. */
  walkPreference: WalkPreference;
  /** Which language the app is read in. See `@/i18n/types`. */
  language: Language;
  setMaxWalkM: (m: number) => void;
  setWalkPreference: (p: WalkPreference) => void;
  setLanguage: (l: Language) => void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      maxWalkM: 800,
      walkPreference: 'balanced',
      // Most stops have a Dhivehi name and most riders read both, so showing
      // both is the honest default; the two single-language modes are the
      // deliberate choice, not this one.
      language: 'both',
      setMaxWalkM: (maxWalkM) => set({ maxWalkM }),
      setWalkPreference: (walkPreference) => set({ walkPreference }),
      setLanguage: (language) => set({ language }),
    }),
    {
      name: 'rtl-improved.prefs',
      version: 3,
      // v1 had no walkPreference; v2 had a `showDhivehi` boolean that no control
      // ever set, so there is nothing in it worth carrying forward — everyone
      // lands on the new default. Merging rather than discarding keeps the
      // rider's saved walking distance across both upgrades.
      migrate: (persisted) => {
        const prior = (persisted ?? {}) as Partial<PrefsState>;
        return {
          ...prior,
          walkPreference: 'balanced' as WalkPreference,
          language: isLanguage(prior.language) ? prior.language : ('both' as Language),
        };
      },
    },
  ),
);
