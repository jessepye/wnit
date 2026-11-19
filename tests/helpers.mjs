// Shared test helpers: answer Nominatim / Photon / Esri requests from the
// recorded responses in tests/fixtures (data © OpenStreetMap contributors,
// Esri, komoot), and serve the site's own static data files from disk.
import { readFileSync, existsSync } from 'node:fs';

const fixturePath = (name) => new URL(`./fixtures/${name}.json`, import.meta.url);
export const fixture = (name) => JSON.parse(readFileSync(fixturePath(name), 'utf8'));
const maybe = (name) => (existsSync(fixturePath(name)) ? readFileSync(fixturePath(name), 'utf8') : null);

export const AREAS = [
  { lat: 30.306, lon: -97.729, name: 'austin-hyde-park' },
  { lat: 52.497, lon: 13.403, name: 'berlin-kreuzberg' },
  { lat: 40.787, lon: -73.9754, name: 'nyc-upper-west-side' },
  { lat: 33.0198, lon: -96.6989, name: 'plano-suburb' },
  { lat: 41.9088, lon: -87.6796, name: 'chicago-wicker-park' },
  { lat: 35.4, lon: -102.3, name: 'tx-panhandle' },
  { lat: 47.6253, lon: -122.3222, name: 'seattle-capitol-hill' },
  { lat: 0, lon: -140, name: 'pacific' },
  { lat: 29.72437, lon: -95.3576, name: 'houston-third-ward' },
];

/**
 * Map tiles: the TileJSON (points at a fake "test" tileset) and the one real
 * OpenFreeMap tile we recorded (Houston's Third Ward, z14). Returns
 * {status, body} or null for URLs that aren't tiles.
 */
export function mockTile(url) {
  const u = new URL(url);
  if (u.hostname !== 'tiles.openfreemap.org') return null;
  if (u.pathname === '/planet') return { status: 200, type: 'application/json', body: readFileSync(new URL('./fixtures/tilejson.json', import.meta.url)) };
  const m = u.pathname.match(/^\/planet\/test\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
  if (!m) return null; // styles, fonts, sprites: not mocked
  const file = new URL(`./fixtures/tile-${m[1]}-${m[2]}-${m[3]}.pbf`, import.meta.url);
  return existsSync(file) ? { status: 200, type: 'application/x-protobuf', body: readFileSync(file) } : { status: 404, type: 'text/plain', body: Buffer.from('') };
}

const areaAt = (lat, lon) => AREAS.find((a) => Math.abs(a.lat - lat) < 0.02 && Math.abs(a.lon - lon) < 0.02);
const NOMINATIM_ERROR = () => maybe('reverse-atlantic-ocean');
const ESRI_ERROR = JSON.stringify({ error: { code: 400, message: 'Cannot perform query. Invalid query parameters.' } });
const EMPTY_FC = JSON.stringify({ type: 'FeatureCollection', features: [] });

/** Body (string) for a recorded third-party request, or null if it isn't one we mock. */
export function mockBody(url) {
  const u = new URL(url);
  if (u.hostname === 'nominatim.openstreetmap.org') {
    if (u.pathname === '/search') return /prinzen/i.test(u.searchParams.get('q')) ? maybe('search-prinzenstrasse-berlin') : '[]';
    const area = areaAt(Number(u.searchParams.get('lat')), Number(u.searchParams.get('lon')));
    if (!area) return NOMINATIM_ERROR();
    const zoom = u.searchParams.get('zoom');
    return maybe(zoom === '18' ? `reverse-${area.name}` : `boundary-z${zoom}-${area.name}`) || NOMINATIM_ERROR();
  }
  if (u.hostname === 'photon.komoot.io') {
    const area = areaAt(Number(u.searchParams.get('lat')), Number(u.searchParams.get('lon')));
    return (area && maybe(`photon-${area.name}`)) || EMPTY_FC;
  }
  if (u.hostname === 'geocode.arcgis.com') {
    const [lon, lat] = u.searchParams.get('location').split(',').map(Number);
    const area = areaAt(lat, lon);
    const kind = u.searchParams.get('featureTypes') === 'Locality' ? 'esri-locality' : 'esri';
    return (area && maybe(`${kind}-${area.name}`)) || ESRI_ERROR;
  }
  return null;
}

/** A fetch() for Node tests: mocked services + the repo's static files (data/...). */
export function makeFetch({ log = [] } = {}) {
  const repo = new URL('../', import.meta.url);
  const fetchImpl = async (url) => {
    const href = String(url);
    log.push(href);
    const tile = mockTile(href);
    if (tile) {
      const bytes = new Uint8Array(tile.body);
      return { ok: tile.status === 200, status: tile.status, json: async () => JSON.parse(Buffer.from(bytes).toString('utf8')), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    }
    let body = mockBody(href);
    if (body === null) {
      const path = new URL(href).pathname.replace(/^\//, '');
      const file = new URL(path, repo);
      body = existsSync(file) ? readFileSync(file, 'utf8') : null;
    }
    if (body === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  };
  return { fetchImpl, log };
}
