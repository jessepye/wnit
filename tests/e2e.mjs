// End-to-end check in a real browser (Chromium via Playwright).
//
//   npm run e2e                 offline: Nominatim / Photon / Esri answers come from
//                               tests/fixtures, map tiles are blocked -> deterministic
//   npm run e2e:live            real services (be gentle: ~25 requests in total)
//   node tests/e2e.mjs --live --shots out/   also save screenshots
//
// Needs Playwright once per machine:  npm i -D playwright && npx playwright install chromium
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { startServer } from '../scripts/serve.mjs';
import { startApiServer } from '../server/local.mjs';
import { mockBody } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const LIVE = process.argv.includes('--live');
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const HYDE_PARK = { latitude: 30.306, longitude: -97.729 };
const GPS = { geolocation: HYDE_PARK, permissions: ['geolocation'] };
const ALLOWED_HOSTS = new Set([
  '127.0.0.1',
  'nominatim.openstreetmap.org',
  'photon.komoot.io',
  'geocode.arcgis.com',
  'tiles.openfreemap.org',
]);
const MOCKED = ['https://nominatim.openstreetmap.org/**', 'https://photon.komoot.io/**', 'https://geocode.arcgis.com/**'];

// -------------------------------------------------------------- harness

const server = await startServer(0);
const BASE = `http://127.0.0.1:${server.address().port}/`;
// The lookup cache (server/), run locally; offline it answers from the same recorded fixtures.
const apiServer = await startApiServer({
  port: 0,
  intervals: { nominatim: 50, photon: 20 },
  ...(LIVE ? {} : { fetchImpl: async (url) => ({ ok: true, status: 200, text: async () => mockBody(url) }) }),
});
const API = `http://127.0.0.1:${apiServer.address().port}`;
const browser = await chromium.launch();
const failures = [];
let passed = 0;

async function scenario(name, contextOptions, fn) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...contextOptions });
  const page = await context.newPage();
  const nominatim = [];
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource|ERR_FAILED/.test(msg.text())) errors.push(`console: ${msg.text()}`);
  });
  page.on('request', (req) => {
    if (/^(blob|data):/.test(req.url())) return; // MapLibre's worker + inline images
    const host = new URL(req.url()).hostname;
    if (!ALLOWED_HOSTS.has(host)) errors.push(`unexpected third-party request: ${req.url()}`);
    if (host === 'nominatim.openstreetmap.org') nominatim.push({ url: new URL(req.url()), at: Date.now() });
  });
  if (!LIVE) {
    for (const pattern of MOCKED) {
      await page.route(pattern, (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: mockBody(route.request().url()) }),
      );
    }
    await page.route('https://tiles.openfreemap.org/**', (route) => route.abort());
  }
  try {
    await fn(page, nominatim);
    assert.deepEqual(errors, [], 'no page errors');
    for (let i = 1; i < nominatim.length; i++) {
      const gap = nominatim[i].at - nominatim[i - 1].at;
      assert.ok(gap >= 1000, `Nominatim requests spaced >= 1 s (got ${gap} ms)`);
    }
    passed++;
    console.log(`ok   ${name}  (${nominatim.length} Nominatim requests)`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL ${name}\n     ${err.message.split('\n').join('\n     ')}`);
    if (errors.length) console.log(`     page errors: ${errors.join(' | ')}`);
    await page.screenshot({ path: `e2e-failure-${name.replace(/\W+/g, '-')}.png` }).catch(() => {});
  } finally {
    await context.close();
  }
}

const hood = (page, text, timeout = 20000) => page.locator('#hood', { hasText: text }).waitFor({ timeout });
const text = (page, sel) => page.locator(sel).textContent();
const shot = async (page, name) => SHOTS && page.screenshot({ path: join(SHOTS, `${name}.png`) });
const boundaryName = (page) => page.evaluate(() => window.wnit.boundary?.properties?.name ?? null);
const waitBoundary = (page, name, timeout = 8000) =>
  page.waitForFunction((n) => window.wnit.boundary?.properties?.name === n, name, { timeout });
const says = (page, id) => page.locator(`.src-says[data-for="${id}"]`);
async function allSourcesAnswered(page, timeout = 15000) {
  await page.waitForFunction(() => !document.querySelector('.src-says.pending'), null, { timeout });
}

// ------------------------------------------------------------ scenarios

if (!LIVE) {
  await scenario('GPS on load -> pin, neighborhood name and outline', GPS, async (page) => {
    await page.goto(BASE);
    await hood(page, /^Hyde Park$/);
    assert.equal(await text(page, '#eyebrow'), "You're in");
    assert.equal(await text(page, '#tag'), 'neighborhood');
    assert.match(await text(page, '#where'), /Austin, Texas/);
    assert.equal(new URL(page.url()).hash, '#30.30600,-97.72900');
    assert.match(await page.locator('#fix').getAttribute('href'), /map=18\/30\.30600\/-97\.72900/);
    assert.equal(await page.locator('.maplibregl-marker').count(), 1);
    await waitBoundary(page, 'Hyde Park'); // OSM only has a point; Zillow's boundary fills in
    assert.equal(await page.evaluate(() => window.wnit.boundary.properties.from), 'zillow');
  });

  await scenario('search -> pick result -> name + OSM outline', GPS, async (page, calls) => {
    await page.goto(BASE);
    await hood(page, 'Hyde Park');
    await page.fill('#q', 'Prinzenstraße, Berlin');
    await page.press('#q', 'Enter');
    await page.locator('#results button').first().waitFor();
    assert.equal(await page.locator('#results button').count(), 2);
    await page.locator('#results button').first().click();
    await hood(page, /^Luisenstadt$/);
    assert.match(await text(page, '#broader'), /in Kreuzberg · Friedrichshain-Kreuzberg/);
    await waitBoundary(page, 'Luisenstadt');
    assert.ok(calls.some((c) => c.url.pathname === '/search' && c.url.searchParams.get('accept-language')));
  });

  await scenario('drag the pin -> new lookup', GPS, async (page, calls) => {
    await page.goto(BASE);
    await hood(page, 'Hyde Park');
    await page.waitForTimeout(2600); // let the map settle
    const before = new URL(page.url()).hash;
    const box = await page.locator('.maplibregl-marker').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y - 70, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction((h) => location.hash !== h, before, { timeout: 5000 });
    const [lat, lon] = new URL(page.url()).hash.slice(1).split(',').map(Number);
    await page.waitForFunction(() => document.querySelector('#hood').textContent !== 'This spot…', null, { timeout: 8000 });
    assert.ok(calls.some((c) => c.url.pathname === '/reverse' && c.url.searchParams.get('lat') === lat.toFixed(5)));
    assert.ok(lon > HYDE_PARK.longitude, 'dragged east');
  });

  await scenario('shared link opens that spot (NYC)', {}, async (page) => {
    await page.goto(`${BASE}#40.78700,-73.97540`);
    await hood(page, /^Upper West Side$/);
    assert.equal(await text(page, '#broader'), 'in Manhattan');
  });

  await scenario('no neighborhood -> the city you are in, outlined', {}, async (page) => {
    await page.goto(`${BASE}#33.01980,-96.69890`);
    await hood(page, /^Plano$/);
    assert.equal(await text(page, '#tag'), 'city');
    assert.equal(await text(page, '#where'), 'Collin County, Texas, United States');
    await waitBoundary(page, 'Plano');
  });

  await scenario('Texas panhandle ranchland -> the county, near the ghost town', {}, async (page) => {
    await page.goto(`${BASE}#35.40000,-102.30000`);
    await hood(page, /^Oldham County$/);
    assert.equal(await text(page, '#tag'), 'county');
    assert.equal(await text(page, '#where'), 'near Tascosa · Texas, United States');
    await waitBoundary(page, 'Oldham County');
  });

  await scenario('ocean -> the sea area name', {}, async (page) => {
    await page.goto(`${BASE}#0.00000,-30.00000`);
    await hood(page, /Atlantic Ocean$/);
    assert.equal(await text(page, '#tag'), 'ocean');
  });

  await scenario('location denied -> friendly fallback', {}, async (page) => {
    await page.goto(BASE);
    await hood(page, 'Pick a spot');
    assert.match(await text(page, '#note'), /turned off|Couldn't get your location/);
  });

  await scenario('"?" explains the answer and compares every source', GPS, async (page) => {
    await page.goto(BASE);
    await hood(page, 'Hyde Park');
    await waitBoundary(page, 'Hyde Park');
    await page.click('#why');
    await page.locator('#about[open]').waitFor();
    assert.equal(await text(page, '#about-title'), '“Hyde Park”');
    assert.match(await text(page, '#about-why'), /agree/);
    assert.equal(await page.locator('.src').count(), 5);
    await allSourcesAnswered(page);
    for (const id of ['auto', 'osm', 'photon', 'zillow', 'esri']) assert.match(await says(page, id).textContent(), /^Hyde Park/, id);
    const levels = await page.locator('#levels li').allTextContents();
    assert.ok(levels.some((l) => /county\s*Travis County/i.test(l)), levels.join(' / '));

    await page.locator('.src', { hasText: 'Esri World Geocoder' }).click();
    await page.waitForFunction(() => window.wnit.source === 'esri');
    assert.equal(new URL(page.url()).searchParams.get('source'), 'esri');
    await page.keyboard.press('Escape');
    await page.locator('#about[open]').waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
    assert.equal(await page.locator('#about').evaluate((d) => d.open), false);
    assert.equal(await text(page, '#via'), 'Source: Esri World Geocoder');
    await hood(page, /^Hyde Park$/);
    await waitBoundary(page, 'Hyde Park'); // borrowed from Zillow: Esri has no shapes
  });

  await scenario('sources disagree in Seattle; Zillow-only is honest abroad', {}, async (page) => {
    await page.goto(`${BASE}#47.62530,-122.32220`);
    await hood(page, /^Capitol Hill$/);
    await page.click('#why');
    await allSourcesAnswered(page);
    assert.match(await text(page, '#about-why'), /guesses “Madison Valley”, but Zillow/);
    assert.match(await says(page, 'osm').textContent(), /^Madison Valley/);
    assert.match(await says(page, 'esri').textContent(), /^Broadway/);
    await page.locator('.src', { hasText: 'Zillow neighborhoods' }).click();
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.wnit.go({ lat: 52.497, lon: 13.403 }));
    await hood(page, /Not in Zillow/);
    assert.match(await text(page, '#note'), /151 US cities/);
  });

  await scenario('source choice survives a reload', {}, async (page) => {
    await page.goto(`${BASE}?source=photon#30.30600,-97.72900`);
    await hood(page, /^Hyde Park$/);
    assert.equal(await text(page, '#via'), 'Source: OpenStreetMap · Photon');
  });

  await scenario('with the lookup cache: no direct OSM calls, and a reload is served from cache', {}, async (page, direct) => {
    const viaApi = [];
    page.on('response', (res) => {
      if (res.url().startsWith(API)) viaApi.push(res.headers()['x-wnit-cache']);
    });
    await page.goto(`${BASE}?api=${encodeURIComponent(API)}#35.40000,-102.30000`);
    await hood(page, /^Oldham County$/);
    await waitBoundary(page, 'Oldham County');
    assert.ok(viaApi.length >= 2, `lookups went through the cache API (${viaApi.length})`);
    assert.ok(viaApi.every((h) => h === 'miss'), 'first visit: all misses');
    assert.equal(direct.length, 0, 'no direct calls to nominatim.openstreetmap.org');
    viaApi.length = 0;
    await page.reload();
    await hood(page, /^Oldham County$/);
    await waitBoundary(page, 'Oldham County');
    assert.ok(viaApi.length >= 2 && viaApi.every((h) => h === 'hit'), `reload served from cache: ${viaApi.join(',')}`);
  });
} else {
  await scenario('LIVE: Austin via GPS + compare sources', { ...GPS, deviceScaleFactor: 2 }, async (page) => {
    await page.goto(BASE);
    await page.waitForFunction(() => document.querySelector('#card').dataset.state === 'result', null, { timeout: 30000 });
    console.log(`     -> ${await text(page, '#hood')} | ${await text(page, '#where')}`);
    await page.waitForTimeout(3000);
    await shot(page, 'desktop-austin');
    await page.click('#why');
    await allSourcesAnswered(page, 30000);
    for (const id of ['auto', 'osm', 'photon', 'zillow', 'esri']) console.log(`     ${id.padEnd(6)} says: ${(await says(page, id).textContent()).trim()}`);
    await shot(page, 'desktop-austin-why');
  });

  await scenario('LIVE: Texas panhandle (phone)', { ...devices['iPhone 13'] }, async (page) => {
    await page.goto(`${BASE}#35.40000,-102.30000`);
    await page.waitForFunction(() => document.querySelector('#card').dataset.state === 'result', null, { timeout: 30000 });
    await page.waitForFunction(() => window.wnit.boundary?.type === 'Feature', null, { timeout: 15000 }).catch(() => {});
    console.log(`     -> ${await text(page, '#tag')}: ${await text(page, '#hood')} | ${await text(page, '#where')} | outline: ${await boundaryName(page)}`);
    await page.waitForTimeout(3000);
    await shot(page, 'phone-panhandle');
  });

  await scenario('LIVE: middle of the Pacific (phone, dark)', { ...devices['Pixel 7'], colorScheme: 'dark' }, async (page) => {
    await page.goto(`${BASE}#5.00000,-140.00000`);
    await page.waitForFunction(() => document.querySelector('#card').dataset.state === 'result', null, { timeout: 30000 });
    console.log(`     -> ${await text(page, '#tag')}: ${await text(page, '#hood')}`);
    await page.waitForTimeout(2500);
    await shot(page, 'phone-pacific-dark');
  });

  await scenario('LIVE: Seattle sources disagree (phone)', { ...devices['iPhone 13'] }, async (page) => {
    await page.goto(`${BASE}#47.62530,-122.32220`);
    await page.waitForFunction(() => document.querySelector('#card').dataset.state === 'result', null, { timeout: 30000 });
    await page.click('#why');
    await allSourcesAnswered(page, 30000);
    for (const id of ['auto', 'osm', 'photon', 'zillow', 'esri']) console.log(`     ${id.padEnd(6)} says: ${(await says(page, id).textContent()).trim()}`);
    await page.waitForTimeout(500);
    await shot(page, 'phone-seattle-why');
  });
}

await browser.close();
server.close();
apiServer.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
