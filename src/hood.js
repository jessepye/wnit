// Pure helpers that turn an OpenStreetMap (Nominatim) reverse-geocode result
// into an answer to "what neighborhood is this?". No DOM, no network, so they
// run unchanged in the browser, in Node tests, and later on a server/API.

// Nominatim address keys for places smaller than a city, most local first.
// (https://nominatim.org/release-docs/latest/api/Output/#addressdetails)
const SUBCITY_KEYS = [
  'neighbourhood',
  'quarter',
  'city_block',
  'hamlet',
  'croft',
  'isolated_dwelling',
  'village',
  'town',
  'suburb',
  'borough',
  'city_district',
  'district',
  'subdivision',
  'residential',
  'allotments',
];

// Small settlements only count as part of a bigger one (Jakarta's kelurahan
// come back as village=Bangka inside city=Jakarta; Miami's Latin Quarter as a
// hamlet inside the city). Out in the country, a "hamlet" in the address is
// just the nearest one, so it is treated as a settlement we may only be near.
const SETTLEMENT_LIKE = new Set(['hamlet', 'croft', 'isolated_dwelling', 'village', 'town']);
const SETTLEMENT_KEYS = ['city', 'town', 'village', 'hamlet'];

// Land-use names: often subdivision plats ("Brumback's Addition") or housing
// estates. Only used when nothing better exists.
const WEAK_KEYS = new Set(['residential', 'allotments']);

// Admin units and codes that are real boundaries but not what people call
// their neighborhood: NYC community boards, Indonesian RT/RW units, wards,
// numbered zones, Japanese chome blocks, names with long numbers...
// (Not the word "ward" by itself: Houston's Third Ward or Fifth Ward are real
// neighborhood names. Numbered wards are caught by the number rules below.)
const ADMIN_CODE_PATTERNS = [
  /\bcommunity (board|district)\b/i,
  /^(rt|rw)\.?\s*\d+/i,
  /\b(zone|sector|district|division|block|area)\s*\d+\b/i,
  /^municipio\b/i,
  /\b(census|tract|precinct|electoral|constituency|riding)\b/i,
  /\d{3,}/,
  /^\d+$/,
  /\s\d{1,3}[a-z]?$/i, // trailing block/phase numbers: "Kitazawa 2" (a chome), "Phase 2B"
  /丁目|\d+-ch[oō]me\b/i,
];

export function looksLikeAdminCode(name) {
  return ADMIN_CODE_PATTERNS.some((re) => re.test(name));
}

export function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function sameName(a, b) {
  return !!a && !!b && normalizeName(a) === normalizeName(b);
}

/** A sub-city name candidate, flagged so admin codes and land-use names lose. */
export function candidate(key, name) {
  return { key, name, adminCode: looksLikeAdminCode(name), weak: WEAK_KEYS.has(key) };
}

/** Best "you're in ___" name from candidates (most local first): real names, then land-use, then codes. */
export function rankNeighborhoods(candidates) {
  const good = candidates.filter((c) => !c.adminCode && !c.weak);
  const primary = good[0] || candidates.find((c) => !c.adminCode) || candidates[0] || null;
  return { primary, broader: good.filter((c) => c !== primary) };
}

/**
 * Summarise a Nominatim `address` object.
 *
 * @returns {{
 *   neighborhood: string|null,  // best "you're in ___" answer
 *   level: string|null,         // which OSM address key it came from
 *   broader: string[],          // larger sub-city areas, local -> broad
 *   settlement: string|null,    // city / town / village / hamlet
 *   settlementKind: string|null,
 *   county: string|null,
 *   region: string|null,        // state / province
 *   country: string|null,
 *   candidates: {key: string, name: string, adminCode: boolean, weak: boolean}[],
 * }}
 */
export function describePlace(address = {}) {
  const settlementKey = SETTLEMENT_KEYS.find((k) => address[k]) || null;
  const settlement = settlementKey ? address[settlementKey] : null;
  const urban = settlementKey === 'city' || settlementKey === 'town';

  const candidates = [];
  const seen = new Set(settlement ? [normalizeName(settlement)] : []);
  for (const key of SUBCITY_KEYS) {
    const name = address[key];
    if (!name) continue;
    if (SETTLEMENT_LIKE.has(key) && (!urban || key === settlementKey)) continue;
    const norm = normalizeName(name);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    candidates.push(candidate(key, name));
  }

  const { primary, broader } = rankNeighborhoods(candidates);
  const region = address.state || address.region || address.province || null;
  const county = address.county || address.state_district || address.municipality || null;
  return {
    neighborhood: primary ? primary.name : null,
    level: primary ? primary.key : null,
    broader: broader.map((c) => c.name),
    settlement,
    settlementKind: settlementKey,
    county: county && !sameName(county, settlement) ? county : null,
    region: region && !sameName(region, settlement) ? region : null,
    country: address.country || null,
    candidates,
  };
}

/** "Austin, Texas, United States" (skips blanks and repeats). */
export function joinPlaces(parts) {
  const out = [];
  for (const p of parts) {
    if (p && !out.some((q) => sameName(q, p))) out.push(p);
  }
  return out.join(', ');
}

export function placeLine(place) {
  return joinPlaces([place.settlement, place.region, place.country]);
}

// ---------------------------------------------------------------- geometry

/** Even-odd ray casting; works for polygons with holes and multipolygons. */
export function pointInGeometry(lon, lat, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') return pointInRings(lon, lat, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some((rings) => pointInRings(lon, lat, rings));
  return false;
}

function pointInRings(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Rough area in square degrees (outer rings only); fine for "which is smaller". */
export function roughArea(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let total = 0;
  for (const [ring] of polys) {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    total += Math.abs(a / 2);
  }
  return total;
}

/** [[west, south], [east, north]] of a Polygon/MultiPolygon. */
export function bboxOf(geometry) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const rings of polys) {
    for (const [x, y] of rings[0]) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  }
  return [[w, s], [e, n]];
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

const TOO_BIG = new Set([
  'city', 'town', 'village', 'municipality', 'county', 'state_district', 'state',
  'region', 'province', 'country', 'continent', 'postcode',
]);

/**
 * Given a Nominatim reverse result requested with polygon_geojson=1, return an
 * outline worth drawing, or null. Its name must be one of `names` (the areas
 * we are naming) and it must actually contain the point: low-zoom reverse
 * lookups can return a neighbor. `allowBig` permits city/county/state outlines.
 */
export function boundaryFrom(result, { names = [], primary = null, allowBig = false } = {}, lat, lon) {
  if (!result || result.error || !result.geojson) return null;
  const { geojson, name } = result;
  if (geojson.type !== 'Polygon' && geojson.type !== 'MultiPolygon') return null;
  if (!allowBig && TOO_BIG.has(result.addresstype)) return null;
  if (!['boundary', 'place', 'landuse'].includes(result.category)) return null;
  const match = names.find((n) => sameName(n, name));
  if (!match) return null;
  if (!pointInGeometry(lon, lat, geojson)) return null;
  return { name, geometry: geojson, isPrimary: sameName(name, primary), adminCode: looksLikeAdminCode(name) };
}

/** Of the outlines found for a spot, the one to draw: the headline itself, else a real name, else anything. */
export function pickBoundary(found) {
  return found.find((b) => b.isPrimary) || found.find((b) => !b.adminCode) || found[0] || null;
}

// ------------------------------------------------------------------- input

/** Accepts "30.3, -97.7", "30.3 -97.7" or a "#30.3,-97.7" URL hash. */
export function parseLatLon(text) {
  const m = String(text || '')
    .trim()
    .replace(/^#/, '')
    .match(/^(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)(?:\s*[, ]\s*\d+(?:\.\d+)?)?$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}
