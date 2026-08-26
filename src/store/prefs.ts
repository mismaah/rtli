import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { WalkPreference } from '@/lib/transit/plan';

interface PrefsState {
  /** Furthest the rider is willing to walk to or from a stop, in metres. */
  maxWalkM: number;
  /** How hard the planner works to keep an itinerary's walking down. */
  walkPreference: WalkPreference;
  /** Show Dhivehi stop names alongside English. */
  showDhivehi: boolean;
  setMaxWalkM: (m: number) => void;
  setWalkPreference: (p: WalkPreference) => void;
  toggleDhivehi: () => void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      maxWalkM: 800,
      walkPreference: 'balanced',
      showDhivehi: false,
      setMaxWalkM: (maxWalkM) => set({ maxWalkM }),
      setWalkPreference: (walkPreference) => set({ walkPreference }),
      toggleDhivehi: () => set((s) => ({ showDhivehi: !s.showDhivehi })),
    }),
    {
      name: 'rtl-improved.prefs',
      version: 2,
      // v1 had no walkPreference. Merging rather than discarding keeps the
      // rider's saved walking distance across the upgrade.
      migrate: (persisted) => ({
        ...(persisted as Partial<PrefsState>),
        walkPreference: 'balanced' as WalkPreference,
      }),
    },
  ),
);
