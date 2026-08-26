import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Place } from '@/lib/transit/types';

export interface SavedPlace extends Place {
  id: string;
  icon: string;
  createdAt: number;
}

interface SavedPlacesState {
  places: SavedPlace[];
  add: (place: Place, icon?: string) => SavedPlace;
  rename: (id: string, name: string, icon?: string) => void;
  remove: (id: string) => void;
}

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `p_${Date.now()}_${Math.random().toString(36).slice(2)}`;

export const useSavedPlaces = create<SavedPlacesState>()(
  persist(
    (set) => ({
      places: [],
      add: (place, icon = '📍') => {
        const saved: SavedPlace = { ...place, id: newId(), icon, createdAt: Date.now() };
        set((s) => ({ places: [saved, ...s.places] }));
        return saved;
      },
      rename: (id, name, icon) =>
        set((s) => ({
          places: s.places.map((p) => (p.id === id ? { ...p, name, icon: icon ?? p.icon } : p)),
        })),
      remove: (id) => set((s) => ({ places: s.places.filter((p) => p.id !== id) })),
    }),
    { name: 'rtl-improved.savedPlaces', version: 1 },
  ),
);
