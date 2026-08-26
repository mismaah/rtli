/**
 * End-to-end smoke check against a built app.
 *
 * Drives the real UI in a mobile viewport with geolocation pinned to Malé, then
 * pulls the network out to confirm the app still plans a trip from its cached
 * snapshot. Guards the things unit tests cannot see: the map actually sizing and
 * painting, the sheet framing the trip rather than hiding it, the wide layout
 * splitting instead of stacking, a live bus pointing the way it is travelling,
 * and a clean console.
 *
 *   npm run build && npm run preview &   # http://localhost:4173
 *   npm run e2e
 */
import { chromium } from 'playwright';

const URL = process.env.E2E_URL ?? 'http://localhost:4173/';
const failures = [];

function check(condition, message) {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
}

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  geolocation: { latitude: 4.1755, longitude: 73.5093 }, // Malé
  permissions: ['geolocation'],
});
const page = await ctx.newPage();

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 140));
});

await page.goto(URL, { waitUntil: 'networkidle', timeout: 45_000 });
await page.waitForTimeout(6000);

// The map must actually have a size — MapLibre's own CSS has collapsed it before.
const mapSize = await page.evaluate(() => {
  const el = document.querySelector('.maplibregl-map');
  return el ? { w: el.clientWidth, h: el.clientHeight } : null;
});
check(mapSize !== null && mapSize.h > 400, `map container sized (${JSON.stringify(mapSize)})`);

const tiles = await page.evaluate(
  () =>
    performance
      .getEntriesByType('resource')
      .filter((r) => r.name.includes('openfreemap') && r.name.endsWith('.pbf')).length,
);
check(tiles > 0, `basemap tiles fetched (${tiles})`);

// Plan a trip end to end.
await page.getByText('Where are you going?').click();
await page.locator('input[placeholder="Where to?"]').fill('Dhiraagu');
await page.waitForTimeout(1600);
await page.locator('button').filter({ hasText: '133 · 125 · 126' }).first().click();
await page.waitForTimeout(6000);

const results = await page.locator('body').innerText();
check(/\d+ min|\d+ hr/.test(results), 'itineraries returned');
check(/MVR/.test(results), 'fares shown');

// No option should transfer from a route straight back onto itself.
const chips = [...results.matchAll(/\bR\d{1,2}\b/g)].map((m) => m[0]);
check(!chips.some((c, i) => i > 0 && chips[i - 1] === c), 'no route-to-itself transfers');

await page.locator('button').filter({ hasText: /transfer|Direct/ }).first().click();
await page.waitForTimeout(6000);
const detail = await page.locator('body').innerText();
check(/BOARD/.test(detail) && /GET OFF/.test(detail), 'trip detail shows board and alight stops');

// Everything above ran with a network, so nothing should have logged an error.
check(
  consoleErrors.length === 0,
  `console clean${consoleErrors.length ? `: ${consoleErrors[0]}` : ''}`,
);

// Pull the network and confirm the cached snapshot still plans. The RTL fetch is
// expected to fail here — falling back to the snapshot is the behaviour under test.
await ctx.setOffline(true);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);
const offline = await page.locator('body').innerText();
check(/Offline/.test(offline), 'offline banner shown');
check(!/reach the bus service/.test(offline), 'app usable offline from cached snapshot');

const unexpected = consoleErrors.filter((e) => !/ERR_FAILED|ERR_INTERNET_DISCONNECTED/.test(e));
check(
  unexpected.length === 0,
  `no unexpected errors while offline${unexpected.length ? `: ${unexpected[0]}` : ''}`,
);

// A wide screen splits rather than stacks: map on the left, panel beside it.
const wideCtx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  geolocation: { latitude: 4.1755, longitude: 73.5093 },
  permissions: ['geolocation'],
});
const widePage = await wideCtx.newPage();
await widePage.goto(URL, { waitUntil: 'networkidle', timeout: 45_000 });
await widePage.waitForTimeout(6000);

const split = await widePage.evaluate(() => {
  const map = document.querySelector('.maplibregl-map');
  const panel = document.querySelector('aside');
  if (!map || !panel) return null;
  const m = map.getBoundingClientRect();
  const p = panel.getBoundingClientRect();
  return {
    mapWidth: Math.round(m.width),
    mapRight: Math.round(m.right),
    panelLeft: Math.round(p.left),
    panelWidth: Math.round(p.width),
  };
});
check(
  split !== null && split.panelLeft >= split.mapRight - 1 && split.mapWidth > 600,
  `wide layout splits map and panel (${JSON.stringify(split)})`,
);
await wideCtx.close();

// A live bus must point where it is going, and say what it knows when tapped.
// The feed is stubbed with a bus walking due north so the inferred heading is a
// known answer rather than whatever RTL's fleet happens to be doing.
const liveCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  geolocation: { latitude: 4.1755, longitude: 73.5093 },
  permissions: ['geolocation'],
});
const livePage = await liveCtx.newPage();
let step = 0;
// A transfer puts two routes on the map, each polling for its own buses. The
// fleet is handed to whichever asks first and the other route is left empty, so
// the same stub bus is never drawn twice in the same spot.
let fleetRoute = null;
await livePage.route('**/livecoordinates', (route) => {
  const routeCode = route.request().postDataJSON()?.routeCode ?? '';
  fleetRoute ??= routeCode;
  const busList =
    routeCode !== fleetRoute
      ? []
      : [
          {
            busCode: 'E2E-1',
            plateNumber: 'A1A1234',
            latitude: 4.1755 + step++ * 0.0009, // ~100 m north each poll
            longitude: 73.5093,
          },
          // Two more so the marker-position check below has a stack to catch: a
          // marker left in normal flow only misses its own position once it has
          // a sibling above it, so a single bus proves nothing. Parked well
          // clear of the lane E2E-1 drives up, so neither covers its button.
          { busCode: 'E2E-2', plateNumber: 'A1A5678', latitude: 4.17, longitude: 73.49 },
          { busCode: 'E2E-3', plateNumber: 'A1A9012', latitude: 4.165, longitude: 73.53 },
        ];
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ busList }),
  });
});

await livePage.goto(URL, { waitUntil: 'networkidle', timeout: 45_000 });
await livePage.waitForTimeout(6000);
await livePage.getByText('Where are you going?').click();
await livePage.locator('input[placeholder="Where to?"]').fill('Dhiraagu');
await livePage.waitForTimeout(1600);
await livePage.locator('button').filter({ hasText: '133 · 125 · 126' }).first().click();
await livePage.waitForTimeout(6000);
await livePage.locator('button').filter({ hasText: /transfer|Direct/ }).first().click();

const marker = livePage.locator('.rtl-bus').first();
await marker.waitFor({ timeout: 20_000 });
check(
  (await marker.getAttribute('data-heading')) === 'unknown',
  'a bus seen once claims no direction',
);

// A second poll gives it somewhere to have come from.
await livePage.waitForTimeout(12_000);
const rotation = await livePage
  .locator('.rtl-bus-dir')
  .first()
  .evaluate((el) => el.style.transform);
const degrees = Number(/-?[0-9.]+/.exec(rotation)?.[0]);
check(
  (await marker.getAttribute('data-heading')) === 'known' && Math.abs(degrees) < 2,
  `heading arrow points north for a northbound bus (${rotation || 'unrotated'})`,
);

await livePage.locator('.rtl-bus-body').first().click();
await livePage.waitForTimeout(800);
const info = await livePage.locator('.maplibregl-popup').innerText();
check(
  /A1A1234/.test(info) && /Heading north/.test(info) && /Updated/.test(info),
  'tapping a bus reveals plate, direction and how fresh the reading is',
);

// The popup is worthless if the sheet is sitting on top of it.
const card = await livePage.locator('.maplibregl-popup-content').boundingBox();
const sheet = await livePage.locator('div.absolute.inset-x-0.bottom-0.z-20').first().boundingBox();
check(
  card !== null && sheet !== null && card.y > 0 && card.y + card.height <= sheet.y + 1,
  `bus popup stays clear of the sheet (${Math.round(card?.y ?? -1)}..${Math.round((card?.y ?? 0) + (card?.height ?? 0))} vs ${Math.round(sheet?.y ?? -1)})`,
);

// Every bus must be drawn where MapLibre put it, at any zoom.
//
// MapLibre positions a marker by writing `transform` on an element its own
// stylesheet pins with `position: absolute`. Override that to `relative` and the
// markers fall back into normal flow, each one stacked below the last and so
// stranded a fixed number of pixels from its own coordinates — a gap that stays
// the same on screen while the map zooms, which is to say a bus that slides
// across the ground every time the zoom changes.
async function markerOffsets() {
  return livePage.evaluate(() => {
    const origin = document.querySelector('.maplibregl-canvas-container').getBoundingClientRect();
    return [...document.querySelectorAll('.rtl-bus')].map((el) => {
      const rect = el.getBoundingClientRect();
      // The inline transform is where MapLibre asked for the marker to go; the
      // -50% in front of it is what the element's own size cancels out.
      const put = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform);
      if (!put) return Infinity;
      return Math.hypot(
        rect.left + rect.width / 2 - origin.left - Number(put[1]),
        rect.top + rect.height / 2 - origin.top - Number(put[2]),
      );
    });
  });
}

const canvasBox = await livePage.locator('.maplibregl-canvas').boundingBox();
for (const notches of [-3, 6, -2]) {
  for (let i = 0; i < Math.abs(notches); i++) {
    await livePage.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 3);
    await livePage.mouse.wheel(0, Math.sign(notches) * 120);
    await livePage.waitForTimeout(60);
  }
  // Long enough for the zoom to land and for the buses' own glide to finish.
  await livePage.waitForTimeout(1500);
  const offsets = await markerOffsets();
  check(
    offsets.length >= 3 && offsets.every((d) => d < 2),
    `every bus marker sits on its own position (${offsets.map((d) => d.toFixed(1)).join(', ')}px)`,
  );
}
await liveCtx.close();

// A trip is state, not a session: the address bar carries it, so a refresh comes
// back to it and the link works on somebody else's phone. The same params are
// what let the offline reload above land where it left off.
const linkCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  geolocation: { latitude: 4.1755, longitude: 73.5093 },
  permissions: ['geolocation'],
});
const linkPage = await linkCtx.newPage();

const planTo = async (page, destination) => {
  await page.getByText('Where are you going?').click();
  await page.locator('input[placeholder="Where to?"]').fill(destination);
  await page.waitForTimeout(1600);
  await page.locator('button').filter({ hasText: '133 · 125 · 126' }).first().click();
  await page.waitForTimeout(6000);
};

await linkPage.goto(URL, { waitUntil: 'networkidle', timeout: 45_000 });
await linkPage.waitForTimeout(6000);
await planTo(linkPage, 'Dhiraagu');

// `URL` is taken by the base address above, so these read the query directly.
const query = (href) => href.split('?')[1] ?? '';
const planned = query(linkPage.url());
check(
  /(^|&)from=me(&|$)/.test(planned) && /(^|&)to=stop:/.test(planned),
  `the trip is in the address bar (${planned || 'no params'})`,
);

await linkPage.locator('button').filter({ hasText: /transfer|Direct/ }).first().click();
await linkPage.waitForTimeout(3000);
const shared = linkPage.url();
check(/(^|&)route=/.test(query(shared)), `the chosen trip is too (${query(shared) || 'no params'})`);

const guestCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  geolocation: { latitude: 4.1755, longitude: 73.5093 },
  permissions: ['geolocation'],
});
const guestPage = await guestCtx.newPage();
await guestPage.goto(shared, { waitUntil: 'networkidle', timeout: 45_000 });
await guestPage.waitForTimeout(10_000);
const guestText = await guestPage.locator('body').innerText();
check(
  /All options/.test(guestText) && /BOARD/.test(guestText) && /GET OFF/.test(guestText),
  'a shared link opens the same trip on a device that has never seen it',
);
await guestCtx.close();

// The rider is somewhere else every time they open the app, and the same journey
// used to be filed under recents once per fix.
await linkPage.goto(URL.split('?')[0], { waitUntil: 'domcontentloaded' });
await linkPage.waitForTimeout(7000);
await linkCtx.setGeolocation({ latitude: 4.1912, longitude: 73.5389 });
await planTo(linkPage, 'Dhiraagu');

await linkPage.goto(URL.split('?')[0], { waitUntil: 'domcontentloaded' });
await linkPage.waitForTimeout(7000);
const recents = await linkPage.locator('button').filter({ hasText: 'from My location' }).count();
check(recents === 1, `the same trip is listed once under recents (${recents})`);
await linkCtx.close();

// Results must follow the clock. A rider who opens the app at 13:55 and waits
// for the 14:00 bus is the ordinary case, and the plan used to be computed once
// at mount — so 14:00 came and went with the departed bus still top of the list.
// The clock is driven rather than waited on, so this costs a second, not five
// minutes, and it exercises the real timers the app schedules.
const clockCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  geolocation: { latitude: 4.1755, longitude: 73.5093 },
  permissions: ['geolocation'],
});
const clockPage = await clockCtx.newPage();
await clockPage.clock.install({ time: new Date('2026-08-26T08:55:00Z') }); // 13:55 in Malé
await clockPage.goto(URL, { waitUntil: 'networkidle', timeout: 45_000 });
await clockPage.clock.runFor(6000);
await clockPage.waitForTimeout(2000);

await clockPage.getByText('Where are you going?').click();
await clockPage.locator('input[placeholder="Where to?"]').fill('Dhiraagu');
await clockPage.clock.runFor(1600);
await clockPage.waitForTimeout(1200);
await clockPage.locator('button').filter({ hasText: '133 · 125 · 126' }).first().click();
await clockPage.clock.runFor(4000);
await clockPage.waitForTimeout(2500);

const departures = async () =>
  ((await clockPage.locator('body').innerText()).match(/\d{2}:\d{2} – \d{2}:\d{2}/g) ?? []).join();

const atFirstSight = await departures();
check(atFirstSight.length > 0, `itineraries planned at 13:55 (${atFirstSight || 'none'})`);

await clockPage.clock.runFor(60_000);
await clockPage.waitForTimeout(400);
const aMinuteLater = await departures();
check(
  aMinuteLater !== atFirstSight,
  `results follow the clock (13:55 "${atFirstSight}" -> 13:56 "${aMinuteLater}")`,
);
await clockCtx.close();

await browser.close();
console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} failed.`);
process.exit(failures.length === 0 ? 0 : 1);
