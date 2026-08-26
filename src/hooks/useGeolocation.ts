import { useCallback, useEffect, useRef, useState } from 'react';
import type { LatLng } from '@/lib/geo';

export type GeolocationStatus = 'idle' | 'locating' | 'ready' | 'denied' | 'unavailable';

export interface GeolocationState {
  position: (LatLng & { accuracy: number }) | null;
  status: GeolocationStatus;
  error: string | null;
}

const OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 12_000,
  maximumAge: 30_000,
};

/**
 * Browser geolocation with a live watch.
 *
 * `watch` is opt-in: a continuous fix is what makes the map's "follow me" dot
 * useful, but it costs battery, so screens that only need a one-off origin ask
 * for a single reading instead.
 */
export function useGeolocation(watch = false): GeolocationState & { request: () => void } {
  const [state, setState] = useState<GeolocationState>({
    position: null,
    status: 'idle',
    error: null,
  });
  const watchId = useRef<number | null>(null);

  const onSuccess = useCallback((pos: GeolocationPosition) => {
    setState({
      position: {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      },
      status: 'ready',
      error: null,
    });
  }, []);

  const onError = useCallback((err: GeolocationPositionError) => {
    setState((s) => ({
      ...s,
      status: err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable',
      error:
        err.code === err.PERMISSION_DENIED
          ? 'Location permission denied. Search for a starting point instead.'
          : 'Could not get your location.',
    }));
  }, []);

  const request = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setState({ position: null, status: 'unavailable', error: 'Location is not available.' });
      return;
    }
    setState((s) => ({ ...s, status: s.position ? s.status : 'locating', error: null }));
    navigator.geolocation.getCurrentPosition(onSuccess, onError, OPTIONS);
  }, [onSuccess, onError]);

  useEffect(() => {
    if (!watch || !('geolocation' in navigator)) return;
    setState((s) => ({ ...s, status: s.position ? s.status : 'locating' }));
    watchId.current = navigator.geolocation.watchPosition(onSuccess, onError, OPTIONS);
    return () => {
      if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
    };
  }, [watch, onSuccess, onError]);

  return { ...state, request };
}
