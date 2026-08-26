import { useEffect } from 'react';
import { boundsOf, haversineMeters, type LatLng } from '@/lib/geo';
import type { JourneyStep } from '@/lib/transit/journey';
import { useMap } from './MapContext';

/**
 * How far apart the rider and the end of their step may be before framing both
 * stops being useful. A walk to a stop or a bus coming up on one fits easily
 * inside this; a ride across the link road does not, and a box drawn around
 * that is mostly lagoon with the rider a speck at one corner.
 */
const FRAME_M = 1200;
const FOLLOW_ZOOM = 17;
/** Street level rather than doorstep level — a bus covers a block in seconds. */
const RIDE_ZOOM = 16;

interface Props {
  position: LatLng | null;
  /** The step being travelled; what it is decides what the map must not lose. */
  step: JourneyStep | null;
  active: boolean;
  /** Called when the rider pans or zooms the map themselves, which stops the follow. */
  onUserMove?: () => void;
}

/**
 * Keeps the map on whatever the current step is about.
 *
 * A journey is read at walking pace with one hand, so the map has to do the
 * looking — and what it should be looking at changes with the instruction.
 * Walking and riding are about the rider: where they are, and how much of the
 * way is left. Waiting and arriving are about a place: the stop the bus will
 * pull into, the door being walked to. So the two are framed together only when
 * they are close enough for that to show anything, and otherwise the map keeps
 * the half of it that this step is actually about.
 *
 * The distinction matters most at a transfer. The rider gets off in Hulhumalé
 * having last been fixed in Malé, and framing both would draw eight kilometres
 * of link road instead of the stop they are standing at.
 *
 * A deliberate pan hands control back — someone checking what is around the
 * corner should not be dragged to their own dot half a second later.
 */
export function FollowUser({ position, step, active, onUserMove }: Props) {
  const map = useMap();

  useEffect(() => {
    if (!active || !onUserMove) return;

    // `originalEvent` is what separates a gesture from this component's own
    // camera moves, which arrive with no input event behind them.
    const onGesture = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) onUserMove();
    };
    map.on('dragstart', onGesture);
    map.on('zoomstart', onGesture);
    return () => {
      map.off('dragstart', onGesture);
      map.off('zoomstart', onGesture);
    };
  }, [map, active, onUserMove]);

  const lat = position?.lat;
  const lng = position?.lng;
  const kind = step?.kind;
  const targetLat = step?.target.lat;
  const targetLng = step?.target.lng;

  useEffect(() => {
    if (!active) return;

    const here = lat != null && lng != null ? { lat, lng } : null;
    const there = targetLat != null && targetLng != null ? { lat: targetLat, lng: targetLng } : null;

    if (here && there && haversineMeters(here, there) <= FRAME_M) {
      const bounds = boundsOf([here, there]);
      // maxZoom is what keeps two points a few metres apart off the pavement.
      if (bounds) {
        map.fitBounds(bounds, { maxZoom: FOLLOW_ZOOM, duration: 700 });
        return;
      }
    }

    const ridersOwn = kind === 'walk' || kind === 'ride';
    if (ridersOwn && here) {
      map.easeTo({
        center: [here.lng, here.lat],
        zoom: kind === 'ride' ? RIDE_ZOOM : FOLLOW_ZOOM,
        duration: 700,
      });
      return;
    }

    if (there) map.easeTo({ center: [there.lng, there.lat], zoom: FOLLOW_ZOOM, duration: 700 });
  }, [map, active, kind, lat, lng, targetLat, targetLng]);

  return null;
}
