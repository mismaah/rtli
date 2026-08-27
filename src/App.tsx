import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BottomSheet, type SheetSnap } from '@/components/BottomSheet';
import { SearchSheet } from '@/components/SearchSheet';
import { LazyMap } from '@/components/map/LazyMap';
import { useMap } from '@/components/map/MapContext';
import { MapPadding } from '@/components/map/MapPadding';
import { StopMarkers } from '@/components/map/StopMarkers';
import { RouteShapeLayer } from '@/components/map/RouteShapeLayer';
import { BusMarkers } from '@/components/map/BusMarkers';
import { WalkRouteLayer } from '@/components/map/WalkRouteLayer';
import { UserMarker } from '@/components/map/UserMarker';
import { EndpointMarkers } from '@/components/map/EndpointMarkers';
import { FollowUser } from '@/components/map/FollowUser';
import { Home } from '@/screens/Home';
import { Results } from '@/screens/Results';
import { TripDetail, StartJourneyBar } from '@/screens/TripDetail';
import { StopDetail } from '@/screens/StopDetail';
import { JourneyNav, JourneyActionBar } from '@/screens/JourneyNav';
import { Saved } from '@/screens/Saved';
import { useTransitGraph } from '@/hooks/useTransitGraph';
import { useGeolocation } from '@/hooks/useGeolocation';
import { usePlan } from '@/hooks/usePlan';
import { useOnline } from '@/hooks/useOnline';
import { useWideLayout } from '@/hooks/useWideLayout';
import { useWalkPaths } from '@/hooks/useWalkPaths';
import { useJourney } from '@/hooks/useJourney';
import { useWakeLock } from '@/hooks/useWakeLock';
import { useSavedPlaces } from '@/store/savedPlaces';
import { useRecentTrips } from '@/store/recentTrips';
import { boundsOf } from '@/lib/geo';
import { itinerarySignature } from '@/lib/transit/plan';
import { applyWalkPaths, walkLineOf } from '@/lib/transit/walkPaths';
import { riddenStopCodes } from '@/lib/transit/routeShape';
import {
  encodePlace,
  isUnresolvable,
  parsePlaceRef,
  resolvePlaceRef,
  type PlaceRef,
} from '@/lib/transit/places';
import { readUrlState, writeUrlState } from '@/lib/urlState';
import type { Itinerary, Place, Stop, WalkLeg } from '@/lib/transit/types';

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
  /** Whether the map is still tracking the rider, or they have panned away. */
  const [following, setFollowing] = useState(true);

  const addSaved = useSavedPlaces((s) => s.add);
  const removeSaved = useSavedPlaces((s) => s.remove);
  const savedPlaces = useSavedPlaces((s) => s.places);
  const recordTrip = useRecentTrips((s) => s.record);

  /**
   * What this load was asked for, before anything is known.
   *
   * A shared link names places by stop code or by `me`, neither of which can be
   * turned into a point until the timetable has loaded or the browser has
   * answered with a fix — so the request is held here and honoured when its
   * ingredients turn up. With no link, the origin defaults to the rider's own
   * position, which is the natural starting point.
   */
  const initialUrl = useMemo(() => readUrlState(), []);
  const pendingFrom = useRef<PlaceRef | null>(
    parsePlaceRef(initialUrl.from) ?? { kind: 'current' },
  );
  const pendingTo = useRef<PlaceRef | null>(parsePlaceRef(initialUrl.to));
  const pendingRoute = useRef<string | null>(initialUrl.route ?? null);
  // A journey in progress, held the same way: the step cannot be honoured until
  // the itinerary it belongs to has been planned and picked out of the results.
  const pendingStep = useRef<string | null>(initialUrl.step ?? null);
  const pendingSince = useRef<string | null>(initialUrl.since ?? null);

  const locationRefused = geo.status === 'denied' || geo.status === 'unavailable';

  useEffect(() => {
    const settle = (ref: PlaceRef | null, apply: (place: Place) => void) => {
      if (!ref) return ref;
      const place = resolvePlaceRef(ref, graph, geo.position);
      if (place) {
        apply(place);
        return null;
      }
      // Give up on what can never arrive, so the URL stops claiming it.
      const hopeless = isUnresolvable(ref, graph) || (ref.kind === 'current' && locationRefused);
      return hopeless ? null : ref;
    };

    pendingFrom.current = settle(pendingFrom.current, setOrigin);
    pendingTo.current = settle(pendingTo.current, setDestination);
  }, [graph, geo.position, locationRefused]);

  /**
   * Picking a place by hand settles that end of the trip for good; without this
   * a slow location fix would land a moment later and overwrite the choice.
   */
  const chooseOrigin = useCallback((place: Place) => {
    pendingFrom.current = null;
    setOrigin(place);
  }, []);

  const chooseDestination = useCallback((place: Place) => {
    pendingTo.current = null;
    setDestination(place);
  }, []);

  const { itineraries, liveApplied } = usePlan(graph, origin, destination);

  useEffect(() => {
    if (origin && destination) {
      setView('results');
      setSnap('half');
      recordTrip(origin, destination);
    }
  }, [origin, destination, recordTrip]);

  /**
   * Opens the trip a shared link points at, once the plan that contains it has
   * been worked out. Declared after the effect above so that on a link carrying
   * a route the detail screen, not the results list, is what settles.
   *
   * One shot, and dropped as soon as any plan exists: a bus that has since left
   * takes its itinerary out of the results, and a link that missed its trip
   * should leave the rider on the list rather than ambushing them with a detail
   * screen minutes later when a matching departure comes round again.
   */
  useEffect(() => {
    const signature = pendingRoute.current;
    if (!signature || itineraries.length === 0) return;
    pendingRoute.current = null;

    const match = itineraries.find((it) => itinerarySignature(it) === signature);
    if (!match) {
      // No trip to be part-way through.
      pendingStep.current = null;
      pendingSince.current = null;
      return;
    }
    setSelected(match);
    setView('detail');
    setSnap('half');
  }, [itineraries]);

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

  /**
   * Each bus leg as the map needs to draw it: the route, where its stops are,
   * and which run of them the rider is actually aboard for.
   *
   * A route's stops are carried as codes, so the coordinates are looked up here
   * rather than in the layer. An incomplete lookup yields no points at all — the
   * layer then draws the route whole, which is what it did before any of this.
   */
  const busLegs = useMemo(() => {
    if (!graph || !selected) return [];
    return selected.legs.flatMap((leg) => {
      if (leg.kind !== 'bus') return [];
      const stopCodes = leg.route.stops.map((s) => s.stopCode);
      const points = stopCodes.map((code) => graph.stops.get(code));
      return [
        {
          route: leg.route,
          stopCodes,
          stopPoints: points.every((p) => p != null) ? (points as Stop[]) : [],
          boardIndex: stopCodes.indexOf(leg.boardStop.code),
          alightIndex: stopCodes.indexOf(leg.alightStop.code),
        },
      ];
    });
  }, [graph, selected]);

  /** Stops on a drawn route that this journey passes by rather than uses. */
  const dimmedStops = useMemo(() => {
    if (view !== 'detail') return [];
    const ridden = new Set(
      busLegs.flatMap((leg) => riddenStopCodes(leg.stopCodes, leg.boardIndex, leg.alightIndex)),
    );
    const rest = new Set<string>();
    for (const leg of busLegs) {
      for (const code of leg.stopCodes) if (!ridden.has(code)) rest.add(code);
    }
    return [...rest];
  }, [view, busLegs]);

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

  /**
   * The journey as drawn and quoted, with its walks measured along real
   * footpaths instead of the crow flies.
   *
   * Only the opened trip is routed: the planner's estimate is what ranks the
   * options, and asking a shared public router about every walk in every
   * candidate would be both slow and rude. Until the answers land — or if they
   * never do, offline — this is the estimate, unchanged.
   */
  const detail = useMemo(
    () => (view === 'detail' ? activeSelection : null),
    [view, activeSelection],
  );
  const { paths: walkPaths } = useWalkPaths(detail);
  const walkedDetail = useMemo(
    () => (detail ? applyWalkPaths(detail, walkPaths) : null),
    [detail, walkPaths],
  );

  /**
   * The journey as it is being travelled, rather than read about.
   *
   * Fed the same routed itinerary the map draws, so the step the rider is on is
   * measured against the footpath they are actually walking. It is built from
   * whatever trip is open, and only becomes a journey once they start one.
   */
  const journey = useJourney(walkedDetail, geo.position, {
    initialStepId: pendingStep.current,
    // A hand-edited or truncated link must not turn the elapsed clock into NaN.
    initialStartedAt: minutesFromUrl(pendingSince.current),
  });
  useWakeLock(journey.active);

  /**
   * The stops of the ride under way, board to alight, so the rider can follow
   * along out of the window. Empty when they are not aboard — and when a stop is
   * missing from the graph, since a count that cannot be right is worth less
   * than none.
   */
  const rideStops = useMemo(() => {
    const step = journey.step;
    if (!graph || step?.kind !== 'ride' || !step.bus) return [];
    const codes = step.bus.route.stops.map((s) => s.stopCode);
    const ridden = riddenStopCodes(
      codes,
      codes.indexOf(step.bus.boardStop.code),
      codes.indexOf(step.bus.alightStop.code),
    );
    const points = ridden.map((code) => graph.stops.get(code));
    return points.every((p) => p != null) ? (points as Stop[]) : [];
  }, [graph, journey.step]);

  const startJourney = useCallback(() => {
    pendingStep.current = null;
    pendingSince.current = null;
    setSnap('half');
    setFollowing(true);
    journey.start();
  }, [journey.start]);

  const endJourney = useCallback(() => {
    pendingStep.current = null;
    pendingSince.current = null;
    journey.end();
  }, [journey.end]);

  // Every new instruction reframes the map on it. Someone who panned away to
  // look at something has finished with that view once they are told to move.
  const stepId = journey.step?.id;
  useEffect(() => {
    if (stepId) setFollowing(true);
  }, [stepId]);

  /**
   * Mirrors the trip into the address bar, so a refresh comes back to it and a
   * copied link takes someone else there. Requests still waiting on the graph or
   * on a location fix are written back as they came in, so a reload during those
   * first seconds does not lose them — and that includes a journey under way,
   * which comes back at the step it was on rather than at the beginning.
   */
  useEffect(() => {
    const travelling = journey.active;
    writeUrlState({
      from: origin ? encodePlace(origin) : encodeRef(pendingFrom.current),
      to: destination ? encodePlace(destination) : encodeRef(pendingTo.current),
      route:
        view === 'detail' && selected
          ? itinerarySignature(selected)
          : (pendingRoute.current ?? undefined),
      step: travelling ? journey.step?.id : (pendingStep.current ?? undefined),
      since: travelling
        ? (journey.startedAt?.toString() ?? undefined)
        : (pendingSince.current ?? undefined),
    });
  }, [origin, destination, selected, view, journey.active, journey.step, journey.startedAt]);

  const handlePick = useCallback(
    (place: Place) => {
      if (searching === 'origin') chooseOrigin(place);
      else if (searching === 'destination') chooseDestination(place);
      else if (searching === 'save') addSaved(place);
      setSearching(null);
    },
    [searching, addSaved, chooseOrigin, chooseDestination],
  );

  const handleStopSelect = useCallback(
    (stopCode: string) => {
      // Mid-journey the sheet belongs to the next instruction. Replacing it with
      // a stop's timetable would also take the trip the journey is following.
      if (journey.active) return;
      const stop = graph?.stops.get(stopCode);
      if (!stop) return;
      setSelectedStop(stop);
      setView('stop');
      setSnap('half');
    },
    [graph, journey.active],
  );

  /** The saved entry this destination already is, so the star can undo itself. */
  const savedDestination = useMemo(
    () =>
      destination &&
      savedPlaces.find(
        (p) => Math.abs(p.lat - destination.lat) < 1e-5 && Math.abs(p.lng - destination.lng) < 1e-5,
      ),
    [savedPlaces, destination],
  );

  const toggleSavedDestination = useCallback(() => {
    if (!destination) return;
    if (savedDestination) removeSaved(savedDestination.id);
    else addSaved(destination);
  }, [destination, savedDestination, addSaved, removeSaved]);

  /**
   * The one action the open screen exists to offer, pinned below it. A journey
   * is read while moving, so the button that completes the current step has to
   * be in the same place every time and never behind a scroll.
   */
  const sheetFooter =
    graph && view === 'detail' && journey.active && walkedDetail ? (
      <JourneyActionBar journey={journey} onExit={endJourney} />
    ) : graph && view === 'detail' && selected ? (
      <StartJourneyBar onStart={startJourney} />
    ) : null;

  if (isError) {
    return <FatalError message={(error as Error).message} onRetry={() => refetch()} />;
  }

  return (
    <div className="relative flex h-[100dvh] w-full overflow-hidden bg-ink-950">
      <div className="relative min-w-0 flex-1">
        <LazyMap className="absolute inset-0">
          <MapPadding bottom={sheetHeightPx} />
          <StopMarkers
            stops={stops}
            onSelect={handleStopSelect}
            highlighted={highlighted}
            dimmed={dimmedStops}
          />
          <UserMarker position={geo.position} />
          <EndpointMarkers origin={origin} destination={destination} userPosition={geo.position} />
          {view === 'detail' &&
            busLegs.map((leg) => (
              <RouteShapeLayer
                key={leg.route.code}
                routeCode={leg.route.code}
                color={leg.route.color}
                stopPoints={leg.stopPoints}
                boardIndex={leg.boardIndex}
                alightIndex={leg.alightIndex}
              />
            ))}
          {view === 'detail' &&
            busLegs.map((leg) => (
              <BusMarkers key={leg.route.code} route={leg.route} />
            ))}
          {walkedDetail && <WalkRouteLayer itinerary={walkedDetail} />}
          {journey.active ? (
            <FollowUser
              position={journey.position}
              step={journey.step}
              active={following}
              onUserMove={() => setFollowing(false)}
            />
          ) : (
            <FitBounds selected={walkedDetail} origin={origin} destination={destination} />
          )}
        </LazyMap>

        {journey.active && !following && geo.position && (
          <button
            type="button"
            onClick={() => setFollowing(true)}
            className="absolute right-4 z-10 inline-flex min-h-11 items-center gap-1.5 rounded-full bg-ink-900/90 px-4 text-sm font-medium text-brand-400 shadow-lg backdrop-blur active:bg-ink-800"
            style={{ bottom: sheetHeightPx + 12 }}
          >
            <LocateIcon />
            Recentre
          </button>
        )}

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

      <BottomSheet snap={snap} onSnapChange={setSnap} footer={sheetFooter}>
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
              chooseOrigin(o);
              chooseDestination(d);
            }}
            onPickSaved={chooseDestination}
            onManageSaved={() => setView('saved')}
          />
        )}

        {graph && view === 'results' && origin && destination && (
          <Results
            origin={origin}
            destination={destination}
            itineraries={itineraries}
            loading={false}
            destinationSaved={Boolean(savedDestination)}
            onToggleSaveDestination={toggleSavedDestination}
            onSelect={(it) => {
              endJourney();
              setSelected(it);
              setView('detail');
              setSnap('half');
            }}
            onEditOrigin={() => setSearching('origin')}
            onEditDestination={() => setSearching('destination')}
          />
        )}

        {graph && view === 'detail' && selected && !journey.active && (
          <TripDetail
            itinerary={walkedDetail ?? selected}
            liveApplied={liveApplied}
            onBack={() => {
              setSelected(null);
              setView('results');
            }}
          />
        )}

        {graph && journey.active && walkedDetail && (
          <JourneyNav
            itinerary={walkedDetail}
            journey={journey}
            rideStops={rideStops}
            position={journey.position}
            liveApplied={liveApplied}
            onExit={endJourney}
          />
        )}

        {graph && view === 'stop' && selectedStop && (
          <StopDetail
            stop={selectedStop}
            graph={graph}
            onClose={() => setView(destination ? 'results' : 'home')}
            onRouteFrom={(s) => {
              chooseOrigin({ name: s.name, lat: s.lat, lng: s.lng, stopCode: s.code });
              setView(destination ? 'results' : 'home');
            }}
            onRouteTo={(s) => {
              chooseDestination({ name: s.name, lat: s.lat, lng: s.lng, stopCode: s.code });
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

function LocateIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 fill-current" aria-hidden>
      <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8.9 3a9 9 0 0 0-7.9-7.9V1h-2v2.1A9 9 0 0 0 3.1 11H1v2h2.1a9 9 0 0 0 7.9 7.9V23h2v-2.1a9 9 0 0 0 7.9-7.9H23v-2h-2.1ZM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z" />
    </svg>
  );
}

/** A clock reading out of the address bar, or null if it is not one. */
function minutesFromUrl(raw: string | null): number | null {
  const minutes = Number(raw);
  return raw && Number.isFinite(minutes) && minutes >= 0 && minutes < 1440 ? minutes : null;
}

/** A place request that has not resolved yet, written back as the URL had it. */
function encodeRef(ref: PlaceRef | null): string | undefined {
  if (!ref) return undefined;
  if (ref.kind === 'current') return 'me';
  if (ref.kind === 'stop') return `stop:${ref.code}`;
  return encodePlace(ref.place);
}

/** Keeps the visible map framed on whatever the sheet is currently showing. */
function FitBounds({
  selected,
  origin,
  destination,
}: {
  selected: Itinerary | null;
  origin: Place | null;
  destination: Place | null;
}) {
  const points = useMemo(() => {
    if (selected) {
      return selected.legs.flatMap((l) =>
        l.kind === 'bus'
          ? [
              { lat: l.boardStop.lat, lng: l.boardStop.lng },
              { lat: l.alightStop.lat, lng: l.alightStop.lng },
            ]
          : // The whole footpath, not just its ends: a walk around a block leaves
            // the box its endpoints describe, and half of it would be off screen.
            walkLineOf(l as WalkLeg).map(([lng, lat]) => ({ lat, lng })),
      );
    }
    if (origin && destination) return [origin, destination];
    return [];
  }, [selected, origin, destination]);

  return <FitBoundsInner points={points} />;
}

const NOWHERE: [[number, number], [number, number]] = [
  [0, 0],
  [0, 0],
];

function FitBoundsInner({ points }: { points: { lat: number; lng: number }[] }) {
  const map = useMap();
  const bounds = useMemo(() => boundsOf(points), [points]);
  const [[west, south], [east, north]] = bounds ?? NOWHERE;

  // Keyed on the box rather than on the array that produced it: the plan is
  // rebuilt every time live times land, and re-fitting the map each minute would
  // yank it out from under a rider who had panned somewhere else.
  useEffect(() => {
    if (!bounds) return;
    // Padding is supplied by <MapPadding>, which tracks the sheet's snap point.
    map.fitBounds(bounds, { maxZoom: 16, duration: 500 });
  }, [map, west, south, east, north]);

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
