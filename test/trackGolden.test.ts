import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { updateTracks, type BusTrack } from '@/lib/transit/busTracks';
import { polylinesOf, snapToRoute } from '@/lib/transit/snapToRoute';
import type { LiveBus } from '@/api/rtl';
import sequence from './fixtures/track-sequence.json';
import shapeFile from './fixtures/roadshape-r1.json';

/**
 * The contract between two implementations of the same inference.
 *
 * Bus headings, speeds and trails are computed both here and in the Go backend
 * (server/internal/track). A client that falls back from the server to calling
 * RTL directly switches between them mid-session, so if the two ever disagree a
 * bus visibly jumps on the map. Both suites assert against this one golden file,
 * so either side drifting turns into a test failure rather than a bug report.
 *
 * Regenerate deliberately, never casually — a diff here is a behaviour change:
 *   UPDATE_GOLDEN=1 npx vitest run test/trackGolden.test.ts
 */
const GOLDEN_PATH = 'test/fixtures/track-golden.json';

interface GoldenTrack {
  busCode: string;
  lat: number;
  lng: number;
  heading: number | null;
  speedMps: number | null;
  movedAt: number;
  updatedAt: number;
  firstSeenAt: number;
  anchorLat: number;
  anchorLng: number;
  anchorAt: number;
  trail: { lat: number; lng: number; at: number }[];
}

/** Rounded so JS and Go serialize identically; far finer than any real GPS. */
function round(value: number | null, places = 9): number | null {
  return value === null ? null : Number(value.toFixed(places));
}

function computeFrames() {
  const shape = (shapeFile as { roadShape?: GeoJSON.FeatureCollection }).roadShape ?? shapeFile;
  const lines = polylinesOf(shape as GeoJSON.FeatureCollection);
  expect(lines.length).toBeGreaterThan(0);

  let tracks = new Map<string, BusTrack>();
  return (sequence as { polls: { at: number; buses: LiveBus[] }[] }).polls.map((poll) => {
    // Snap before inferring, exactly as useTrackedBuses does: a position pulled
    // back onto the road is also a steadier one to take a bearing from.
    const snapped = poll.buses.map((bus) => {
      const s = snapToRoute({ lat: bus.latitude, lng: bus.longitude }, lines);
      return { ...bus, latitude: s.lat, longitude: s.lng };
    });
    tracks = updateTracks(tracks, snapped, poll.at);

    return {
      at: poll.at,
      tracks: [...tracks.values()]
        .sort((a, b) => a.busCode.localeCompare(b.busCode))
        .map(
          (t): GoldenTrack => ({
            busCode: t.busCode,
            lat: round(t.lat)!,
            lng: round(t.lng)!,
            heading: round(t.heading, 6),
            speedMps: round(t.speedMps, 6),
            movedAt: t.movedAt,
            updatedAt: t.updatedAt,
            firstSeenAt: t.firstSeenAt,
            anchorLat: round(t.anchor.lat)!,
            anchorLng: round(t.anchor.lng)!,
            anchorAt: t.anchorAt,
            trail: t.trail.map((p) => ({ lat: round(p.lat)!, lng: round(p.lng)!, at: p.at })),
          }),
        ),
    };
  });
}

describe('bus track golden fixture', () => {
  const frames = computeFrames();

  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(GOLDEN_PATH)) {
    writeFileSync(GOLDEN_PATH, JSON.stringify({ frames }));
  }

  it('matches the committed golden output', () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as { frames: typeof frames };
    expect(frames).toEqual(golden.frames);
  });

  // Guards against the fixture silently becoming trivial: if every bus sat
  // still, matching the golden output would prove nothing about the inference.
  it('exercises real movement, not just jitter', () => {
    const withHeading = frames.at(-1)!.tracks.filter((t) => t.heading !== null);
    expect(withHeading.length).toBeGreaterThan(0);

    const withTrail = frames.at(-1)!.tracks.filter((t) => t.trail.length > 1);
    expect(withTrail.length).toBeGreaterThan(0);
  });

  it('covers several buses over many polls', () => {
    expect(frames.length).toBeGreaterThan(50);
    expect(frames.at(-1)!.tracks.length).toBeGreaterThan(1);
  });
});
