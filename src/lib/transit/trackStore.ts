import { updateTracks, TRAIL_MAX_AGE_MS, type BusTrack, type TrackedBus } from './busTracks';

/**
 * The running bus history, kept per route outside React.
 *
 * A trail is history, and history that lives in a component's ref dies with the
 * component. `<BusMarkers>` unmounts whenever the detail view closes, so
 * selecting a route, going back, and selecting it again used to start every bus
 * from a blank trail even though its positions came back from cache instantly.
 * Holding it here means re-entering a route resumes the trail already earned,
 * and the two hooks that track the same route — the markers and the boarded-bus
 * detector — fold one shared history instead of a private copy each.
 *
 * Nothing is evicted on route change; the whole fleet is ~37 buses with a dozen
 * trail points apiece. What is dropped is *stale* history: a route not fed for
 * longer than a trail's life is cleared on the next read, so an old position is
 * never drawn as a current one.
 */
const histories = new Map<string, Map<string, BusTrack>>();
/** Rebuilt only on commit, so `getSnapshot` can return a stable reference. */
const snapshots = new Map<string, BusTrack[]>();
/** The poll each route last folded, so two hooks cannot fold it twice. */
const foldedAt = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

const EMPTY: BusTrack[] = [];

/** Folds one poll of positions into a route's history and notifies readers. */
export function commitTracks(routeCode: string, buses: readonly TrackedBus[], at: number): void {
  if (foldedAt.get(routeCode) === at) return;
  foldedAt.set(routeCode, at);

  const history = updateTracks(histories.get(routeCode) ?? new Map(), buses, at);
  histories.set(routeCode, history);
  snapshots.set(routeCode, [...history.values()]);

  for (const listener of listeners.get(routeCode) ?? []) listener();
}

/**
 * A route's tracks, oldest history included.
 *
 * Stale history is expired here rather than on a timer: the check is what a
 * reader needs before trusting what it gets, and it costs nothing while a route
 * is being fed. Expiring mutates once and then leaves the snapshot alone, so
 * repeated reads keep returning the same array.
 */
export function readTracks(routeCode: string | null, now = Date.now()): BusTrack[] {
  if (routeCode === null) return EMPTY;
  const snapshot = snapshots.get(routeCode);
  if (!snapshot) return EMPTY;
  if (snapshot.length > 0 && now - snapshot[0].updatedAt > TRAIL_MAX_AGE_MS) {
    histories.delete(routeCode);
    snapshots.delete(routeCode);
    foldedAt.delete(routeCode);
    return EMPTY;
  }
  return snapshot;
}

export function subscribeTracks(routeCode: string | null, listener: () => void): () => void {
  if (routeCode === null) return () => {};
  let forRoute = listeners.get(routeCode);
  if (!forRoute) {
    forRoute = new Set();
    listeners.set(routeCode, forRoute);
  }
  forRoute.add(listener);
  return () => {
    forRoute.delete(listener);
    if (forRoute.size === 0) listeners.delete(routeCode);
  };
}

/** Test seam: forgets everything, as a fresh tab would. */
export function resetTracks(): void {
  histories.clear();
  snapshots.clear();
  foldedAt.clear();
}
