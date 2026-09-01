/**
 * RTL public APIs. All are unauthenticated and send `Access-Control-Allow-Origin: *`,
 * so they can be called straight from the browser — no proxy, no key.
 *
 * Note the non-standard port 4455, which some restrictive networks block; callers
 * should surface `RtlApiError` rather than spinning forever. Reaching those
 * networks is one reason the optional backend exists.
 *
 * Each fetcher below asks the backend first and falls back to RTL directly, so
 * these functions have the same contract whether or not a server is configured
 * or reachable. Every call site above this file is unchanged by its presence.
 */
import { fetchFromBackend } from './backend';

const BOOKING_BASE = 'https://bo.rtl.mv:4455/maldives/api';

export class RtlApiError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'RtlApiError';
  }
}

/** Raw shapes as returned by RTL. Deliberately loose — validated on normalize. */
export interface RawTiming {
  order: number;
  timing: string;
}
export interface RawStop {
  id: number;
  order: number;
  name: string;
  dvname: string;
  code: string;
  latitude: string;
  longitude: string;
  timings: RawTiming[] | null;
}
export interface RawRoute {
  id: number;
  code: string;
  name: string;
  dvname: string;
  routeNumber: string;
  busRouteStopList: RawStop[] | null;
  color: string | null;
  isMiniBusRoute: number;
  fare: number | null;
  isDistanceFareType: number;
  depotName: string | null;
}
export interface RouteDetailsResponse {
  routeResponse: RawRoute[] | null;
  /** Other atolls. Greater Malé only, so this is ignored. */
  atollRouteResponse?: unknown;
}

export interface LiveBus {
  busCode: string;
  plateNumber: string;
  latitude: number;
  longitude: number;
}
export interface LiveCoordinatesResponse {
  busList: LiveBus[] | null;
}

export interface RawStopEta {
  eta: string;
  vehicleCode: string;
  stopName: string;
  stopCode: string;
  stopOrder: number;
  routeCode: string;
  routeName: string;
  destination: string;
  direction: string;
}
export interface StopsEtaResponse {
  inboundStopsETAList: RawStopEta[] | null;
  /** Observed null in every capture; handled but not relied on. */
  outboundStopsETAList: RawStopEta[] | null;
}

export type RoadShapeResponse = {
  roadShape: GeoJSON.FeatureCollection | null;
};

async function request<T>(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: init?.signal ?? controller.signal,
      headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new RtlApiError(`RTL responded ${res.status} for ${url}`);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof RtlApiError) throw err;
    throw new RtlApiError(
      'Could not reach the RTL bus service. Check your connection and try again.',
      err,
    );
  } finally {
    clearTimeout(timer);
  }
}

function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(`${BOOKING_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * Routes, stops, coordinates and timetables.
 *
 * The backend serves this in RTL's own shape rather than a prebuilt graph, so
 * `buildGraph` stays the single normalizer and the two paths cannot disagree
 * about what a route is. The backend's copy also carries the whole day, where
 * RTL returns only departures still to come.
 */
export async function fetchRouteDetails(signal?: AbortSignal): Promise<RouteDetailsResponse> {
  const served = await fetchFromBackend<RouteDetailsResponse>('/v1/graph', signal);
  if (served) return served;
  return request<RouteDetailsResponse>(`${BOOKING_BASE}/booking/v2/bus/routedetails`, { signal });
}

/** Route geometry. The backend's copy arrives already simplified. */
export async function fetchRoadShape(
  routeCode: string,
  signal?: AbortSignal,
): Promise<RoadShapeResponse> {
  const served = await fetchFromBackend<RoadShapeResponse>(
    `/v1/shapes/${encodeURIComponent(routeCode)}`,
    signal,
  );
  if (served) return served;
  return postJson<RoadShapeResponse>('/booking/v2/bus/roadshape', { routeCode }, signal);
}

export async function fetchLiveCoordinates(
  routeCode: string,
  signal?: AbortSignal,
): Promise<LiveCoordinatesResponse> {
  const served = await fetchFromBackend<LiveCoordinatesResponse>(
    `/v1/live/${encodeURIComponent(routeCode)}`,
    signal,
  );
  if (served) return served;
  return postJson<LiveCoordinatesResponse>('/booking/v1/bus/livecoordinates', { routeCode }, signal);
}

export function fetchStopEtas(routeCode: string, signal?: AbortSignal): Promise<StopsEtaResponse> {
  return postJson<StopsEtaResponse>('/gps-engine/eta/all-stops-of-route', { routeCode }, signal);
}

/** One route's ETA rows as the batch endpoint returns them. */
export interface BatchedEtaRoute extends StopsEtaResponse {
  /** How long the backend had been holding this reading, in ms. */
  ageMs: number;
}

export interface BatchedEtasResponse {
  routes: Record<string, BatchedEtaRoute>;
}

/**
 * ETAs for several routes in one request, or null when there is no backend.
 *
 * This is the call that most justifies the server: unbatched, a single phone
 * comparing a few itineraries can issue upwards of thirty ETA requests a minute,
 * one per route per poll.
 */
export function fetchStopEtasBatch(
  routeCodes: string[],
  signal?: AbortSignal,
): Promise<BatchedEtasResponse | null> {
  if (routeCodes.length === 0) return Promise.resolve({ routes: {} });
  const query = encodeURIComponent(routeCodes.join(','));
  return fetchFromBackend<BatchedEtasResponse>(`/v1/etas?routes=${query}`, signal);
}
