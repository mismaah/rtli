import { describe, it, expect } from 'vitest';
import fixture from './fixtures/routedetails.json';
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
import { haversineMeters, bearingDegrees, compassPoint } from '@/lib/geo';
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
import { useRecentTrips } from '@/store/recentTrips';
import type { LiveBus } from '@/api/rtl';
import type { RouteDetailsResponse } from '@/api/rtl';
import type { BusLeg, Itinerary, Place } from '@/lib/transit/types';

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
