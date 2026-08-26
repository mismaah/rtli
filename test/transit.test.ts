import { describe, it, expect } from 'vitest';
import fixture from './fixtures/routedetails.json';
import roadShapeR1 from './fixtures/roadshape-r1.json';
import { buildGraph, MAX_TRANSFER_WALK_M } from '@/lib/transit/buildGraph';
import {
  generalizedCost,
  itinerarySignature,
  planJourney,
  totalDistanceM,
} from '@/lib/transit/plan';
import { mergeLiveEtas, routeCodesOf, type LiveEtaIndex } from '@/lib/transit/liveOverlay';
import { parseEta } from '@/lib/transit/parseEta';
import {
  parseClock,
  formatClock,
  formatDuration,
  minutesOfDay,
  formatAgo,
  msUntilNextMinute,
} from '@/lib/time';
import { haversineMeters, bearingDegrees, compassPoint, type LatLng } from '@/lib/geo';
import {
  updateTracks,
  isStopped,
  MIN_MOVE_M,
  MAX_GAP_MS,
  TRAIL_MAX_AGE_MS,
  TRAIL_MAX_POINTS,
} from '@/lib/transit/busTracks';
import {
  FULL_SNAP_M,
  NO_SNAP_M,
  nearestOnPath,
  polylinesOf,
  snapToRoute,
} from '@/lib/transit/snapToRoute';
import {
  currentLocation,
  encodePlace,
  parsePlaceRef,
  placeKey,
  resolvePlaceRef,
  samePlace,
} from '@/lib/transit/places';
import { readUrlState, toQueryString, writeUrlState } from '@/lib/urlState';
import { applyWalkPaths, walkLineOf, walkPathKey } from '@/lib/transit/walkPaths';
import { riddenShape, riddenStopCodes, shapePath, stopOffsets } from '@/lib/transit/routeShape';
import {
  APPROACH_RADIUS_M,
  ARRIVE_RADIUS_M,
  arrivalRadius,
  believedPosition,
  TRUST_M,
  buildJourney,
  journeyFraction,
  shouldAutoAdvance,
  stepProgress,
  stopsRemaining,
} from '@/lib/transit/journey';
import { useRecentTrips } from '@/store/recentTrips';
import type { LiveBus } from '@/api/rtl';
import type { RouteDetailsResponse } from '@/api/rtl';
import type { BusLeg, Itinerary, Place, WalkLeg } from '@/lib/transit/types';
import type { WalkPath } from '@/api/walking';

const graph = buildGraph(fixture as unknown as RouteDetailsResponse);

/** Fixture captured live on 2026-08-26; trip 29 was the first full R1 trip in it. */
const R1_TRIP = 29;

function stopPlace(code: string): Place {
  const stop = graph.stops.get(code);
  if (!stop) throw new Error(`fixture is missing stop ${code}`);
  return { name: stop.name, lat: stop.lat, lng: stop.lng, stopCode: stop.code };
}

describe('buildGraph', () => {
  it('loads the 15 Greater Malé routes and 101 unique stops', () => {
    expect(graph.routes.size).toBe(15);
    expect(graph.stops.size).toBe(101);
  });

  it('ignores atollRouteResponse', () => {
    const withAtolls = buildGraph({
      ...(fixture as unknown as RouteDetailsResponse),
      atollRouteResponse: [{ name: 'R.Dhuvaafaru', routeResponse: [{ code: 'ZZZ' }] }],
    });
    expect(withAtolls.routes.size).toBe(15);
    expect(withAtolls.routes.has('ZZZ')).toBe(false);
  });

  it('trims trailing tabs and spaces from names', () => {
    for (const stop of graph.stops.values()) {
      expect(stop.name).toBe(stop.name.trim());
      expect(stop.name).not.toMatch(/\t/);
    }
    expect(graph.stops.get('201')?.name).toBe('Carnival');
    expect(graph.stops.get('1313')?.name).toBe('Villimale Hospital');
  });

  it('parses coordinates from strings into finite numbers', () => {
    for (const stop of graph.stops.values()) {
      expect(Number.isFinite(stop.lat)).toBe(true);
      expect(Number.isFinite(stop.lng)).toBe(true);
    }
  });

  it('pivots timings[].order into whole trips across every stop', () => {
    const r1 = graph.routes.get('133')!;
    const trip = r1.trips.find((t) => t.tripOrder === R1_TRIP)!;
    expect(trip).toBeDefined();
    expect(r1.stops).toHaveLength(18);
    // Stop 1 Maafannu Bus Terminal -> stop 18 Maafannu Bus Terminal OPP.
    expect(trip.times[0]).toBe(parseClock('12:45'));
    expect(trip.times[17]).toBe(parseClock('13:55'));
  });

  it('keeps route stops ordered outbound then along the OPP return leg', () => {
    const r1 = graph.routes.get('133')!;
    expect(r1.stops.map((s) => s.order)).toEqual([...r1.stops.map((s) => s.order)].sort((a, b) => a - b));
    expect(r1.stops[3].stopCode).toBe('106');   // Hulhumale' Cemetery
    expect(r1.stops[14].stopCode).toBe('11106'); // ...OPP, same coords, later order
  });

  it('marks R10, R11, R12 and R15 as frequency routes with no timetable', () => {
    for (const code of ['122', '121', '130', '146']) {
      const route = graph.routes.get(code)!;
      expect(route.trips).toHaveLength(0);
      expect(route.headwayMin).toBeGreaterThan(0);
    }
    // ...and the scheduled routes do have trips.
    expect(graph.routes.get('133')!.trips.length).toBeGreaterThan(10);
  });

  it('never creates a walk transfer that crosses water', () => {
    for (const [from, transfers] of graph.walkTransfers) {
      const a = graph.stops.get(from)!;
      for (const t of transfers) {
        const b = graph.stops.get(t.to)!;
        expect(haversineMeters(a, b)).toBeLessThanOrEqual(MAX_TRANSFER_WALK_M);
      }
    }
  });
});

describe('planJourney', () => {
  const noon = parseClock('12:00')!;

  it('finds the direct R1 ride from Maafannu Bus Terminal to Amin Avenue', () => {
    const results = planJourney(graph, stopPlace('103'), stopPlace('114'), { departAt: noon });
    expect(results.length).toBeGreaterThan(0);

    const direct = results.find(
      (it) => it.legs.filter((l) => l.kind === 'bus').length === 1,
    )!;
    expect(direct).toBeDefined();

    const bus = direct.legs.find((l): l is BusLeg => l.kind === 'bus')!;
    expect(bus.route.routeNumber).toBe('R1');
    expect(bus.boardStop.code).toBe('103');
    expect(bus.alightStop.code).toBe('114');
    expect(bus.numStops).toBe(12);
    expect(bus.arriveAt - bus.departAt).toBe(42);
    expect(direct.transfers).toBe(0);
    expect(direct.totalFare).toBe(10);
    expect(direct.estimated).toBe(false);
  });

  it('reaches Hulhumalé Phase 2 from Malé within two transfers', () => {
    const results = planJourney(graph, stopPlace('103'), stopPlace('602'), { departAt: noon });
    expect(results.length).toBeGreaterThan(0);
    for (const it of results) expect(it.transfers).toBeLessThanOrEqual(2);
  });

  it('never boards a bus backwards along the route order', () => {
    const results = planJourney(graph, stopPlace('103'), stopPlace('114'), { departAt: noon });
    for (const it of results) {
      for (const leg of it.legs) {
        if (leg.kind !== 'bus') continue;
        const board = leg.route.stops.findIndex((s) => s.stopCode === leg.boardStop.code);
        const alight = leg.route.stops.findIndex((s) => s.stopCode === leg.alightStop.code);
        expect(alight).toBeGreaterThan(board);
      }
    }
  });

  it('returns nothing for Malé to Villimalé, which is ferry-only', () => {
    const results = planJourney(graph, stopPlace('103'), stopPlace('1301'), { departAt: noon });
    expect(results).toHaveLength(0);
  });

  it('flags itineraries that rely on an unscheduled minibus route', () => {
    // R13 is Villimalé-internal and scheduled; R11 is an unscheduled Malé minibus.
    const results = planJourney(graph, stopPlace('1102'), stopPlace('1109'), { departAt: noon });
    const usingFrequency = results.filter((it) =>
      it.legs.some((l) => l.kind === 'bus' && l.estimated),
    );
    for (const it of usingFrequency) expect(it.estimated).toBe(true);
  });

  it('walks instead of routing a bus when the destination is next door', () => {
    const from = stopPlace('103');
    const near: Place = { name: 'Around the corner', lat: from.lat + 0.0004, lng: from.lng };
    const results = planJourney(graph, from, near, { departAt: noon });
    expect(results[0].legs).toHaveLength(1);
    expect(results[0].legs[0].kind).toBe('walk');
    expect(results[0].totalFare).toBe(0);
  });

  it('never chains one walk leg straight into another', () => {
    // A walk transfer exists so the next round can board elsewhere; ending a
    // journey on one produced 2.3 km of walking before this was fixed.
    for (const dest of ['114', '602', '401', '1109']) {
      for (const it of planJourney(graph, stopPlace('103'), stopPlace(dest), { departAt: noon })) {
        for (let i = 1; i < it.legs.length; i++) {
          expect(it.legs[i - 1].kind === 'walk' && it.legs[i].kind === 'walk').toBe(false);
        }
      }
    }
  });

  it('honours the per-leg and whole-trip walking caps', () => {
    const results = planJourney(graph, stopPlace('103'), stopPlace('602'), {
      departAt: noon,
      maxWalkM: 500,
      maxTotalWalkM: 900,
    });
    for (const it of results) {
      expect(it.totalWalkM).toBeLessThanOrEqual(900);
      for (const leg of it.legs) {
        if (leg.kind === 'walk') expect(leg.meters).toBeLessThanOrEqual(500);
      }
    }
  });

  it('prefers staying on the bus over walking to shave a few minutes', () => {
    // R1 runs 103 -> 114 directly; alighting early and walking 594 m arrives
    // 4 min sooner but should not outrank the direct ride.
    const results = planJourney(graph, stopPlace('103'), stopPlace('114'), { departAt: noon });
    const direct = results.findIndex(
      (it) => it.legs.length === 1 && it.legs[0].kind === 'bus',
    );
    const earlyDrop = results.findIndex((it) =>
      it.legs.some((l) => l.kind === 'bus' && l.alightStop.code === '108'),
    );
    expect(direct).toBeGreaterThanOrEqual(0);
    if (earlyDrop >= 0) expect(direct).toBeLessThan(earlyDrop);
  });

  it('measures how far each ride actually goes', () => {
    const results = planJourney(graph, stopPlace('103'), stopPlace('114'), { departAt: noon });
    const direct = results.find((it) => it.legs.filter((l) => l.kind === 'bus').length === 1)!;
    const bus = direct.legs.find((l): l is BusLeg => l.kind === 'bus')!;

    // 12 stops of R1; further than the straight line, and not implausibly so.
    const asTheCrowFlies = haversineMeters(bus.boardStop, bus.alightStop);
    expect(bus.meters).toBeGreaterThan(asTheCrowFlies);
    expect(bus.meters).toBeLessThan(15_000);
    expect(direct.totalRideM).toBeCloseTo(bus.meters, 6);
    expect(totalDistanceM(direct)).toBeCloseTo(direct.totalWalkM + direct.totalRideM, 6);
  });

  it('walks less when asked to, without exceeding the rider\'s walking cap either way', () => {
    const from = stopPlace('103');
    const to = stopPlace('602');
    const less = planJourney(graph, from, to, { departAt: noon, walkPreference: 'less' });
    const more = planJourney(graph, from, to, { departAt: noon, walkPreference: 'more' });

    expect(less.length).toBeGreaterThan(0);
    expect(more.length).toBeGreaterThan(0);
    expect(less[0].totalWalkM).toBeLessThanOrEqual(more[0].totalWalkM);
    for (const it of [...less, ...more]) expect(it.totalWalkM).toBeLessThanOrEqual(1600);
  });

  it('never transfers from a route onto the same route', () => {
    // The loop-shaped stop lists let the search alight from R2 and board R2
    // again further along, which no rider would ever do.
    for (const dest of ['113', '114', '602', '401', '109']) {
      for (const it of planJourney(graph, stopPlace('103'), stopPlace(dest), { departAt: noon })) {
        const codes = it.legs.filter((l) => l.kind === 'bus').map((l) => l.route.code);
        for (let i = 1; i < codes.length; i++) expect(codes[i]).not.toBe(codes[i - 1]);
      }
    }
  });

  it('produces legs that chain end to end', () => {
    const results = planJourney(graph, stopPlace('103'), stopPlace('602'), { departAt: noon });
    for (const it of results) {
      for (let i = 1; i < it.legs.length; i++) {
        const prev = it.legs[i - 1];
        const cur = it.legs[i];
        const prevEnd = prev.kind === 'walk' ? prev.to : { lat: prev.alightStop.lat, lng: prev.alightStop.lng };
        const curStart = cur.kind === 'walk' ? cur.from : { lat: cur.boardStop.lat, lng: cur.boardStop.lng };
        expect(haversineMeters(prevEnd, curStart)).toBeLessThan(1);
      }
    }
  });
});

/** Bare itinerary carrying only the fields the ranking reads. */
function ranked(over: Partial<Itinerary>): Itinerary {
  return {
    id: 'x',
    legs: [],
    departAt: 720,
    arriveAt: 760,
    totalWalkM: 0,
    totalRideM: 0,
    transfers: 0,
    totalFare: 0,
    estimated: false,
    ...over,
  };
}

describe('generalizedCost', () => {
  it('charges every fare, so a cheaper trip wins a near-tie on time', () => {
    const oneBus = ranked({ arriveAt: 763, totalFare: 10 });
    const twoBuses = ranked({ arriveAt: 760, totalFare: 25, transfers: 1 });
    expect(generalizedCost(oneBus)).toBeLessThan(generalizedCost(twoBuses));
  });

  it('still picks the dearer trip when it saves real time', () => {
    const slowAndCheap = ranked({ arriveAt: 800, totalFare: 10 });
    const fastAndDear = ranked({ arriveAt: 760, totalFare: 25, transfers: 1 });
    expect(generalizedCost(fastAndDear)).toBeLessThan(generalizedCost(slowAndCheap));
  });

  it('reorders the same two trips when the rider would rather not walk', () => {
    const shortWalk = ranked({ arriveAt: 768, totalWalkM: 150 });
    const longWalk = ranked({ arriveAt: 760, totalWalkM: 700 });

    expect(generalizedCost(longWalk, 'more')).toBeLessThan(generalizedCost(shortWalk, 'more'));
    expect(generalizedCost(shortWalk, 'less')).toBeLessThan(generalizedCost(longWalk, 'less'));
  });

  it('leaves distance ridden out of the ranking, since arrival time already pays for it', () => {
    const near = ranked({ totalRideM: 1_000 });
    const far = ranked({ totalRideM: 9_000 });
    expect(generalizedCost(near)).toBe(generalizedCost(far));
  });
});

describe('following the clock', () => {
  /**
   * The reported bug: the app sat on the results at 13:55 showing a 14:00
   * departure, and at 14:00 the list still showed it. Planning is pure, so the
   * regression is pinned here on the planner's contract — a plan made a minute
   * later must not still be offering the bus that has already gone.
   */
  it('drops a departure once the clock passes it', () => {
    const early = planJourney(graph, stopPlace('103'), stopPlace('114'), {
      departAt: parseClock('12:00')!,
    });
    const firstBus = early[0].legs.find((l): l is BusLeg => l.kind === 'bus')!;

    const afterItLeft = planJourney(graph, stopPlace('103'), stopPlace('114'), {
      departAt: firstBus.departAt + 1,
    });
    const nextBus = afterItLeft[0].legs.find((l): l is BusLeg => l.kind === 'bus')!;

    expect(nextBus.departAt).toBeGreaterThan(firstBus.departAt);
  });

  it('keeps identifying the same journey across replans', () => {
    const noon = parseClock('12:00')!;
    const early = planJourney(graph, stopPlace('103'), stopPlace('114'), { departAt: noon });
    // Replanned from just after that trip pulled away, as the minute tick does.
    const later = planJourney(graph, stopPlace('103'), stopPlace('114'), {
      departAt: early[0].departAt + 1,
    });

    const signature = itinerarySignature(early[0]);
    const same = later.find((it) => itinerarySignature(it) === signature);

    // Same buses, same stops, a later departure — this is what lets the detail
    // screen refresh in place instead of freezing on the trip that has gone.
    expect(same).toBeDefined();
    expect(same!.departAt).toBeGreaterThan(early[0].departAt);
  });
});

describe('live ETA overlay', () => {
  const noon = parseClock('12:00')!;
  const itineraries = planJourney(graph, stopPlace('103'), stopPlace('114'), { departAt: noon });

  it('collects the routes to poll, sorted and deduplicated', () => {
    const codes = routeCodesOf(itineraries);
    expect(codes.length).toBeGreaterThan(0);
    expect(codes).toEqual([...new Set(codes)]);
    expect(codes).toEqual([...codes].sort());
  });

  it('attaches an ETA to the leg boarding that stop', () => {
    const bus = itineraries[0].legs.find((l): l is BusLeg => l.kind === 'bus')!;
    const index: LiveEtaIndex = new Map([
      [bus.route.code, new Map([[bus.boardStop.code, { minutes: 4, vehicleCode: 'B1', label: '4 min' }]])],
    ]);

    const merged = mergeLiveEtas(itineraries, index);
    const mergedBus = merged[0].legs.find((l): l is BusLeg => l.kind === 'bus')!;

    expect(mergedBus.liveEta?.minutes).toBe(4);
    // The schedule is untouched — live data annotates the plan, never rewrites it.
    expect(mergedBus.departAt).toBe(bus.departAt);
  });

  it('preserves identity when a poll matches nothing, so the list does not churn', () => {
    expect(mergeLiveEtas(itineraries, new Map())).toBe(itineraries);

    const irrelevant: LiveEtaIndex = new Map([
      ['NOPE', new Map([['999', { minutes: 1, vehicleCode: 'B9', label: '1 min' }]])],
    ]);
    const merged = mergeLiveEtas(itineraries, irrelevant);
    for (let i = 0; i < itineraries.length; i++) expect(merged[i]).toBe(itineraries[i]);
  });
});

describe('parseEta', () => {
  it('reads the numeric form, including the trailing space RTL sends', () => {
    expect(parseEta('5 Minutes ')).toEqual({ minutes: 5, vehicleCode: '', label: '5 min' });
    expect(parseEta('1 Minutes ')?.minutes).toBe(1);
    expect(parseEta('56 Minutes ')?.minutes).toBe(56);
  });

  it('reads the two known phrase forms', () => {
    expect(parseEta('Entering the station')).toMatchObject({ minutes: 0, label: 'Arriving' });
    expect(parseEta('Send in 5 minutes')).toMatchObject({ minutes: 5 });
  });

  it('returns null rather than a bogus number for junk', () => {
    for (const junk of ['', '   ', null, undefined, 'soon', 'N/A', '--']) {
      expect(parseEta(junk)).toBeNull();
    }
  });
});

describe('time helpers', () => {
  it('round-trips clock strings', () => {
    expect(parseClock('13:40:00')).toBe(820);
    expect(formatClock(820)).toBe('13:40');
    expect(parseClock('00:00:00')).toBe(0);
  });

  it('rejects malformed clocks', () => {
    for (const bad of ['', '25:00', '12:70', 'abc', null]) expect(parseClock(bad)).toBeNull();
  });

  it('wraps times past midnight when formatting', () => {
    expect(formatClock(1450)).toBe('00:10');
  });

  it('formats durations', () => {
    expect(formatDuration(5)).toBe('5 min');
    expect(formatDuration(60)).toBe('1 hr');
    expect(formatDuration(95)).toBe('1 hr 35 min');
  });

  it('pins minutesOfDay to UTC+5 regardless of host timezone', () => {
    // 2026-08-26T07:30:00Z is 12:30 in Malé.
    expect(minutesOfDay(new Date('2026-08-26T07:30:00Z'))).toBe(12 * 60 + 30);
  });

  it('re-arms the clock tick on the minute boundary, not 60s from now', () => {
    // 13:55:59 in Malé — a fixed 60s interval would next fire at 13:56:59,
    // leaving the 13:56 departure listed for the whole minute after it left.
    const late = Date.parse('2026-08-26T08:55:59.000Z');
    expect(msUntilNextMinute(late)).toBe(1_000);

    expect(msUntilNextMinute(Date.parse('2026-08-26T08:55:00.000Z'))).toBe(60_000);
    expect(msUntilNextMinute(Date.parse('2026-08-26T08:55:30.500Z'))).toBe(29_500);
  });

  it('crosses the minute so a departure at 14:00 stops being in the future', () => {
    const before = Math.floor(minutesOfDay(new Date('2026-08-26T08:59:30Z')));
    const after = Math.floor(minutesOfDay(new Date('2026-08-26T09:00:30Z')));

    expect(before).toBe(13 * 60 + 59);
    expect(after).toBe(14 * 60);
  });
});

describe('bearing', () => {
  const male = { lat: 4.1755, lng: 73.5093 };

  it('reads due north, east, south and west', () => {
    expect(bearingDegrees(male, { lat: male.lat + 0.01, lng: male.lng })).toBeCloseTo(0, 1);
    expect(bearingDegrees(male, { lat: male.lat, lng: male.lng + 0.01 })).toBeCloseTo(90, 1);
    expect(bearingDegrees(male, { lat: male.lat - 0.01, lng: male.lng })).toBeCloseTo(180, 1);
    expect(bearingDegrees(male, { lat: male.lat, lng: male.lng - 0.01 })).toBeCloseTo(270, 1);
  });

  it('always answers in 0..360', () => {
    const b = bearingDegrees(male, { lat: male.lat - 0.01, lng: male.lng - 0.01 });
    expect(b).toBeGreaterThan(180);
    expect(b).toBeLessThan(270);
  });

  it('names the eight compass points, wrapping at north', () => {
    expect(compassPoint(0)).toBe('north');
    expect(compassPoint(45)).toBe('north-east');
    expect(compassPoint(181)).toBe('south');
    expect(compassPoint(359)).toBe('north');
    expect(compassPoint(-90)).toBe('west');
  });
});

describe('bus tracks', () => {
  const START = 1_000_000;
  /** ~11.1 m per 0.0001° of latitude at the equator. */
  const bus = (lat: number, lng = 73.5093): LiveBus[] => [
    { busCode: 'B1', plateNumber: 'A0A0000', latitude: lat, longitude: lng },
  ];

  it('has no heading for a bus seen only once', () => {
    const tracks = updateTracks(new Map(), bus(4.1755), START);
    const t = tracks.get('B1')!;
    expect(t.heading).toBeNull();
    expect(t.speedMps).toBeNull();
    expect(t.firstSeenAt).toBe(START);
  });

  it('infers heading and speed once the bus clears the jitter radius', () => {
    let tracks = updateTracks(new Map(), bus(4.1755), START);
    // 0.0009° north is ~100 m, well beyond MIN_MOVE_M.
    tracks = updateTracks(tracks, bus(4.1764), START + 10_000);

    const t = tracks.get('B1')!;
    expect(t.heading).toBeCloseTo(0, 0);
    expect(t.speedMps).toBeCloseTo(10, 0);
    expect(t.movedAt).toBe(START + 10_000);
  });

  it('ignores GPS jitter: no heading, and movedAt stays put', () => {
    let tracks = updateTracks(new Map(), bus(4.1755), START);
    // ~5.5 m, under the threshold.
    tracks = updateTracks(tracks, bus(4.17555), START + 10_000);

    const t = tracks.get('B1')!;
    expect(haversineMeters({ lat: 4.1755, lng: 73.5093 }, t)).toBeLessThan(MIN_MOVE_M);
    expect(t.heading).toBeNull();
    expect(t.movedAt).toBe(START);
    // The reported position is still shown, even though it did not re-anchor.
    expect(t.lat).toBe(4.17555);
    expect(t.updatedAt).toBe(START + 10_000);
  });

  it('measures from the anchor, so a slow crawl still yields a heading', () => {
    let tracks = updateTracks(new Map(), bus(4.1755), START);
    // Three sub-threshold steps that add up to ~16 m.
    tracks = updateTracks(tracks, bus(4.17555), START + 10_000);
    tracks = updateTracks(tracks, bus(4.1756), START + 20_000);
    tracks = updateTracks(tracks, bus(4.17565), START + 30_000);

    expect(tracks.get('B1')!.heading).toBeCloseTo(0, 0);
  });

  it('keeps the last heading while a bus sits still, and reports it stopped', () => {
    let tracks = updateTracks(new Map(), bus(4.1755), START);
    tracks = updateTracks(tracks, bus(4.1764), START + 10_000);
    const heading = tracks.get('B1')!.heading;
    tracks = updateTracks(tracks, bus(4.1764), START + 70_000);

    const t = tracks.get('B1')!;
    expect(t.heading).toBe(heading);
    expect(isStopped(t, START + 70_000)).toBe(true);
    expect(isStopped(t, START + 20_000)).toBe(false);
  });

  it('will not guess a heading across a long reporting gap', () => {
    let tracks = updateTracks(new Map(), bus(4.1755), START);
    tracks = updateTracks(tracks, bus(4.1764), START + MAX_GAP_MS + 1);

    const t = tracks.get('B1')!;
    expect(t.heading).toBeNull();
    // But it re-anchors, so the next ordinary poll can infer one.
    tracks = updateTracks(tracks, bus(4.1773), START + MAX_GAP_MS + 11_000);
    expect(tracks.get('B1')!.heading).toBeCloseTo(0, 0);
  });

  it('rejects an impossible jump rather than reporting 400 km/h', () => {
    let tracks = updateTracks(new Map(), bus(4.1755), START);
    tracks = updateTracks(tracks, bus(4.2755), START + 10_000);

    expect(tracks.get('B1')!.speedMps).toBeNull();
  });

  it('drops buses that stop reporting and skips broken coordinates', () => {
    let tracks = updateTracks(new Map(), bus(4.1755), START);
    tracks = updateTracks(tracks, [], START + 10_000);
    expect(tracks.size).toBe(0);

    tracks = updateTracks(
      new Map(),
      [{ busCode: 'B2', plateNumber: 'X', latitude: NaN, longitude: 73.5 }],
      START,
    );
    expect(tracks.size).toBe(0);
  });

  it('formats live ages in seconds before minutes', () => {
    expect(formatAgo(0)).toBe('just now');
    expect(formatAgo(12_000)).toBe('12s ago');
    expect(formatAgo(120_000)).toBe('2 min ago');
    expect(formatAgo(7_200_000)).toBe('2 hr ago');
  });
});

describe('bus trails', () => {
  const START = 1_000_000;
  const bus = (lat: number, lng = 73.5093): LiveBus[] => [
    { busCode: 'B1', plateNumber: 'A0A0000', latitude: lat, longitude: lng },
  ];

  it('starts empty and grows only where the bus was confirmed to have been', () => {
    let tracks = updateTracks(new Map(), bus(4.1755), START);
    expect(tracks.get('B1')!.trail).toEqual([]);

    tracks = updateTracks(tracks, bus(4.1764), START + 10_000);
    tracks = updateTracks(tracks, bus(4.1773), START + 20_000);

    const trail = tracks.get('B1')!.trail;
    expect(trail.map((p) => p.lat)).toEqual([4.1755, 4.1764]);
    // Oldest first, so the drawn line ends at where the bus is now.
    expect(trail[0].at).toBeLessThan(trail[1].at);
  });

  it('leaves no smear behind a parked bus', () => {
    let tracks = updateTracks(new Map(), bus(4.1755), START);
    tracks = updateTracks(tracks, bus(4.17553), START + 10_000);
    tracks = updateTracks(tracks, bus(4.17551), START + 20_000);

    expect(tracks.get('B1')!.trail).toEqual([]);
  });

  it('restarts rather than drawing a line across an unexplained jump', () => {
    let tracks = updateTracks(new Map(), bus(4.1755), START);
    tracks = updateTracks(tracks, bus(4.1764), START + 10_000);
    expect(tracks.get('B1')!.trail).toHaveLength(1);

    tracks = updateTracks(tracks, bus(4.2764), START + 20_000);
    expect(tracks.get('B1')!.trail).toEqual([]);
  });

  it('keeps the trail short and recent', () => {
    let tracks = updateTracks(new Map(), bus(4.1755), START);
    for (let i = 1; i <= TRAIL_MAX_POINTS + 5; i++) {
      tracks = updateTracks(tracks, bus(4.1755 + i * 0.0009), START + i * 10_000);
    }
    expect(tracks.get('B1')!.trail).toHaveLength(TRAIL_MAX_POINTS);

    const later = START + TRAIL_MAX_AGE_MS + 10 * 60_000;
    tracks = updateTracks(tracks, bus(4.3), later);
    tracks = updateTracks(tracks, bus(4.3009), later + 10_000);
    expect(tracks.get('B1')!.trail).toHaveLength(1);
  });
});

describe('snapping buses onto their route', () => {
  // A straight north-south line; at this latitude 0.0001° of longitude is ~11 m.
  const line: [number, number][] = [
    [73.5, 4.17],
    [73.5, 4.19],
  ];
  const east = (meters: number) => ({ lat: 4.18, lng: 73.5 + meters / 111_320 / Math.cos((4.18 * Math.PI) / 180) });

  it('reads LineString and MultiLineString road shapes alike', () => {
    const shape = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } },
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'MultiLineString', coordinates: [line, line] },
        },
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: line[0] } },
      ],
    } as unknown as GeoJSON.FeatureCollection;

    expect(polylinesOf(shape)).toHaveLength(3);
    expect(polylinesOf(null)).toEqual([]);
  });

  it('measures the distance to the nearest point on the line', () => {
    const nearest = nearestOnPath(east(25), [line])!;
    expect(nearest.offsetM).toBeCloseTo(25, 0);
    expect(nearest.lng).toBeCloseTo(73.5, 5);
    expect(nearest.lat).toBeCloseTo(4.18, 5);
  });

  it('clamps to the end of the line rather than running off it', () => {
    const beyond = nearestOnPath({ lat: 4.2, lng: 73.5 }, [line])!;
    expect(beyond.lat).toBeCloseTo(4.19, 5);
  });

  it('puts a bus a few metres out back on the road', () => {
    const snapped = snapToRoute(east(20), [line]);
    expect(snapped.lng).toBeCloseTo(73.5, 5);
    expect(snapped.offsetM).toBeCloseTo(20, 0);
    expect(snapped.movedM).toBeCloseTo(20, 0);
  });

  it('only eases a bus that is further out, and leaves a distant one alone', () => {
    const halfway = snapToRoute(east((FULL_SNAP_M + NO_SNAP_M) / 2), [line]);
    // Half the correction applied: 80 m out, moved 40, still 40 m off the line.
    expect(halfway.movedM).toBeCloseTo(40, 0);
    expect(nearestOnPath(halfway, [line])!.offsetM).toBeCloseTo(40, 0);

    const far = east(NO_SNAP_M + 200);
    const untouched = snapToRoute(far, [line]);
    expect(untouched.movedM).toBe(0);
    expect(untouched.lng).toBe(far.lng);
  });

  it('leaves the position alone when the route has no geometry yet', () => {
    const reported = east(500);
    expect(snapToRoute(reported, [])).toMatchObject({ lat: reported.lat, lng: reported.lng, movedM: 0 });
  });
});

describe('place identity', () => {
  const here = { lat: 4.1755, lng: 73.5093 };

  it('treats every reading of "my location" as the same place', () => {
    const morning = currentLocation(here);
    const afternoon = currentLocation({ lat: 4.1801, lng: 73.5121 });
    expect(placeKey(morning)).toBe('me');
    expect(samePlace(morning, afternoon)).toBe(true);
  });

  it('keys stops by code, and everything else by rounded coordinates', () => {
    expect(placeKey(stopPlace('201'))).toBe('stop:201');
    const a: Place = { name: 'Rasfannu', lat: 4.17553, lng: 73.50931 };
    const b: Place = { name: 'Rasfannu beach', lat: 4.175531, lng: 73.509314 };
    expect(samePlace(a, b)).toBe(true);
    expect(samePlace(a, { ...a, lat: 4.19 })).toBe(false);
  });

  it('round-trips a place through the URL', () => {
    for (const place of [currentLocation(here), stopPlace('201'), { name: 'Ha, there', ...here }]) {
      const ref = parsePlaceRef(encodePlace(place))!;
      const resolved = resolvePlaceRef(ref, graph, here)!;
      expect(samePlace(resolved, place)).toBe(true);
      expect(resolved.name).toBe(place.name);
    }
  });

  it('holds a reference it cannot resolve yet instead of inventing one', () => {
    expect(resolvePlaceRef({ kind: 'current' }, graph, null)).toBeNull();
    expect(resolvePlaceRef({ kind: 'stop', code: '201' }, undefined, here)).toBeNull();
    expect(resolvePlaceRef({ kind: 'stop', code: 'nope' }, graph, here)).toBeNull();
  });

  it('ignores nonsense in the query string', () => {
    expect(parsePlaceRef(undefined)).toBeNull();
    expect(parsePlaceRef('')).toBeNull();
    expect(parsePlaceRef('stop:')).toBeNull();
    expect(parsePlaceRef('over,there')).toBeNull();
    expect(parsePlaceRef('91,73.5,Off the planet')).toBeNull();
  });
});

describe('url state', () => {
  it('reads the trip out of a shared link', () => {
    const state = readUrlState('?from=me&to=stop:201&route=133%40201%3E106&zoom=14');
    expect(state).toEqual({ from: 'me', to: 'stop:201', route: '133@201>106' });
  });

  it('carries a journey in progress, so a reload comes back to the same step', () => {
    expect(readUrlState('?from=me&to=stop:201&step=ride-1&since=720')).toEqual({
      from: 'me',
      to: 'stop:201',
      step: 'ride-1',
      since: '720',
    });
    expect(toQueryString({ to: 'stop:201', step: 'wait-1', since: '720' })).toBe(
      '?to=stop:201&step=wait-1&since=720',
    );
  });

  it('writes links a person can read', () => {
    expect(toQueryString({ from: 'me', to: 'stop:201' })).toBe('?from=me&to=stop:201');
    expect(toQueryString({ to: '4.17550,73.50930,Rasfannu' })).toBe(
      '?to=4.17550,73.50930,Rasfannu',
    );
    expect(toQueryString({})).toBe('');
  });

  it('escapes what would otherwise break the query string', () => {
    expect(toQueryString({ to: '4.1,73.5,Bru & Co' })).toBe('?to=4.1,73.5,Bru%20%26%20Co');
  });

  it('replaces the address bar, so a refresh comes back to the same trip', () => {
    writeUrlState({ from: 'me', to: 'stop:201', route: '133@201>106' });
    expect(window.location.search).toBe('?from=me&to=stop:201&route=133@201%3E106');
    expect(readUrlState(window.location.search)).toEqual({
      from: 'me',
      to: 'stop:201',
      route: '133@201>106',
    });

    writeUrlState({});
    expect(window.location.search).toBe('');
  });
});

describe('recent trips', () => {
  beforeEach(() => useRecentTrips.getState().clear());

  it('lists a repeated trip once, however far the rider has since walked', () => {
    const { record } = useRecentTrips.getState();
    record(currentLocation({ lat: 4.1755, lng: 73.5093 }), stopPlace('201'));
    record(currentLocation({ lat: 4.1901, lng: 73.5222 }), stopPlace('201'));

    expect(useRecentTrips.getState().trips).toHaveLength(1);
  });

  it('does not record a journey from a place to itself', () => {
    useRecentTrips.getState().record(stopPlace('201'), stopPlace('201'));
    expect(useRecentTrips.getState().trips).toEqual([]);
  });

  it('still keeps genuinely different trips apart', () => {
    const { record } = useRecentTrips.getState();
    record(stopPlace('201'), stopPlace('106'));
    record(stopPlace('106'), stopPlace('201'));

    expect(useRecentTrips.getState().trips).toHaveLength(2);
  });
});

describe('walking paths', () => {
  const noon = parseClock('12:00')!;

  /** A trip that starts with a walk: 300 m north of the Maafannu terminal. */
  function tripWithLeadingWalk(): Itinerary {
    const terminal = stopPlace('103');
    const from: Place = { name: 'Up the road', lat: terminal.lat + 0.0027, lng: terminal.lng };
    const results = planJourney(graph, from, stopPlace('114'), { departAt: noon });
    const trip = results.find((it) => it.legs[0]?.kind === 'walk');
    if (!trip) throw new Error('fixture no longer produces a trip that starts on foot');
    return trip;
  }

  function pathFor(leg: WalkLeg, meters: number): [string, WalkPath] {
    return [
      walkPathKey(leg.from, leg.to),
      {
        meters,
        coordinates: [
          [leg.from.lng, leg.from.lat],
          [leg.from.lng, leg.to.lat],
          [leg.to.lng, leg.to.lat],
        ],
      },
    ];
  }

  it('keys a walk by its ends, rounded so a metre of GPS drift reuses the answer', () => {
    const a = { lat: 4.1755, lng: 73.5093 };
    const b = { lat: 4.179, lng: 73.5165 };
    expect(walkPathKey(a, b)).toBe(walkPathKey({ lat: a.lat + 0.000004, lng: a.lng }, b));
    // Direction matters: the way there can differ from the way back.
    expect(walkPathKey(a, b)).not.toBe(walkPathKey(b, a));
  });

  it('measures a walk along its real path instead of the crow flies', () => {
    const trip = tripWithLeadingWalk();
    const walk = trip.legs[0] as WalkLeg;
    const routedM = walk.meters + 180;

    const walked = applyWalkPaths(trip, new Map([pathFor(walk, routedM)]));
    const after = walked.legs[0] as WalkLeg;

    expect(after.meters).toBeCloseTo(routedM, 5);
    expect(after.seconds).toBeGreaterThan(walk.seconds);
    expect(after.path).toHaveLength(3);
    expect(walked.totalWalkM).toBeCloseTo(trip.totalWalkM + 180, 5);
  });

  it('leaves earlier when the real path is longer, without moving the bus', () => {
    const trip = tripWithLeadingWalk();
    const walk = trip.legs[0] as WalkLeg;
    const bus = trip.legs.find((l): l is BusLeg => l.kind === 'bus')!;

    const walked = applyWalkPaths(trip, new Map([pathFor(walk, walk.meters + 300)]));
    const busAfter = walked.legs.find((l): l is BusLeg => l.kind === 'bus')!;

    expect(busAfter.departAt).toBe(bus.departAt);
    expect(walked.departAt).toBeLessThan(trip.departAt);
    expect(walked.arriveAt).toBe(trip.arriveAt);
  });

  it('keeps the itinerary it was given when nothing was routed', () => {
    const trip = tripWithLeadingWalk();
    expect(applyWalkPaths(trip, new Map())).toBe(trip);
    // A path for some other pair of points is not this trip's path.
    const elsewhere: Map<string, WalkPath> = new Map([
      [walkPathKey({ lat: 4.2, lng: 73.55 }, { lat: 4.21, lng: 73.56 }), { meters: 400, coordinates: [] }],
    ]);
    expect(applyWalkPaths(trip, elsewhere)).toBe(trip);
  });

  it('draws the direct line for a walk that has not been routed yet', () => {
    const trip = tripWithLeadingWalk();
    const walk = trip.legs[0] as WalkLeg;
    expect(walkLineOf(walk)).toEqual([
      [walk.from.lng, walk.from.lat],
      [walk.to.lng, walk.to.lat],
    ]);

    const walked = applyWalkPaths(trip, new Map([pathFor(walk, walk.meters)]));
    expect(walkLineOf(walked.legs[0] as WalkLeg)).toHaveLength(3);
  });

  it('leaves the itinerary it measured untouched', () => {
    // A shared link, and the lookup that re-finds this trip in the next plan,
    // both key off `itinerarySignature`, which counts the metres walked. The
    // routed copy is therefore a copy: refine the original in place and every
    // link to the trip would stop resolving to it.
    const trip = tripWithLeadingWalk();
    const walk = trip.legs[0] as WalkLeg;
    const before = itinerarySignature(trip);

    const walked = applyWalkPaths(trip, new Map([pathFor(walk, walk.meters + 250)]));

    expect(itinerarySignature(trip)).toBe(before);
    expect((trip.legs[0] as WalkLeg).path).toBeUndefined();
    expect(walked.legs[0]).not.toBe(trip.legs[0]);
    expect(walked.id).toBe(trip.id);
  });
});


describe('the ridden part of a route', () => {
  const graph = buildGraph(fixture as RouteDetailsResponse);
  const r1 = [...graph.routes.values()].find((r) => r.routeNumber === 'R1')!;
  const shape = roadShapeR1 as GeoJSON.FeatureCollection;
  const points = r1.stops.map((s) => graph.stops.get(s.stopCode)!);
  const names = r1.stops.map((s) => graph.stops.get(s.stopCode)!.name);

  it('places every stop on the geometry, in calling order', () => {
    const path = shapePath(shape)!;
    expect(path.length).toBeGreaterThan(15_000);

    const offsets = stopOffsets(path, points)!;
    expect(offsets).toHaveLength(r1.stops.length);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    }
    // One lap of the loop covers the lot; a sequence needing more than that has
    // sent the bus round twice to reach its own last stop.
    expect(offsets[offsets.length - 1] - offsets[0]).toBeLessThanOrEqual(path.length);
  });

  it('tells a stop from its twin on the opposite carriageway', () => {
    // R1 calls at Hulhumale' Cemetery on the way in and at its OPP pole on the
    // way back out. The two are metres apart, so nearest-point alone puts the
    // first one half a loop from where the bus actually passes it.
    const path = shapePath(shape)!;
    const offsets = stopOffsets(path, points)!;
    const arriving = names.indexOf("Hulhumale' Cemetery");
    const leaving = names.indexOf("Hulhumale' Cemetery OPP");

    expect(offsets[leaving] - offsets[arriving]).toBeGreaterThan(3_000);
  });

  it('cuts the loop into the stretch ridden and the stretch skipped', () => {
    const board = names.indexOf('STELCO');
    const alight = names.indexOf('Dhiraagu');
    const split = riddenShape(shape, points, board, alight)!;

    const ridden = split.features.filter((f) => f.properties?.ridden === true);
    const rest = split.features.filter((f) => f.properties?.ridden === false);
    expect(ridden).toHaveLength(1);
    expect(rest).toHaveLength(2);

    // Roughly STELCO to Dhiraagu: over the bridge and a little way into
    // Hulhumale', against a 18 km loop.
    const path = shapePath(shape)!;
    const riddenM = shapePath({ type: 'FeatureCollection', features: ridden })!.length;
    expect(riddenM).toBeGreaterThan(7_000);
    expect(riddenM).toBeLessThan(8_000);
    expect(riddenM).toBeLessThan(path.length / 2);
  });

  it('draws a ride that runs past the end of the line in two pieces', () => {
    // The geometry starts near the terminal, so the last leg back to it crosses
    // the line's own start and cannot be one slice of it.
    const board = names.indexOf("Hulhumale' Cemetery OPP");
    const alight = names.lastIndexOf('Maafannu Bus Terminal OPP');
    const split = riddenShape(shape, points, board, alight)!;

    expect(split.features.filter((f) => f.properties?.ridden === true)).toHaveLength(2);
    expect(split.features.filter((f) => f.properties?.ridden === false)).toHaveLength(1);
  });

  it('gives up rather than guessing when the ride cannot be placed', () => {
    expect(riddenShape(null, points, 0, 5)).toBeNull();
    // A stop the caller could not find, and a ride that goes nowhere.
    expect(riddenShape(shape, points, -1, 5)).toBeNull();
    expect(riddenShape(shape, points, 4, 4)).toBeNull();
    expect(riddenShape(shape, [], 0, 5)).toBeNull();
  });

  it('counts every stop called at between boarding and alighting', () => {
    const codes = r1.stops.map((s) => s.stopCode);
    expect(riddenStopCodes(codes, 2, 5)).toEqual(codes.slice(2, 6));
    expect(riddenStopCodes(codes, 3, 3)).toEqual([codes[3]]);
    expect(riddenStopCodes(codes, -1, 4)).toEqual([]);
  });
});


describe('a journey being travelled', () => {
  const noon = parseClock('12:00')!;

  /** A trip that walks to a stop, rides, and walks off — one of each kind of step. */
  function trip(): Itinerary {
    const terminal = stopPlace('103');
    const from: Place = { name: 'Up the road', lat: terminal.lat + 0.0027, lng: terminal.lng };
    const results = planJourney(graph, from, stopPlace('114'), { departAt: noon });
    const found = results.find(
      (it) => it.legs[0]?.kind === 'walk' && it.legs.some((l) => l.kind === 'bus'),
    );
    if (!found) throw new Error('fixture no longer produces a trip that starts on foot');
    return found;
  }

  /** A point `meters` due north of `of`. */
  function north(of: LatLng, meters: number): LatLng {
    return { lat: of.lat + meters / 110_540, lng: of.lng };
  }

  it('turns a bus leg into waiting for the bus and then riding it', () => {
    const steps = buildJourney(trip());
    const bus = trip().legs.findIndex((l) => l.kind === 'bus');

    expect(steps.map((s) => s.kind)).toContain('wait');
    expect(steps.filter((s) => s.kind === 'wait')).toHaveLength(1);
    expect(steps.find((s) => s.id === `wait-${bus}`)?.targetName).toBe(
      (trip().legs[bus] as BusLeg).boardStop.name,
    );
    expect(steps.find((s) => s.id === `ride-${bus}`)?.targetName).toBe(
      (trip().legs[bus] as BusLeg).alightStop.name,
    );
  });

  it('always ends by arriving, and never starts there', () => {
    const steps = buildJourney(trip());
    expect(steps[steps.length - 1].id).toBe('arrive');
    expect(steps.filter((s) => s.kind === 'arrive')).toHaveLength(1);
    expect(steps.length).toBeGreaterThan(2);
    expect(buildJourney(null)).toEqual([]);
  });

  it('completes a walk on its own, but never boards or alights for the rider', () => {
    const steps = buildJourney(trip());
    const there = { metersToTarget: 5, atTarget: true, approaching: false };

    expect(shouldAutoAdvance(steps.find((s) => s.kind === 'walk')!, there)).toBe(true);
    expect(shouldAutoAdvance(steps.find((s) => s.kind === 'wait')!, there)).toBe(false);
    expect(shouldAutoAdvance(steps.find((s) => s.kind === 'ride')!, there)).toBe(false);
  });

  it('counts a stop reached to the accuracy the fix actually claims', () => {
    const step = buildJourney(trip()).find((s) => s.kind === 'walk')!;
    const hundred = north(step.target, 100);

    expect(stepProgress(step, { ...hundred, accuracy: 5 }).atTarget).toBe(false);
    expect(stepProgress(step, { ...hundred, accuracy: 150 }).atTarget).toBe(true);
    // A wild reading does not turn the whole island into the bus stop.
    expect(arrivalRadius(9000)).toBe(120);
    expect(arrivalRadius(undefined)).toBe(ARRIVE_RADIUS_M);
  });

  it('says to get off before the stop, not as it goes past', () => {
    const ride = buildJourney(trip()).find((s) => s.kind === 'ride')!;
    const soon = stepProgress(ride, { ...north(ride.target, APPROACH_RADIUS_M - 50), accuracy: 10 });

    expect(soon.approaching).toBe(true);
    expect(soon.atTarget).toBe(false);
    expect(stepProgress(ride, { ...north(ride.target, 1000), accuracy: 10 }).approaching).toBe(
      false,
    );
  });

  it('claims nothing about where the rider is without a fix', () => {
    const step = buildJourney(trip())[0];
    expect(stepProgress(step, null)).toEqual({
      metersToTarget: null,
      atTarget: false,
      approaching: false,
    });
    expect(stepProgress(null, { lat: 4.17, lng: 73.5 })).toEqual({
      metersToTarget: null,
      atTarget: false,
      approaching: false,
    });
  });

  it('counts down the stops left as the bus works along the route', () => {
    const r1 = [...graph.routes.values()].find((r) => r.routeNumber === 'R1')!;
    const stops = r1.stops
      .slice(0, 5)
      .map((s) => graph.stops.get(s.stopCode)!)
      .map((s) => ({ lat: s.lat, lng: s.lng }));

    expect(stopsRemaining(stops, stops[0])).toBe(4);
    expect(stopsRemaining(stops, stops[3])).toBe(1);
    expect(stopsRemaining(stops, stops[4])).toBe(0);
    // Nothing to count without a fix, or with nowhere to count between.
    expect(stopsRemaining(stops, null)).toBeNull();
    expect(stopsRemaining([stops[0]], stops[0])).toBeNull();
  });

  it('believes the rider over a fix that has stopped agreeing with them', () => {
    const steps = buildJourney(trip());
    const walk = steps.find((s) => s.kind === 'walk')!;
    // Getting off a bus in Hulhumalé with a phone that last saw the sky in Malé.
    const anchor = { lat: 4.2113, lng: 73.5391 };
    const stale = { lat: 4.1755, lng: 73.5093, accuracy: 20 };

    expect(believedPosition(walk, anchor, stale)).toEqual(anchor);
    // Once it catches up, the fix is the better answer of the two.
    const caughtUp = { ...north(anchor, TRUST_M - 100), accuracy: 20 };
    expect(believedPosition(walk, anchor, caughtUp)).toEqual(caughtUp);
    // And walking the length of the step never makes the rider disbelieved.
    expect(believedPosition(walk, anchor, { ...walk.target, accuracy: 20 })?.lat).toBe(
      walk.target.lat,
    );
  });

  it('judges a fix taken mid-ride against the ride, not against its ends', () => {
    const ride = buildJourney(trip()).find((s) => s.kind === 'ride')!;
    const board = { lat: ride.bus!.boardStop.lat, lng: ride.bus!.boardStop.lng };
    const halfway = {
      lat: (board.lat + ride.target.lat) / 2,
      lng: (board.lng + ride.target.lng) / 2,
      accuracy: 20,
    };
    expect(believedPosition(ride, board, halfway)).toEqual(halfway);

    // A phone still reporting the island the rider left is not on this bus.
    const otherIsland = { lat: board.lat + 0.08, lng: board.lng + 0.08, accuracy: 20 };
    expect(believedPosition(ride, board, otherIsland)).toEqual(board);

    // With nothing reported at all, the last confirmed stop is all there is.
    expect(believedPosition(ride, board, null)).toEqual(board);
    expect(believedPosition(ride, null, null)).toBeNull();
  });

  it('measures progress by steps done, not by steps listed', () => {
    const steps = buildJourney(trip());
    expect(journeyFraction(steps, 0)).toBe(0);
    expect(journeyFraction(steps, steps.length - 1)).toBe(1);
    expect(journeyFraction(steps, 1)).toBeGreaterThan(0);
    expect(journeyFraction([], 0)).toBe(0);
  });
});
