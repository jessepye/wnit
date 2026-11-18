// Polite HTTP helpers for the free public services WNIT uses.
//
// createPoliteFetcher: one request at a time, at least `minIntervalMs` apart,
// cached by URL, and queued requests whose AbortSignal fired are dropped
// (stale pin drags never hit the network).
//
// createNominatim: OpenStreetMap's Nominatim geocoder on top of that. The
// public server's usage policy (https://operations.osmfoundation.org/policies/nominatim/)
// allows user-triggered lookups at no more than 1 request/second for the whole
// app, with attribution, and no search-as-you-type. Swap `baseUrl` for a
// self-hosted Nominatim or a compatible provider (LocationIQ...) if traffic grows.

export function createPoliteFetcher({
  fetchImpl = (...args) => globalThis.fetch(...args),
  minIntervalMs = 1100,
  label = 'request',
} = {}) {
  const queue = [];
  const cache = new Map();
  let pumping = false;
  let lastStart = -Infinity;

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length) {
      const job = queue.shift();
      if (job.signal?.aborted) {
        job.reject(abortError());
        continue;
      }
      const wait = lastStart + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      if (job.signal?.aborted) {
        job.reject(abortError());
        continue;
      }
      lastStart = Date.now();
      try {
        job.resolve(await job.run());
      } catch (err) {
        job.reject(err);
      }
    }
    pumping = false;
  }

  /** GET a JSON URL (string or URL). Identical URLs share one request. */
  function getJson(url, { signal } = {}) {
    const key = String(url);
    if (cache.has(key)) return cache.get(key);
    const promise = new Promise((resolve, reject) => {
      queue.push({
        signal,
        resolve,
        reject,
        run: async () => {
          const res = await fetchImpl(key, { headers: { Accept: 'application/json' }, signal });
          if (!res.ok) throw new Error(`${label} answered HTTP ${res.status}`);
          return res.json();
        },
      });
      pump();
    });
    cache.set(key, promise);
    promise.catch(() => cache.delete(key)); // never cache failures/aborts
    return promise;
  }

  return { getJson };
}

export function createNominatim({
  baseUrl = 'https://nominatim.openstreetmap.org',
  fetchImpl,
  minIntervalMs = 1100,
  languages = defaultLanguages,
} = {}) {
  const http = createPoliteFetcher({ fetchImpl, minIntervalMs, label: 'Nominatim' });

  function request(path, params, signal) {
    const url = new URL(path, `${baseUrl.replace(/\/$/, '')}/`);
    const all = { format: 'jsonv2', ...params, 'accept-language': languages() };
    for (const [k, v] of Object.entries(all)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    return http.getJson(url, { signal });
  }

  return {
    /**
     * Reverse geocode. zoom 18 = full address; 15/14 = neighborhood-level object;
     * 10/12/13 = city/town/village; 8 = county; 5 = state. `polygon` adds its outline
     * (simplified by `threshold` degrees).
     */
    reverse(lat, lon, { zoom = 18, polygon = false, threshold = 0.0001, signal } = {}) {
      return request(
        'reverse',
        {
          lat: lat.toFixed(5),
          lon: lon.toFixed(5),
          zoom,
          addressdetails: 1,
          ...(polygon ? { polygon_geojson: 1, polygon_threshold: threshold } : {}),
        },
        signal,
      );
    },
    /** Free-text search, triggered by submit only (no autocomplete on the public server). */
    search(q, { limit = 5, viewbox, signal } = {}) {
      return request('search', { q, limit, viewbox }, signal);
    },
  };
}

export function defaultLanguages() {
  const langs = globalThis.navigator?.languages?.length ? globalThis.navigator.languages : ['en'];
  return langs.join(',');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function abortError() {
  const err = new Error('Request superseded');
  err.name = 'AbortError';
  return err;
}
