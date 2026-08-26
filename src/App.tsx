import { useCallback, useEffect, useMemo, useState } from 'react';
import { BottomSheet, type SheetSnap } from '@/components/BottomSheet';
import { SearchSheet } from '@/components/SearchSheet';
import { LazyMap } from '@/components/map/LazyMap';
import { useMap } from '@/components/map/MapContext';
import { MapPadding } from '@/components/map/MapPadding';
import { StopMarkers } from '@/components/map/StopMarkers';
import { RouteShapeLayer } from '@/components/map/RouteShapeLayer';
import { BusMarkers } from '@/components/map/BusMarkers';
import { UserMarker } from '@/components/map/UserMarker';
import { EndpointMarkers } from '@/components/map/EndpointMarkers';
import { Home } from '@/screens/Home';
import { Results } from '@/screens/Results';
import { TripDetail } from '@/screens/TripDetail';
import { StopDetail } from '@/screens/StopDetail';
import { Saved } from '@/screens/Saved';
import { useTransitGraph } from '@/hooks/useTransitGraph';
import { useGeolocation } from '@/hooks/useGeolocation';
import { usePlan } from '@/hooks/usePlan';
import { useOnline } from '@/hooks/useOnline';
import { useWideLayout } from '@/hooks/useWideLayout';
import { useSavedPlaces } from '@/store/savedPlaces';
import { useRecentTrips } from '@/store/recentTrips';
import { boundsOf } from '@/lib/geo';
import { itinerarySignature } from '@/lib/transit/plan';
import type { Itinerary, Place, Stop } from '@/lib/transit/types';

type View = 'home' | 'results' | 'detail' | 'stop' | 'saved';
type Searching = 'origin' | 'destination' | 'save' | null;

export default function App() {
  const { data, isLoading, isError, error, refetch } = useTransitGraph();
  const graph = data?.graph;
  const geo = useGeolocation(true);
  const online = useOnline();
  const wide = useWideLayout();

  const [origin, setOrigin] = useState<Place | null>(null);
  const [destination, setDestination] = useState<Place | null>(null);
  const [view, setView] = useState<View>('home');
  const [searching, setSearching] = useState<Searching>(null);
  const [selected, setSelected] = useState<Itinerary | null>(null);
  const [selectedStop, setSelectedStop] = useState<Stop | null>(null);
  const [snap, setSnap] = useState<SheetSnap>('half');

  const addSaved = useSavedPlaces((s) => s.add);
  const savedPlaces = useSavedPlaces((s) => s.places);
  const recordTrip = useRecentTrips((s) => s.record);

  // The rider's current position is the natural starting point.
  useEffect(() => {
    if (geo.position && !origin) {
      setOrigin({ name: 'My location', lat: geo.position.lat, lng: geo.position.lng });
    }
  }, [geo.position, origin]);

  const { itineraries, liveApplied } = usePlan(graph, origin, destination);

  useEffect(() => {
    if (origin && destination) {
      setView('results');
      setSnap('half');
      recordTrip(origin, destination);
    }
  }, [origin, destination, recordTrip]);

  const stops = useMemo(() => (graph ? [...graph.stops.values()] : []), [graph]);

  // Mirrors BottomSheet's snap fractions so the map frames what the sheet leaves
  // visible. In the split layout nothing covers the map, so a plain margin does.
  const sheetHeightPx = useMemo(() => {
    if (wide) return 32;
    const fraction = snap === 'collapsed' ? 0.18 : snap === 'half' ? 0.55 : 0.92;
    return Math.round((typeof window === 'undefined' ? 800 : window.innerHeight) * fraction) + 24;
  }, [snap, wide]);

  const highlighted = useMemo(() => {
    if (!selected) return [];
    return selected.legs.flatMap((l) =>
      l.kind === 'bus' ? [l.boardStop.code, l.alightStop.code] : [],
    );
  }, [selected]);

  const shownRoutes = useMemo(() => {
    if (!selected) return [];
    return selected.legs.flatMap((l) => (l.kind === 'bus' ? [l.route] : []));
  }, [selected]);

  /**
   * The trip detail screen is where a rider sits and waits, so it is the screen
   * that must not go stale. `selected` is the snapshot they tapped; this finds
   * the same journey in the current plan, which is the next departure on those
   * same buses with fresh live ETAs. It falls back to the snapshot when the
   * journey drops out of the results entirely — losing the screen out from under
   * someone waiting at the stop would be worse than showing them a stale time.
   */
  const activeSelection = useMemo(() => {
    if (!selected) return null;
    const signature = itinerarySignature(selected);
    return itineraries.find((it) => itinerarySignature(it) === signature) ?? selected;
  }, [selected, itineraries]);

  const handlePick = useCallback(
    (place: Place) => {
      if (searching === 'origin') setOrigin(place);
      else if (searching === 'destination') setDestination(place);
      else if (searching === 'save') addSaved(place);
      setSearching(null);
    },
    [searching, addSaved],
  );

  const handleStopSelect = useCallback(
    (stopCode: string) => {
      const stop = graph?.stops.get(stopCode);
      if (!stop) return;
      setSelectedStop(stop);
      setView('stop');
      setSnap('half');
    },
    [graph],
  );

  const destinationSaved = useMemo(
    () =>
      Boolean(
        destination &&
          savedPlaces.some(
            (p) =>
              Math.abs(p.lat - destination.lat) < 1e-5 && Math.abs(p.lng - destination.lng) < 1e-5,
          ),
      ),
    [savedPlaces, destination],
  );

  if (isError) {
    return <FatalError message={(error as Error).message} onRetry={() => refetch()} />;
  }

  return (
    <div className="relative flex h-[100dvh] w-full overflow-hidden bg-ink-950">
      <div className="relative min-w-0 flex-1">
        <LazyMap className="absolute inset-0">
          <MapPadding bottom={sheetHeightPx} />
          <StopMarkers stops={stops} onSelect={handleStopSelect} highlighted={highlighted} />
          <UserMarker position={geo.position} />
          <EndpointMarkers origin={origin} destination={destination} userPosition={geo.position} />
          {view === 'detail' &&
            shownRoutes.map((route) => (
              <RouteShapeLayer key={route.code} routeCode={route.code} color={route.color} />
            ))}
          {view === 'detail' &&
            shownRoutes.map((route) => (
              <BusMarkers key={route.code} route={route} />
            ))}
          <FitBounds view={view} selected={selected} origin={origin} destination={destination} />
        </LazyMap>

        <header
          className="pointer-events-none absolute inset-x-0 top-0 z-10 px-4"
          style={{ paddingTop: 'calc(var(--safe-top) + 0.75rem)' }}
        >
          <div className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-ink-900/85 px-3 py-1.5 backdrop-blur">
            <span className="text-sm font-bold tracking-tight text-ink-100">RTL Improved</span>
            <span className="text-[10px] text-ink-500">Greater Malé</span>
          </div>

          {(!online || data?.fromCache) && (
            <div className="pointer-events-auto mt-2 inline-flex items-center gap-2 rounded-full bg-amber-500/15 px-3 py-1.5 text-[11px] font-medium text-amber-200 backdrop-blur">
              <span className="size-1.5 rounded-full bg-amber-400" />
              Offline — using today's saved timetable. No live bus times.
            </div>
          )}
        </header>
      </div>

      <BottomSheet snap={snap} onSnapChange={setSnap}>
        {isLoading && <p className="py-8 text-center text-sm text-ink-500">Loading bus routes…</p>}

        {graph && view === 'home' && (
          <Home
            origin={origin}
            destination={destination}
            geoStatus={geo.status}
            onRequestLocation={geo.request}
            onEditOrigin={() => setSearching('origin')}
            onEditDestination={() => setSearching('destination')}
            onPickRecent={(o, d) => {
              setOrigin(o);
              setDestination(d);
            }}
            onManageSaved={() => setView('saved')}
          />
        )}

        {graph && view === 'results' && origin && destination && (
          <Results
            origin={origin}
            destination={destination}
            itineraries={itineraries}
            loading={false}
            destinationSaved={destinationSaved}
            onSaveDestination={() => destination && addSaved(destination)}
            onSelect={(it) => {
              setSelected(it);
              setView('detail');
              setSnap('half');
            }}
            onEditOrigin={() => setSearching('origin')}
            onEditDestination={() => setSearching('destination')}
          />
        )}

        {graph && view === 'detail' && selected && (
          <TripDetail
            itinerary={activeSelection ?? selected}
            liveApplied={liveApplied}
            onBack={() => {
              setSelected(null);
              setView('results');
            }}
          />
        )}

        {graph && view === 'stop' && selectedStop && (
          <StopDetail
            stop={selectedStop}
            graph={graph}
            onClose={() => setView(destination ? 'results' : 'home')}
            onRouteFrom={(s) => {
              setOrigin({ name: s.name, lat: s.lat, lng: s.lng, stopCode: s.code });
              setView(destination ? 'results' : 'home');
            }}
            onRouteTo={(s) => {
              setDestination({ name: s.name, lat: s.lat, lng: s.lng, stopCode: s.code });
            }}
          />
        )}

        {graph && view === 'saved' && (
          <Saved onClose={() => setView('home')} onAdd={() => setSearching('save')} />
        )}
      </BottomSheet>

      {searching && (
        <SearchSheet
          graph={graph}
          userPosition={geo.position}
          title={
            searching === 'origin'
              ? 'Where from?'
              : searching === 'destination'
                ? 'Where to?'
                : 'Save a place'
          }
          onPick={handlePick}
          onClose={() => setSearching(null)}
        />
      )}
    </div>
  );
}

/** Keeps the visible map framed on whatever the sheet is currently showing. */
function FitBounds({
  view,
  selected,
  origin,
  destination,
}: {
  view: View;
  selected: Itinerary | null;
  origin: Place | null;
  destination: Place | null;
}) {
  const points = useMemo(() => {
    if (view === 'detail' && selected) {
      return selected.legs.flatMap((l) =>
        l.kind === 'bus'
          ? [
              { lat: l.boardStop.lat, lng: l.boardStop.lng },
              { lat: l.alightStop.lat, lng: l.alightStop.lng },
            ]
          : [
              { lat: l.from.lat, lng: l.from.lng },
              { lat: l.to.lat, lng: l.to.lng },
            ],
      );
    }
    if (origin && destination) return [origin, destination];
    return [];
  }, [view, selected, origin, destination]);

  return <FitBoundsInner points={points} />;
}

function FitBoundsInner({ points }: { points: { lat: number; lng: number }[] }) {
  const map = useMap();

  useEffect(() => {
    const bounds = boundsOf(points);
    if (!bounds) return;
    // Padding is supplied by <MapPadding>, which tracks the sheet's snap point.
    map.fitBounds(bounds, { maxZoom: 16, duration: 500 });
  }, [map, points]);

  return null;
}

function FatalError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="grid h-[100dvh] place-items-center bg-ink-950 px-6 text-center">
      <div className="max-w-sm">
        <h1 className="text-lg font-semibold text-ink-100">Can’t reach the bus service</h1>
        <p className="mt-2 text-sm text-ink-300">{message}</p>
        <p className="mt-3 text-xs text-ink-500">
          RTL's API is served on port 4455, which some networks block. If you're on hotel or office
          Wi-Fi, try mobile data.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 min-h-11 rounded-xl bg-brand-500 px-6 text-sm font-semibold text-white active:bg-brand-400"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
