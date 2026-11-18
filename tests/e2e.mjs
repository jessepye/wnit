// End-to-end check in a real browser (Chromium via Playwright).
//
//   npm run e2e                 offline: Nominatim answers come from tests/fixtures,
//                               map tiles are blocked, so results are deterministic
//   npm run e2e:live            real Nominatim + OpenFreeMap (be gentle: ~15 requests)
//   node tests/e2e.mjs --live --shots out/   also save screenshots
//
// Needs Playwright once per machine:  npm i -D playwright && npx playwright install chromium
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { startServer } from '../scripts/serve.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const LIVE = process.argv.includes('--live');
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const HYDE_PARK = { latitude: 30.306, longitude: -97.729 };
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'nominatim.openstreetmap.org', 'tiles.openfreemap.org']);

// ------------------------------------------------------------ fixtures

const fx = (name) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const AREAS = [
  { lat: 30.306, lon: -97.729, name: 'austin-hyde-park' },
  { lat: 52.497, lon: 13.403, name: 'berlin-kreuzberg' },
  { lat: 40.787, lon: -73.9754, name: 'nyc-upper-west-side' },
  { lat: 33.0198, lon: -96.6989, name: 'plano-suburb' },
];

function mockNominatim(url) {
  const u = new URL(url);
  if (u.pathname === '/search') {
    return /prinzen/i.test(u.searchParams.get('q')) ? fx('search-prinzenstrasse-berlin') : '[]';
  }
  const lat = Number(u.searchParams.get('lat'));
  const lon = Number(u.searchParams.get('lon'));
  const zoom = u.searchParams.get('zoom');
  const area = AREAS.find((a) => Math.abs(a.lat - lat) < 0.02 && Math.abs(a.lon - lon) < 0.02);
  if (!area) return fx('reverse-atlantic-ocean');
  try {
    return fx(zoom === '18' ? `reverse-${area.name}` : `boundary-z${zoom}-${area.name}`);
  } catch {
    return fx('reverse-atlantic-ocean');
  }
}

// -------------------------------------------------------------- harness

const server = await startServer(0);
const BASE = `http://127.0.0.1:${server.address().port}/`;
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
    await page.route('https://nominatim.openstreetmap.org/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mockNominatim(route.request().url()) }),
    );
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

// ------------------------------------------------------------ scenarios

if (!LIVE) {
  await scenario('GPS on load -> pin + neighborhood name', { geolocation: HYDE_PARK, permissions: ['geolocation'] }, async (page) => {
    await page.goto(BASE);
    await hood(page, /^Hyde Park$/);
    assert.equal(await text(page, '#eyebrow'), "You're in");
    assert.match(await text(page, '#where'), /Austin, Texas/);
    assert.equal(new URL(page.url()).hash, '#30.30600,-97.72900');
    assert.match(await page.locator('#fix').getAttribute('href'), /map=18\/30\.30600\/-97\.72900/);
    assert.equal(await page.locator('.maplibregl-marker').count(), 1);
    await page.waitForTimeout(2500); // boundary lookups: Hyde Park is a point in OSM -> no outline
    assert.equal(await boundaryName(page), null);
  });

  await scenario('search -> pick result -> name + outline', { geolocation: HYDE_PARK, permissions: ['geolocation'] }, async (page, calls) => {
    await page.goto(BASE);
    await hood(page, 'Hyde Park');
    await page.fill('#q', 'Prinzenstraße, Berlin');
    await page.press('#q', 'Enter');
    await page.locator('#results button').first().waitFor();
    assert.equal(await page.locator('#results button').count(), 2);
    await page.locator('#results button').first().click();
    await hood(page, /^Luisenstadt$/);
    assert.match(await text(page, '#broader'), /in Kreuzberg · Friedrichshain-Kreuzberg/);
    await page.waitForFunction(() => window.wnit.boundary?.properties?.name === 'Luisenstadt', null, { timeout: 8000 });
    assert.ok(calls.some((c) => c.url.pathname === '/search' && c.url.searchParams.get('accept-language')));
  });

  await scenario('drag the pin -> new lookup', { geolocation: HYDE_PARK, permissions: ['geolocation'] }, async (page, calls) => {
    await page.goto(BASE);
    await hood(page, 'Hyde Park');
    await page.waitForTimeout(2600); // let the map settle and the outline lookups finish
    const before = new URL(page.url()).hash;
    const box = await page.locator('.maplibregl-marker').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y - 70, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction((h) => location.hash !== h, before, { timeout: 5000 });
    const [lat, lon] = new URL(page.url()).hash.slice(1).split(',').map(Number);
    await page.waitForFunction(
      ([la, lo]) => document.querySelector('#hood').textContent !== 'This spot…',
      [lat, lon],
      { timeout: 8000 },
    );
    assert.ok(calls.some((c) => c.url.pathname === '/reverse' && c.url.searchParams.get('lat') === lat.toFixed(5)));
    assert.ok(lon > HYDE_PARK.longitude, 'dragged east');
  });

  await scenario('shared link opens that spot (NYC)', {}, async (page) => {
    await page.goto(`${BASE}#40.78700,-73.97540`);
    await hood(page, /^Upper West Side$/);
    assert.equal(await text(page, '#broader'), 'in Manhattan');
  });

  await scenario('no neighborhood in OSM -> falls back to the city', {}, async (page) => {
    await page.goto(`${BASE}#33.01980,-96.69890`);
    await hood(page, /^Plano$/);
    assert.equal(await text(page, '#eyebrow'), 'No neighborhood name here');
    assert.ok(await page.locator('#actions').isVisible());
  });

  await scenario('location denied -> friendly fallback', {}, async (page) => {
    await page.goto(BASE);
    await hood(page, 'Pick a spot');
    assert.match(await text(page, '#note'), /turned off|Couldn't get your location/);
  });

  await scenario('ocean -> nothing here', {}, async (page) => {
    await page.goto(`${BASE}#0.00000,-30.00000`);
    await hood(page, 'No address here');
  });
} else {
  await scenario('LIVE: Austin via GPS', { geolocation: HYDE_PARK, permissions: ['geolocation'], deviceScaleFactor: 2 }, async (page, calls) => {
    await page.goto(BASE);
    await page.waitForFunction(() => ["You're in", 'No neighborhood name here'].includes(document.querySelector('#eyebrow').textContent), null, { timeout: 30000 });
    console.log(`     -> ${await text(page, '#hood')} | ${await text(page, '#where')}`);
    await page.waitForTimeout(4000);
    await shot(page, 'desktop-austin');
    assert.ok(calls.length <= 3, 'at most 3 Nominatim calls per lookup');
  });

  await scenario('LIVE: Berlin outline (phone)', { ...devices['iPhone 13'] }, async (page) => {
    await page.goto(`${BASE}#52.49700,13.40300`);
    await hood(page, /\S/, 30000);
    await page.waitForFunction(() => window.wnit.boundary?.type === 'Feature', null, { timeout: 15000 });
    console.log(`     -> ${await text(page, '#hood')} | outline: ${await boundaryName(page)}`);
    await page.waitForTimeout(3000);
    await shot(page, 'phone-berlin');
  });

  await scenario('LIVE: search Tokyo + dark mode (phone)', { ...devices['Pixel 7'], colorScheme: 'dark' }, async (page) => {
    await page.goto(`${BASE}#35.66100,139.66800`);
    await hood(page, /\S/, 30000);
    await page.waitForFunction(() => document.querySelector('#card').dataset.state === 'result', null, { timeout: 30000 });
    console.log(`     -> ${await text(page, '#hood')} | ${await text(page, '#broader')} | ${await text(page, '#where')}`);
    await page.waitForTimeout(3500);
    await shot(page, 'phone-tokyo-dark');
  });
}

await browser.close();
server.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
