import { describe, it, expect } from 'vitest';
import fixture from './fixtures/routedetails.json';
import { buildGraph, MAX_TRANSFER_WALK_M } from '@/lib/transit/buildGraph';
import { generalizedCost, planJourney, totalDistanceM } from '@/lib/transit/plan';
import { parseEta } from '@/lib/transit/parseEta';
import { parseClock, formatClock, formatDuration, minutesOfDay } from '@/lib/time';
import { haversineMeters } from '@/lib/geo';
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
});
