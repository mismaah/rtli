import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { MY_LOCATION_NAME, placeKey, samePlace } from '@/lib/transit/places';
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

/**
 * Two trips are the same trip when they run between the same two places.
 * `placeKey` is what makes that true of "my location" as well: the rider is a
 * few metres further down the road every time they open the app, and keying on
 * the raw fix listed one entry per fix, all of them the same journey.
 */
const keyOf = (origin: Place, destination: Place) =>
  `${placeKey(origin)}->${placeKey(destination)}`;

export const useRecentTrips = create<RecentTripsState>()(
  persist(
    (set) => ({
      trips: [],
      record: (origin, destination) =>
        set((s) => {
          // Tapping a saved place before a start point is chosen used to record a
          // trip from a place to itself, which is not a journey anyone took.
          if (samePlace(origin, destination)) return s;
          const id = keyOf(origin, destination);
          const trip: RecentTrip = { id, origin, destination, at: Date.now() };
          return { trips: [trip, ...s.trips.filter((t) => t.id !== id)].slice(0, MAX_RECENT) };
        }),
      clear: () => set({ trips: [] }),
    }),
    {
      name: 'rtl-improved.recentTrips',
      version: 2,
      // Lists saved under v1 are already full of the duplicates above; rekeying
      // them collapses those rather than making the rider clear the list.
      migrate: (persisted) => ({ trips: dedupe((persisted as RecentTripsState)?.trips ?? []) }),
    },
  ),
);

function dedupe(trips: RecentTrip[]): RecentTrip[] {
  const seen = new Set<string>();
  const out: RecentTrip[] = [];

  for (const trip of trips) {
    if (!trip?.origin || !trip?.destination) continue;
    // v1 had no way of saying "wherever I am"; it wrote the name and the fix.
    const origin = restoreCurrent(trip.origin);
    const destination = restoreCurrent(trip.destination);
    const id = keyOf(origin, destination);
    if (seen.has(id) || id.split('->')[0] === id.split('->')[1]) continue;
    seen.add(id);
    out.push({ ...trip, id, origin, destination });
  }

  return out.slice(0, MAX_RECENT);
}

const restoreCurrent = (place: Place): Place =>
  !place.stopCode && !place.current && place.name === MY_LOCATION_NAME
    ? { ...place, current: true }
    : place;
