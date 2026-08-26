/**
 * RTL public APIs. All are unauthenticated and send `Access-Control-Allow-Origin: *`,
 * so they are called straight from the browser — no proxy, no key.
 *
 * Note the non-standard port 4455, which some restrictive networks block; callers
 * should surface `RtlApiError` rather than spinning forever.
 */
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

export function fetchRouteDetails(signal?: AbortSignal): Promise<RouteDetailsResponse> {
  return request<RouteDetailsResponse>(`${BOOKING_BASE}/booking/v2/bus/routedetails`, { signal });
}

export function fetchRoadShape(routeCode: string, signal?: AbortSignal): Promise<RoadShapeResponse> {
  return postJson<RoadShapeResponse>('/booking/v2/bus/roadshape', { routeCode }, signal);
}

export function fetchLiveCoordinates(
  routeCode: string,
  signal?: AbortSignal,
): Promise<LiveCoordinatesResponse> {
  return postJson<LiveCoordinatesResponse>('/booking/v1/bus/livecoordinates', { routeCode }, signal);
}

export function fetchStopEtas(routeCode: string, signal?: AbortSignal): Promise<StopsEtaResponse> {
  return postJson<StopsEtaResponse>('/gps-engine/eta/all-stops-of-route', { routeCode }, signal);
}
