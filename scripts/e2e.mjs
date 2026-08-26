/**
 * End-to-end smoke check against a built app.
 *
 * Drives the real UI in a mobile viewport with geolocation pinned to Malé, then
 * pulls the network out to confirm the app still plans a trip from its cached
 * snapshot. Guards the things unit tests cannot see: the map actually sizing and
 * painting, the sheet framing the trip rather than hiding it, and a clean console.
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

await browser.close();
console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} failed.`);
process.exit(failures.length === 0 ? 0 : 1);
