// Tests for the polite Nominatim client: spacing, caching, aborts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNominatim } from '../src/nominatim.js';

function fakeFetch(responder = () => ({ ok: true, json: async () => ({ ok: 1 }) })) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: new URL(url), at: Date.now(), opts });
    return responder(calls.length);
  };
  return { calls, fetchImpl };
}

test('builds reverse URLs with rounding, language and polygon options', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const n = createNominatim({ fetchImpl, minIntervalMs: 0, languages: () => 'de,en' });
  await n.reverse(52.4970123, 13.4030456, { zoom: 15, polygon: true });
  const u = calls[0].url;
  assert.equal(u.origin + u.pathname, 'https://nominatim.openstreetmap.org/reverse');
  assert.equal(u.searchParams.get('lat'), '52.49701');
  assert.equal(u.searchParams.get('lon'), '13.40305');
  assert.equal(u.searchParams.get('zoom'), '15');
  assert.equal(u.searchParams.get('format'), 'jsonv2');
  assert.equal(u.searchParams.get('polygon_geojson'), '1');
  assert.equal(u.searchParams.get('accept-language'), 'de,en');
});

test('serializes requests at least minIntervalMs apart', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const n = createNominatim({ fetchImpl, minIntervalMs: 60, languages: () => 'en' });
  await Promise.all([n.reverse(1, 1), n.reverse(2, 2), n.search('x')]);
  assert.equal(calls.length, 3);
  for (let i = 1; i < calls.length; i++) {
    assert.ok(calls[i].at - calls[i - 1].at >= 55, `gap ${calls[i].at - calls[i - 1].at}ms`);
  }
});

test('caches identical requests, but not failures', async () => {
  let fail = true;
  const { calls, fetchImpl } = fakeFetch(() =>
    fail ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, json: async () => ({ ok: 1 }) },
  );
  const n = createNominatim({ fetchImpl, minIntervalMs: 0, languages: () => 'en' });
  await assert.rejects(n.reverse(1, 1), /HTTP 503/);
  fail = false;
  await n.reverse(1, 1);
  await n.reverse(1, 1);
  assert.equal(calls.length, 2);
});

test('aborted queued requests never hit the network', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const n = createNominatim({ fetchImpl, minIntervalMs: 80, languages: () => 'en' });
  const first = n.reverse(1, 1);
  const ctrl = new AbortController();
  const stale = n.reverse(2, 2, { signal: ctrl.signal });
  ctrl.abort();
  await first;
  await assert.rejects(stale, { name: 'AbortError' });
  assert.equal(calls.length, 1);
});
