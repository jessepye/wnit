// The lookup cache (server/src/core.mjs): normalizing, caching, the global
// rate limit, failure handling, the DynamoDB pieces (against a fake client
// that simulates races), the Lambda adapter, and the app's API config.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SERVICES,
  cacheKey,
  coordDigits,
  createCacheService,
  dynamoLimiter,
  dynamoStore,
  lambdaAdapter,
  memoryLimiter,
  memoryStore,
  normalizeLanguage,
} from '../server/src/core.mjs';
import { apiBase } from '../src/config.js';
import { mockBody } from './helpers.mjs';

function upstream(map = (url) => mockBody(url)) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: new URL(url), opts, at: Date.now() });
    const body = map(String(url));
    if (body instanceof Error) throw body;
    if (body === null) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
  return { calls, fetchImpl };
}

function setup(options = {}) {
  const { map, ...rest } = options;
  const up = upstream(map);
  const store = rest.store || memoryStore();
  const svc = createCacheService({
    store,
    limiter: memoryLimiter(),
    fetchImpl: up.fetchImpl,
    intervals: { nominatim: 40, photon: 20 },
    ...rest,
  });
  return { svc, store, ...up };
}

const REVERSE = { format: 'jsonv2', lat: '30.30601', lon: '-97.72902', zoom: '18', addressdetails: '1', 'accept-language': 'en-US,en' };
const json = (res) => JSON.parse(res.body);

// ------------------------------------------------------------- normalizing

test('normalizing: languages, coordinate rounding by zoom, whitelisted params', () => {
  assert.equal(normalizeLanguage('de-DE,de;q=0.9,en'), 'de');
  assert.equal(normalizeLanguage('en-US,en'), 'en');
  assert.equal(normalizeLanguage(''), 'en');
  assert.equal(normalizeLanguage('*'), 'en');
  assert.deepEqual([18, 15, 14, 13, 10, 9, 8, 5].map(coordDigits), [4, 4, 4, 3, 3, 3, 2, 2]);

  const reverse = SERVICES['nominatim/reverse'].normalize;
  assert.deepEqual(reverse({ ...REVERSE, foo: 'bar', email: 'x@y.z' }), {
    format: 'jsonv2', lat: '30.3060', lon: '-97.7290', zoom: '18', addressdetails: '1', polygon_geojson: undefined, 'accept-language': 'en',
  });
  const town = reverse({ lat: '33.01981', lon: '-96.69891', zoom: '10', polygon_geojson: '1', polygon_threshold: '0.0005' });
  assert.deepEqual([town.lat, town.lon, town.polygon_threshold], ['33.020', '-96.699', '0.0005']);
  assert.throws(() => reverse({ lat: 'abc', lon: '1' }), /"lat" must be a number/);
  assert.throws(() => reverse({ lat: '1', lon: '200' }), /"lon"/);

  const search = SERVICES['nominatim/search'].normalize;
  const s = search({ q: '  Prinzenstraße,   BERLIN ', viewbox: '13.36789,52.52111,13.45,52.47', limit: '5' });
  assert.deepEqual([s.q, s.viewbox], ['prinzenstraße, berlin', '13.37,52.52,13.45,52.47']);
  assert.throws(() => search({ q: '  ' }), /required/);
  assert.throws(() => search({ q: 'x', limit: '50' }), /limit/);

  const photon = SERVICES['photon/reverse'].normalize({ lat: '30.30601', lon: '-97.72902', lang: 'xx' });
  assert.deepEqual(photon, { lat: '30.3060', lon: '-97.7290', lang: 'default' });
  assert.equal(cacheKey('p', { b: '2', a: '1', c: undefined }), cacheKey('p', { a: '1', b: '2' }));
});

// ----------------------------------------------------------------- caching

test('first lookup asks upstream, repeats and nearby pins are served from the cache', async () => {
  const { svc, calls } = setup();
  const first = await svc.handle('/nominatim/reverse', REVERSE);
  assert.equal(first.status, 200);
  assert.equal(first.headers['X-WNIT-Cache'], 'miss');
  assert.equal(json(first).address.neighbourhood, 'Hyde Park');

  const again = await svc.handle('/nominatim/reverse', REVERSE);
  const nearby = await svc.handle('/nominatim/reverse', { ...REVERSE, lat: '30.30604', lon: '-97.72898' }); // ~4 m away
  assert.equal(again.headers['X-WNIT-Cache'], 'hit');
  assert.equal(nearby.headers['X-WNIT-Cache'], 'hit');
  assert.equal(calls.length, 1);

  const german = await svc.handle('/nominatim/reverse', { ...REVERSE, 'accept-language': 'de' });
  assert.equal(german.headers['X-WNIT-Cache'], 'miss', 'names differ by language, so the cache keys do too');
});

test('upstream requests are normalized, identified, and carry the optional contact email', async () => {
  const { svc, calls } = setup({ contactEmail: 'ops@example.org' });
  await svc.handle('/nominatim/reverse', REVERSE);
  await svc.handle('/photon/reverse', { lat: '30.306', lon: '-97.729', lang: 'en' });
  const [nom, photon] = calls;
  assert.equal(nom.url.origin + nom.url.pathname, 'https://nominatim.openstreetmap.org/reverse');
  assert.equal(nom.url.searchParams.get('lat'), '30.3060');
  assert.equal(nom.url.searchParams.get('accept-language'), 'en');
  assert.equal(nom.url.searchParams.get('email'), 'ops@example.org');
  assert.match(nom.opts.headers['User-Agent'], /^wnit-cache\//);
  assert.equal(photon.url.hostname, 'photon.komoot.io');
  assert.equal(photon.url.searchParams.get('email'), null, 'the email is only for Nominatim');
});

test('identical lookups at the same moment share one upstream request', async () => {
  const { svc, calls } = setup();
  const results = await Promise.all([1, 2, 3].map(() => svc.handle('/nominatim/reverse', REVERSE)));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
  assert.equal(calls.length, 1);
});

test('new lookups are spaced by the global rate limit; too long a queue answers 503', async () => {
  const { svc, calls } = setup();
  const spots = [[30.306, -97.729], [52.497, 13.403], [40.787, -73.9754]];
  await Promise.all(spots.map(([lat, lon]) => svc.handle('/nominatim/reverse', { ...REVERSE, lat, lon })));
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i].at - calls[i - 1].at >= 35, `gap ${calls[i].at - calls[i - 1].at} ms`);

  const busy = setup({ maxWaitMs: 50 });
  const res = await Promise.all([10, 11, 12, 13].map((lat) => busy.svc.handle('/nominatim/reverse', { ...REVERSE, lat })));
  assert.deepEqual(res.map((r) => r.status), [200, 200, 503, 503]);
  assert.ok(Number(res[3].headers['Retry-After']) >= 1);
  assert.match(json(res[3]).error, /Busy/);
});

test('failures are reported and never cached', async () => {
  let fail = true;
  const { svc, calls } = setup({ map: (url) => (fail ? null : mockBody(url)) });
  const bad = await svc.handle('/nominatim/reverse', REVERSE);
  assert.equal(bad.status, 502);
  assert.equal(bad.headers['Cache-Control'], 'no-store');
  fail = false;
  assert.equal((await svc.handle('/nominatim/reverse', REVERSE)).status, 200);
  assert.equal(calls.length, 2, 'retried after the failure');

  const garbage = setup({ map: () => '<html>oops</html>' });
  assert.equal((await garbage.svc.handle('/nominatim/reverse', REVERSE)).status, 502);
  const down = setup({ map: () => new Error('ECONNRESET') });
  assert.match(json(await down.svc.handle('/nominatim/reverse', REVERSE)).error, /unreachable/);

  assert.equal((await svc.handle('/esri/reverse', { lat: '1', lon: '2' })).status, 404, 'Esri is never cached');
  assert.equal((await svc.handle('/nominatim/reverse', { lat: 'x' })).status, 400);
});

test('answers expire after cacheDays; a broken store never breaks a lookup', async () => {
  let clock = Date.now();
  const store = memoryStore();
  const first = setup({ store, cacheDays: 30, now: () => clock });
  await first.svc.handle('/nominatim/reverse', REVERSE);
  clock += 31 * 86400000;
  const later = setup({ store, cacheDays: 30, now: () => clock }); // new instance: no in-memory copy
  assert.equal((await later.svc.handle('/nominatim/reverse', REVERSE)).headers['X-WNIT-Cache'], 'miss');

  const broken = { get: async () => Promise.reject(new Error('db down')), put: async () => Promise.reject(new Error('db down')) };
  const { svc } = setup({ store: broken });
  assert.equal((await svc.handle('/nominatim/reverse', REVERSE)).status, 200);
});

// ---------------------------------------------------------------- DynamoDB

/** Minimal stand-in for the DocumentClient wrapper, honoring the limiter's condition. */
function fakeDynamo() {
  const items = new Map();
  const tick = () => new Promise((r) => setImmediate(r)); // let concurrent callers interleave
  return {
    items,
    async get({ Key }) {
      await tick();
      const item = items.get(Key.pk);
      return { Item: item ? structuredClone(item) : undefined };
    },
    async put({ Item }) {
      await tick();
      items.set(Item.pk, structuredClone(Item));
    },
    async update({ Key, ExpressionAttributeValues: v, ConditionExpression }) {
      await tick();
      assert.equal(ConditionExpression, 'attribute_not_exists(nextSlot) OR nextSlot = :prev');
      const item = items.get(Key.pk);
      if (item && item.nextSlot !== undefined && item.nextSlot !== v[':prev']) {
        throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
      }
      items.set(Key.pk, { ...(item || { pk: Key.pk }), nextSlot: v[':next'], expiresAt: v[':exp'] });
    },
  };
}

test('DynamoDB store: gzipped bodies round-trip, TTL in epoch seconds, huge items skipped', async () => {
  const client = fakeDynamo();
  const svc = setup({ store: dynamoStore({ client, tableName: 't' }) }).svc;
  await svc.handle('/nominatim/reverse', REVERSE);
  const [item] = [...client.items.values()];
  assert.match(item.pk, /^nominatim\/reverse\?accept-language=en&addressdetails=1&format=jsonv2&lat=30\.3060/);
  assert.ok(item.body.length < 700, `stored ${item.body.length} bytes gzipped`);
  assert.ok(item.expiresAt > Date.now() / 1000 && item.expiresAt < Date.now() / 1000 + 31 * 86400);
  const fresh = setup({ store: dynamoStore({ client, tableName: 't' }) });
  const hit = await fresh.svc.handle('/nominatim/reverse', REVERSE);
  assert.equal(hit.headers['X-WNIT-Cache'], 'hit');
  assert.equal(json(hit).address.neighbourhood, 'Hyde Park');
  assert.equal(fresh.calls.length, 0);

  await dynamoStore({ client, tableName: 't' }).put('huge', Buffer.alloc(360 * 1024), Date.now() + 1000);
  assert.ok(!client.items.has('huge'));
});

test('DynamoDB limiter: concurrent Lambdas each get their own slot', async () => {
  const client = fakeDynamo();
  const limiter = dynamoLimiter({ client, tableName: 't' });
  const slots = await Promise.all([1, 2, 3, 4, 5].map(() => limiter.reserve('nominatim', 1000, 10000)));
  const sorted = [...slots].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i] - sorted[i - 1], 1000);
  await assert.rejects(limiter.reserve('nominatim', 1000, 2000), (err) => err.status === 503);
});

// ------------------------------------------------------------ Lambda + app

test('Lambda adapter: health check, GET only, routes to the cache', async () => {
  const handler = lambdaAdapter(setup().svc);
  const event = (method, rawPath, rawQueryString = '') => ({ rawPath, rawQueryString, requestContext: { http: { method } } });
  assert.equal((await handler(event('GET', '/health'))).statusCode, 200);
  assert.equal((await handler(event('POST', '/nominatim/reverse'))).statusCode, 405);
  const res = await handler(event('GET', '/nominatim/reverse', new URLSearchParams(REVERSE).toString()));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['X-WNIT-Cache'], 'miss');
  assert.equal((await handler(event('GET', '/nope'))).statusCode, 404);
});

test('app config: meta tag, trailing slash trimmed, ?api= override only on localhost', () => {
  const doc = (content) => ({ querySelector: () => (content === null ? null : { getAttribute: () => content }) });
  assert.equal(apiBase(doc('https://abc.lambda-url.us-east-1.on.aws/'), new URL('https://wnit.app/')), 'https://abc.lambda-url.us-east-1.on.aws');
  assert.equal(apiBase(doc(''), new URL('https://wnit.app/')), '');
  assert.equal(apiBase(doc(null), new URL('https://wnit.app/?api=https://evil.example')), '', 'no override on the real site');
  assert.equal(apiBase(doc(''), new URL('http://localhost:8000/?api=http://localhost:8787/')), 'http://localhost:8787');
});
