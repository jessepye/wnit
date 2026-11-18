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
  // town/village only count as "sub-city" when a city is also present
  // (e.g. Jakarta's kelurahan come back as village=Bangka, city=Jakarta).
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

// Land-use names: often subdivision plats ("Brumback's Addition") or housing
// estates. Only used when nothing better exists.
const WEAK_KEYS = new Set(['residential', 'allotments']);

const SETTLEMENT_KEYS = ['city', 'town', 'village', 'municipality', 'county'];

// Admin units and codes that are real boundaries but not what people call
// their neighborhood: NYC community boards, Indonesian RT/RW units, wards,
// numbered zones, Japanese chome blocks, names with long numbers...
const ADMIN_CODE_PATTERNS = [
  /\bcommunity (board|district)\b/i,
  /\bward\b/i,
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
  return String(name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Summarise a Nominatim `address` object.
 *
 * @returns {{
 *   neighborhood: string|null,  // best "you're in ___" answer
 *   level: string|null,         // which OSM address key it came from
 *   broader: string[],          // larger sub-city areas, local -> broad
 *   settlement: string|null,    // city / town / village
 *   region: string|null,        // state / province
 *   country: string|null,
 *   candidates: {key: string, name: string, adminCode: boolean, weak: boolean}[],
 * }}
 */
export function describePlace(address = {}) {
  const settlementKey = SETTLEMENT_KEYS.find((k) => address[k]);
  const settlement = settlementKey ? address[settlementKey] : null;
  const settlementNorm = settlement ? normalizeName(settlement) : null;

  const candidates = [];
  const seen = new Set();
  for (const key of SUBCITY_KEYS) {
    const name = address[key];
    if (!name) continue;
    if ((key === 'village' || key === 'town') && !address.city) continue;
    const norm = normalizeName(name);
    if (!norm || seen.has(norm) || norm === settlementNorm) continue;
    seen.add(norm);
    candidates.push({ key, name, adminCode: looksLikeAdminCode(name), weak: WEAK_KEYS.has(key) });
  }

  const good = candidates.filter((c) => !c.adminCode && !c.weak);
  const weak = candidates.filter((c) => !c.adminCode && c.weak);
  const codes = candidates.filter((c) => c.adminCode);
  const primary = good[0] || weak[0] || codes[0] || null;

  const region = address.state || address.region || address.province || null;
  return {
    neighborhood: primary ? primary.name : null,
    level: primary ? primary.key : null,
    broader: good.filter((c) => c !== primary).map((c) => c.name),
    settlement,
    region: region && normalizeName(region) !== settlementNorm ? region : null,
    country: address.country || null,
    candidates,
  };
}

/** "Austin, Texas, United States" (skips blanks and repeats). */
export function placeLine(place) {
  const parts = [];
  for (const p of [place.settlement, place.region, place.country]) {
    if (p && !parts.some((q) => normalizeName(q) === normalizeName(p))) parts.push(p);
  }
  return parts.join(', ');
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

const TOO_BIG = new Set([
  'city', 'town', 'village', 'municipality', 'county', 'state_district', 'state',
  'region', 'province', 'country', 'continent', 'postcode',
]);

/**
 * Given a Nominatim reverse result requested with polygon_geojson=1, return a
 * boundary worth drawing for `place` (the describePlace() of the same spot),
 * or null. The polygon must be one of the sub-city areas we are naming and
 * must actually contain the point (low-zoom reverse can return a neighbor).
 */
export function boundaryFrom(result, place, lat, lon) {
  if (!result || result.error || !result.geojson) return null;
  const { geojson, name } = result;
  if (geojson.type !== 'Polygon' && geojson.type !== 'MultiPolygon') return null;
  if (TOO_BIG.has(result.addresstype)) return null;
  if (!['boundary', 'place', 'landuse'].includes(result.category)) return null;
  if (!name) return null;
  const match = place.candidates.find((c) => normalizeName(c.name) === normalizeName(name));
  if (!match) return null;
  if (!pointInGeometry(lon, lat, geojson)) return null;
  return {
    name,
    geometry: geojson,
    isPrimary: normalizeName(name) === normalizeName(place.neighborhood || ''),
    adminCode: match.adminCode,
  };
}

/** Of the boundaries found for a spot, the one to draw: the named neighborhood, else a real name, else anything. */
export function pickBoundary(found) {
  return found.find((b) => b.isPrimary) || found.find((b) => !b.adminCode) || found[0] || null;
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
