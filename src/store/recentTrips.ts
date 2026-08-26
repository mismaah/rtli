import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Place } from '@/lib/transit/types';

export interface RecentTrip {
  id: string;
  origin: Place;
  destination: Place;
  at: number;
}

interface RecentTripsState {
  trips: RecentTrip[];
  record: (origin: Place, destination: Place) => void;
  clear: () => void;
}

const MAX_RECENT = 8;

const keyOf = (o: Place, d: Place) =>
  `${o.stopCode ?? `${o.lat.toFixed(4)},${o.lng.toFixed(4)}`}->${d.stopCode ?? `${d.lat.toFixed(4)},${d.lng.toFixed(4)}`}`;

export const useRecentTrips = create<RecentTripsState>()(
  persist(
    (set) => ({
      trips: [],
      record: (origin, destination) =>
        set((s) => {
          const id = keyOf(origin, destination);
          const trip: RecentTrip = { id, origin, destination, at: Date.now() };
          return { trips: [trip, ...s.trips.filter((t) => t.id !== id)].slice(0, MAX_RECENT) };
        }),
      clear: () => set({ trips: [] }),
    }),
    { name: 'rtl-improved.recentTrips', version: 1 },
  ),
);
