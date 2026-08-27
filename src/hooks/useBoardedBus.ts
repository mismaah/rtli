import { useEffect, useMemo, useState } from 'react';
import { pickBoardedBus, type JourneyStep } from '@/lib/transit/journey';
import type { LatLng } from '@/lib/geo';
import { useTrackedBuses } from './useTrackedBuses';

export interface BoardedBus extends LatLng {
  busCode: string;
  plateNumber: string;
  /** Epoch ms of the poll this position came from. */
  updatedAt: number;
}

/**
 * The bus the rider is actually sitting on, followed through the live feed.
 *
 * A phone is a poor witness to a bus ride. It is in a pocket, it is between
 * buildings, and the browser is free to stop watching it the moment the screen
 * dims — so a journey that counts stops off the rider's own fix stops counting
 * exactly when the rider stops looking. The bus, meanwhile, is on a tracker that
 * reports every ten seconds regardless, and the app is already polling it to
 * draw the marker on the map.
 *
 * So the vehicle is identified once, at boarding, and then held: the feed is
 * matched against it by code from there on. Held rather than re-matched each
 * poll because "the nearest bus" stops meaning the right bus as soon as the
 * ride is under way and the route's other buses are somewhere along it too.
 */
export function useBoardedBus(
  step: JourneyStep | null,
  fix: LatLng | null,
): BoardedBus | null {
  const riding = step?.kind === 'ride' ? step : null;
  const routeCode = riding?.bus?.route.code ?? null;
  const { tracks } = useTrackedBuses(routeCode);
  const [busCode, setBusCode] = useState<string | null>(null);

  // Each ride is its own bus, and a step the rider stepped back out of and into
  // again should look for it afresh rather than resume following the last one.
  const stepId = riding?.id ?? null;
  useEffect(() => {
    setBusCode(null);
  }, [stepId]);

  // Read out as plain numbers so a replanned itinerary handing back an equal but
  // fresh stop object does not count as a change worth re-running the match for.
  const boardLat = riding?.bus?.boardStop.lat ?? null;
  const boardLng = riding?.bus?.boardStop.lng ?? null;
  const expected = riding?.bus?.liveEta?.vehicleCode ?? null;

  useEffect(() => {
    if (boardLat == null || boardLng == null || busCode || tracks.length === 0) return;
    // The stop first, because that is where the rider's tap says the bus was a
    // moment ago. Their own fix is the fallback, which is what picks the bus up
    // again for a journey resumed from a link halfway along the ride.
    const found =
      pickBoardedBus(tracks, { lat: boardLat, lng: boardLng }, expected) ??
      (fix ? pickBoardedBus(tracks, fix, expected) : null);
    if (found) setBusCode(found);
  }, [boardLat, boardLng, busCode, tracks, expected, fix]);

  return useMemo(() => {
    if (!busCode) return null;
    // A bus that has dropped out of the feed is not reporting a position, and a
    // remembered one would quietly freeze the ride at wherever it was last seen.
    const track = tracks.find((t) => t.busCode === busCode);
    if (!track) return null;
    return {
      lat: track.lat,
      lng: track.lng,
      busCode: track.busCode,
      plateNumber: track.plateNumber,
      updatedAt: track.updatedAt,
    };
  }, [busCode, tracks]);
}
