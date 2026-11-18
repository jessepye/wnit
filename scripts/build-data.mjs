// Builds the static data files the site loads on demand (no server needed):
//
//   data/zillow/index.json + data/zillow/cells/<lat>_<lon>.json
//       Zillow's US neighborhood boundaries (2015 release, CC BY-SA 3.0),
//       simplified and split into 1°×1° grid cells so a lookup downloads
//       only the cell under the pin.
//   data/seas.json
//       IHO Sea Areas v3 (Marine Regions, CC BY 4.0), simplified, used to
//       name oceans and seas when no land source has an answer.
//
// Inputs come from npm (no extra network access needed):
//   npm pack hoods@1.2.0 oceans-seas.geojson@0.5.0 && tar xzf ... (see README)
//   node scripts/build-data.mjs <hoods>/package/data <oceans-seas>/package/oceans-seas.geo.json
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [zillowDir, seasFile] = process.argv.slice(2);
if (!zillowDir || !seasFile) {
  console.error('usage: node scripts/build-data.mjs <hoods data dir> <oceans-seas.geo.json>');
  process.exit(1);
}
const OUT = new URL('../data/', import.meta.url).pathname;

// ---------------------------------------------------------------- geometry

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

function sqSegDist(p, a, b) {
  let [x, y] = a;
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx || dy) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) [x, y] = b;
    else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

// Douglas–Peucker on one ring (iterative, keeps first/last point).
function simplifyRing(ring, tolerance) {
  if (ring.length <= 4) return ring;
  const sq = tolerance * tolerance;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxD = 0;
    let index = 0;
    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(ring[i], ring[first], ring[last]);
      if (d > maxD) {
        maxD = d;
        index = i;
      }
    }
    if (maxD > sq) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}

function cleanPolygon(rings, tolerance, digits) {
  const out = [];
  for (const ring of rings) {
    const r = simplifyRing(ring, tolerance).map(([x, y]) => [round(x, digits), round(y, digits)]);
    const dedup = r.filter((p, i) => i === 0 || p[0] !== r[i - 1][0] || p[1] !== r[i - 1][1]);
    if (dedup.length >= 4) out.push(dedup);
    else if (!out.length) return null; // outer ring collapsed: drop the polygon
  }
  return out.length ? out : null;
}

function cleanGeometry(geom, tolerance, digits) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const kept = polys.map((p) => cleanPolygon(p, tolerance, digits)).filter(Boolean);
  if (!kept.length) return null;
  return kept.length === 1 ? { type: 'Polygon', coordinates: kept[0] } : { type: 'MultiPolygon', coordinates: kept };
}

function bbox(geom) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const p of polys) {
    for (const [x, y] of p[0]) {
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    }
  }
  return [w, s, e, n];
}

// ------------------------------------------------------------------ zillow

rmSync(join(OUT, 'zillow'), { recursive: true, force: true });
mkdirSync(join(OUT, 'zillow', 'cells'), { recursive: true });

const cells = new Map();
let count = 0;
for (const file of readdirSync(zillowDir).filter((f) => f.endsWith('.json')).sort()) {
  const fc = JSON.parse(readFileSync(join(zillowDir, file), 'utf8'));
  for (const f of fc.features || fc) {
    const p = f.properties || {};
    const geometry = f.geometry && cleanGeometry(f.geometry, 0.00008, 5);
    if (!geometry || !p.NAME) continue;
    const [w, s, e, n] = bbox(geometry);
    const feature = {
      type: 'Feature',
      properties: { name: p.NAME, city: p.CITY, county: p.COUNTY, state: p.STATE, id: p.REGIONID },
      bbox: [w, s, e, n].map((v) => round(v, 5)),
      geometry,
    };
    count++;
    for (let lat = Math.floor(s); lat <= Math.floor(n); lat++) {
      for (let lon = Math.floor(w); lon <= Math.floor(e); lon++) {
        const key = `${lat}_${lon}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(feature);
      }
    }
  }
}

let bytes = 0;
const index = {};
for (const [key, features] of [...cells].sort()) {
  const body = JSON.stringify({ type: 'FeatureCollection', features });
  writeFileSync(join(OUT, 'zillow', 'cells', `${key}.json`), body);
  bytes += body.length;
  index[key] = features.length;
}
writeFileSync(
  join(OUT, 'zillow', 'index.json'),
  JSON.stringify({
    source: 'Zillow Neighborhood Boundaries (2015 release, via the "hoods" npm package)',
    license: 'CC BY-SA 3.0',
    attribution: 'Neighborhood boundaries © Zillow, CC BY-SA 3.0',
    neighborhoods: count,
    cellDegrees: 1,
    cells: index,
  }),
);
console.log(`zillow: ${count} neighborhoods in ${cells.size} cells, ${(bytes / 1e6).toFixed(1)} MB`);

// -------------------------------------------------------------------- seas

const seas = JSON.parse(readFileSync(seasFile, 'utf8'));
const seaFeatures = [];
for (const f of seas.features) {
  const geometry = cleanGeometry(f.geometry, 0.01, 3);
  if (!geometry) continue;
  seaFeatures.push({ type: 'Feature', properties: { name: f.properties.NAME }, bbox: bbox(geometry), geometry });
}
const seaBody = JSON.stringify({
  type: 'FeatureCollection',
  attribution: 'IHO Sea Areas v3, Flanders Marine Institute (2018), marineregions.org, CC BY 4.0',
  features: seaFeatures,
});
writeFileSync(join(OUT, 'seas.json'), seaBody);
console.log(`seas: ${seaFeatures.length} sea areas, ${(seaBody.length / 1e6).toFixed(2)} MB`);
