// WNIT lookup cache: a polite caching proxy for OpenStreetMap's Nominatim and
// komoot's Photon. Pure JavaScript with everything injected (store, rate
// limiter, fetch, clock), so the same code runs in AWS Lambda, in the local
// dev server, and in tests.
//
// What it does for each request:
//   1. normalizes it (whitelisted params; coordinates rounded so nearby pins
//      share an answer; languages reduced to one tag) -> cache key
//   2. returns the stored answer if it has one ("hit")
//   3. otherwise waits for this service's next free slot in a GLOBAL rate
//      limit (Nominatim: 1 request/second for the whole app, per the OSMF
//      usage policy), asks upstream once, stores the answer, returns it
//
// It never pre-fetches or scans areas: only lookups that real users made are
// cached, which is what the policy asks for ("set up a proxy and also enable
// caching"). Esri results are never routed through here (Esri forbids storing).
import { gunzipSync, gzipSync } from 'node:zlib';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const PHOTON = 'https://photon.komoot.io';

export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

// ----------------------------------------------------------- normalizing

function num(value, name, min, max) {
  const n = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(n) || n < min || n > max) {
    throw new HttpError(400, `"${name}" must be a number between ${min} and ${max}`);
  }
  return n;
}

const flag = (v) => (v === '1' || v === 'true' ? '1' : undefined);

/** "de-DE,de;q=0.9,en" -> "de". The cache would fragment on full Accept-Language lists. */
export function normalizeLanguage(value) {
  const first = String(value || '').split(',')[0].split(';')[0].trim().toLowerCase();
  const primary = first.split('-')[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : 'en';
}

/** Decimal places kept for a reverse lookup: street level ~11 m, town ~110 m, county ~1 km. */
export function coordDigits(zoom) {
  if (zoom >= 14) return 4;
  if (zoom >= 9) return 3;
  return 2;
}

export const SERVICES = {
  'nominatim/reverse': {
    limiter: 'nominatim',
    upstream: `${NOMINATIM}/reverse`,
    normalize(q) {
      const zoom = Math.round(num(q.zoom ?? 18, 'zoom', 0, 18));
      const d = coordDigits(zoom);
      const params = {
        format: 'jsonv2',
        lat: num(q.lat, 'lat', -90, 90).toFixed(d),
        lon: num(q.lon, 'lon', -180, 180).toFixed(d),
        zoom: String(zoom),
        addressdetails: flag(q.addressdetails),
        polygon_geojson: flag(q.polygon_geojson),
        'accept-language': normalizeLanguage(q['accept-language']),
      };
      if (params.polygon_geojson) {
        const t = q.polygon_threshold === undefined ? 0 : num(q.polygon_threshold, 'polygon_threshold', 0, 0.1);
        params.polygon_threshold = String(Math.round(t * 1e5) / 1e5);
      }
      return params;
    },
  },
  'nominatim/search': {
    limiter: 'nominatim',
    upstream: `${NOMINATIM}/search`,
    normalize(q) {
      const text = String(q.q || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!text) throw new HttpError(400, '"q" is required');
      if (text.length > 200) throw new HttpError(400, '"q" is too long');
      const params = {
        format: 'jsonv2',
        q: text,
        limit: String(Math.round(num(q.limit ?? 5, 'limit', 1, 10))),
        'accept-language': normalizeLanguage(q['accept-language']),
      };
      if (q.viewbox) {
        const box = String(q.viewbox).split(',').map((v) => Number(v));
        if (box.length !== 4 || box.some((v) => !Number.isFinite(v))) throw new HttpError(400, '"viewbox" must be 4 numbers');
        params.viewbox = box.map((v) => v.toFixed(2)).join(',');
      }
      return params;
    },
  },
  'photon/reverse': {
    limiter: 'photon',
    upstream: `${PHOTON}/reverse`,
    normalize(q) {
      const lang = ['en', 'de', 'fr'].includes(q.lang) ? q.lang : 'default';
      return {
        lat: num(q.lat, 'lat', -90, 90).toFixed(4),
        lon: num(q.lon, 'lon', -180, 180).toFixed(4),
        lang,
      };
    },
  },
};

/** Stable cache key: path + params in a fixed order, undefined dropped. */
export function cacheKey(path, params) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
  return `${path}?${qs}`;
}

// --------------------------------------------------------------- service

const DEFAULT_INTERVALS = { nominatim: 1100, photon: 500 };

export function createCacheService({
  store,
  limiter,
  fetchImpl = (...a) => globalThis.fetch(...a),
  userAgent = 'wnit-cache/0.3 (+https://github.com/jessepye/wnit)',
  contactEmail = '',
  cacheDays = 30,
  maxWaitMs = 10000,
  intervals = {},
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
} = {}) {
  const spacing = { ...DEFAULT_INTERVALS, ...intervals };
  const inflight = new Map(); // identical concurrent misses share one upstream request
  const recent = new Map(); // tiny per-instance memory cache (warm Lambdas skip the DB)
  const RECENT_MAX = 300;

  function remember(key, entry) {
    recent.delete(key);
    recent.set(key, entry);
    if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
  }

  async function fetchUpstream(svc, params) {
    const slot = await limiter.reserve(svc.limiter, spacing[svc.limiter], maxWaitMs);
    const wait = slot - now();
    if (wait > 0) await sleep(wait);
    const url = new URL(svc.upstream);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    if (contactEmail && svc.limiter === 'nominatim') url.searchParams.set('email', contactEmail);
    let res;
    try {
      res = await fetchImpl(url.toString(), {
        headers: { 'User-Agent': userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      throw new HttpError(502, `Upstream unreachable: ${err.message}`);
    }
    if (!res.ok) throw new HttpError(502, `Upstream answered HTTP ${res.status}`);
    const text = await res.text();
    try {
      JSON.parse(text);
    } catch {
      throw new HttpError(502, 'Upstream sent something that is not JSON');
    }
    return text;
  }

  async function lookup(path, query) {
    const svc = SERVICES[path];
    if (!svc) throw new HttpError(404, 'Unknown endpoint. Try /nominatim/reverse, /nominatim/search or /photon/reverse.');
    const params = svc.normalize(query);
    const key = cacheKey(path, params);
    const t = now();

    const mem = recent.get(key);
    if (mem && mem.expiresAt > t) return { body: mem.body, cache: 'hit' };

    const stored = await store.get(key).catch((err) => {
      log('store.get failed', err);
      return null;
    });
    if (stored && stored.expiresAt > t) {
      const body = gunzipSync(stored.body).toString('utf8');
      remember(key, { body, expiresAt: stored.expiresAt });
      return { body, cache: 'hit' };
    }

    if (!inflight.has(key)) {
      const job = (async () => {
        const body = await fetchUpstream(svc, params);
        const expiresAt = now() + cacheDays * 86400000;
        remember(key, { body, expiresAt });
        await store.put(key, gzipSync(body), expiresAt).catch((err) => log('store.put failed', err));
        return body;
      })();
      inflight.set(key, job);
      job.finally(() => inflight.delete(key)).catch(() => {});
    }
    return { body: await inflight.get(key), cache: 'miss' };
  }

  /** Transport-neutral entry point: returns {status, headers, body}. */
  async function handle(path, query) {
    try {
      const { body, cache } = await lookup(path.replace(/^\/+|\/+$/g, ''), query);
      return {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
          'X-WNIT-Cache': cache,
        },
        body,
      };
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log('unexpected error', err);
      return {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(err.headers || {}) },
        body: JSON.stringify({ error: status === 500 ? 'Internal error' : err.message }),
      };
    }
  }

  return { handle, lookup };
}

/** Adapts the service to a Lambda function URL event (payload format 2.0). */
export function lambdaAdapter(service) {
  return async function handler(event) {
    const method = event.requestContext?.http?.method || 'GET';
    if (method !== 'GET') {
      return { statusCode: 405, headers: { Allow: 'GET', 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'GET only' }) };
    }
    const path = event.rawPath || '/';
    if (path === '/' || path === '/health') {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, service: 'wnit-cache' }) };
    }
    const query = Object.fromEntries(new URLSearchParams(event.rawQueryString || ''));
    const res = await service.handle(path, query);
    return { statusCode: res.status, headers: res.headers, body: res.body };
  };
}

// ------------------------------------------------- in-memory implementations

export function memoryStore() {
  const items = new Map();
  return {
    items,
    async get(key) {
      return items.get(key) || null;
    },
    async put(key, body, expiresAt) {
      items.set(key, { body, expiresAt });
    },
  };
}

/** Hands out one slot per `intervalMs` per limiter name; refuses waits longer than maxWaitMs. */
export function memoryLimiter({ now = () => Date.now() } = {}) {
  const next = new Map();
  return {
    async reserve(name, intervalMs, maxWaitMs) {
      const t = now();
      const slot = Math.max(t, next.get(name) || 0);
      if (slot - t > maxWaitMs) throw busy(slot - t);
      next.set(name, slot + intervalMs);
      return slot;
    },
  };
}

// --------------------------------------------------- DynamoDB implementations
// `client` is a thin wrapper with get/put/update taking DocumentClient params
// (see handler.mjs), so this file needs no AWS SDK and tests can fake it.

export function dynamoStore({ client, tableName }) {
  return {
    async get(key) {
      const { Item } = await client.get({ TableName: tableName, Key: { pk: key } });
      if (!Item) return null;
      return { body: Buffer.from(Item.body), expiresAt: Item.expiresAt * 1000 };
    },
    async put(key, body, expiresAt) {
      if (body.length > 350 * 1024) return; // DynamoDB items max out at 400 KB; huge polygons just aren't cached
      await client.put({
        TableName: tableName,
        Item: { pk: key, body, expiresAt: Math.ceil(expiresAt / 1000), fetchedAt: new Date().toISOString() },
      });
    },
  };
}

/**
 * Global rate limit shared by every Lambda instance: each upstream request
 * claims the next free slot with a conditional write (optimistic locking), so
 * two instances can never get the same second.
 */
export function dynamoLimiter({ client, tableName, now = () => Date.now() }) {
  return {
    async reserve(name, intervalMs, maxWaitMs) {
      const Key = { pk: `ratelimit#${name}` };
      for (let attempt = 0; attempt < 10; attempt++) {
        const { Item } = await client.get({ TableName: tableName, Key, ConsistentRead: true });
        const prev = Item?.nextSlot ?? 0;
        const t = now();
        const slot = Math.max(t, prev);
        if (slot - t > maxWaitMs) throw busy(slot - t);
        try {
          await client.update({
            TableName: tableName,
            Key,
            UpdateExpression: 'SET nextSlot = :next, expiresAt = :exp',
            ConditionExpression: 'attribute_not_exists(nextSlot) OR nextSlot = :prev',
            ExpressionAttributeValues: { ':next': slot + intervalMs, ':prev': prev, ':exp': Math.ceil(t / 1000) + 86400 },
          });
          return slot;
        } catch (err) {
          if (err.name !== 'ConditionalCheckFailedException') throw err;
        }
      }
      throw busy(1000);
    },
  };
}

function busy(waitMs) {
  return new HttpError(503, 'Busy: too many new lookups right now. Try again in a moment.', {
    'Retry-After': String(Math.ceil(waitMs / 1000)),
  });
}
