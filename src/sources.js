// Data sources. Each one turns its own API's answer into the shared Report
// shape (see answer.js), so the app can show, compare and switch between them.
//
//   auto    OpenStreetMap everywhere + Zillow's US boundaries + IHO sea names
//   osm     OpenStreetMap via the public Nominatim server (names + outlines)
//   photon  OpenStreetMap via komoot's Photon (different lookup logic)
//   zillow  Zillow's 2015 US neighborhood boundaries, bundled as static files
//   esri    Esri's World Geocoder, used without a key (experimental)
import { emptyReport } from './answer.js';
import {
  boundaryFrom,
  candidate,
  describePlace,
  distanceKm,
  looksLikeAdminCode,
  pickBoundary,
  pointInGeometry,
  roughArea,
  sameName,
} from './hood.js';
import { pickLabels } from './labels.js';
import { createPoliteFetcher, defaultLanguages } from './nominatim.js';

export const SOURCE_IDS = ['auto', 'labels', 'osm', 'photon', 'zillow', 'esri'];

export const SOURCE_INFO = {
  auto: {
    label: 'Best guess',
    blurb: "The map's own labels, outlined with OpenStreetMap or Zillow boundaries, falling back to towns, counties and sea names.",
  },
  labels: {
    label: 'Map labels (OpenStreetMap)',
    blurb: 'The neighborhood names printed on this map, nearest to your pin. Points, so no outlines of their own.',
  },
  osm: {
    label: 'OpenStreetMap · Nominatim',
    blurb: 'The volunteer-made world map. Outlines wherever mappers drew them.',
    href: 'https://nominatim.org/',
  },
  photon: {
    label: 'OpenStreetMap · Photon',
    blurb: 'Same map data, different lookup logic (by komoot). No outlines.',
    href: 'https://photon.komoot.io/',
  },
  zillow: {
    label: 'Zillow neighborhoods (US, 2015)',
    blurb: '6,957 neighborhood boundaries in 151 US cities, shipped with this site.',
    href: 'https://github.com/zeke/hoods',
  },
  esri: {
    label: 'Esri World Geocoder',
    blurb: 'Commercial map data, used without a key. Experimental; no outlines.',
    href: 'https://developers.arcgis.com/rest/geocode/',
  },
};

const SETTLEMENT_ZOOM = { city: 10, town: 12, village: 13, hamlet: 14 };
const SETTLEMENT_RADIUS_KM = { city: 5, town: 2.5, village: 1.5, hamlet: 0.8 };
const WATER_TYPES = new Set(['bay', 'strait', 'water', 'sea', 'ocean', 'lagoon', 'fjord', 'sound']);

// ----------------------------------------------------------- OpenStreetMap

export function createOsmSource(nominatim) {
  return {
    id: 'osm',
    async lookup(lat, lon, { signal } = {}) {
      const res = await nominatim.reverse(lat, lon, { signal });
      if (!res || res.error || !res.address) return emptyReport('osm');
      const p = describePlace(res.address);
      const report = emptyReport('osm', {
        neighborhoods: p.candidates,
        settlement: p.settlement ? { name: p.settlement, kind: p.settlementKind } : null,
        settlementStatus: p.candidates.length ? 'in' : 'unknown',
        county: p.county,
        region: p.region,
        country: p.country,
        countryCode: res.address.country_code || null,
        water: res.category === 'natural' && WATER_TYPES.has(res.type) ? res.name || null : null,
        osm: res.osm_type ? { type: res.osm_type, id: res.osm_id } : null,
      });
      // No neighborhood: are we actually inside the town, or only near it?
      // One lookup at the town's zoom level answers that, and its polygon
      // (the town, or else the county around us) doubles as the outline.
      if (!p.candidates.length && report.settlement) {
        const kind = report.settlement.kind;
        let r;
        try {
          r = await nominatim.reverse(lat, lon, { zoom: SETTLEMENT_ZOOM[kind] || 12, polygon: true, threshold: 0.0005, signal });
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          return report; // couldn't check; settlementStatus stays 'unknown'
        }
        const geom = r?.geojson;
        const polygonal = geom && /Polygon$/.test(geom.type) && pointInGeometry(lon, lat, geom);
        if (sameName(r?.name, report.settlement.name) && polygonal) {
          report.settlementStatus = 'in';
          report.outline = { name: r.name, geometry: geom, from: 'osm' };
        } else if (sameName(r?.name, report.settlement.name) && geom?.type === 'Point') {
          const d = distanceKm(lat, lon, Number(r.lat), Number(r.lon));
          report.settlementStatus = d <= (SETTLEMENT_RADIUS_KM[kind] || 2) ? 'in' : 'near';
        } else {
          report.settlementStatus = 'near';
          if (polygonal && sameName(r?.name, report.county)) report.outline = { name: r.name, geometry: geom, from: 'osm' };
        }
      }
      return report;
    },
  };
}

// ------------------------------------------------------------------ Photon

export function createPhotonSource({ baseUrl = 'https://photon.komoot.io', fetchImpl, languages = defaultLanguages } = {}) {
  const http = createPoliteFetcher({ fetchImpl, minIntervalMs: 500, label: 'Photon' });
  return {
    id: 'photon',
    async lookup(lat, lon, { signal } = {}) {
      const lang = languages().split(',')[0].slice(0, 2).toLowerCase();
      const url = new URL('reverse', baseUrl.replace(/\/?$/, '/'));
      url.searchParams.set('lat', lat.toFixed(5));
      url.searchParams.set('lon', lon.toFixed(5));
      url.searchParams.set('lang', ['en', 'de', 'fr'].includes(lang) ? lang : 'default');
      const res = await http.getJson(url, { signal });
      const p = res?.features?.[0]?.properties;
      if (!p) return emptyReport('photon', { note: 'Photon has no address near this spot.' });
      const names = [];
      if (p.osm_key === 'place' && ['neighbourhood', 'quarter', 'suburb'].includes(p.osm_value)) names.push(['neighbourhood', p.name]);
      names.push(['locality', p.locality], ['district', p.district]);
      const seen = new Set();
      const neighborhoods = names
        .filter(([, n]) => n && !sameName(n, p.city) && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()))
        .map(([k, n]) => candidate(k, n));
      const cc = (p.countrycode || '').toLowerCase() || null;
      const county = p.county ? (cc === 'us' && !/county|parish|borough/i.test(p.county) ? `${p.county} County` : p.county) : null;
      return emptyReport('photon', {
        neighborhoods,
        settlement: p.city ? { name: p.city, kind: 'city' } : null,
        settlementStatus: neighborhoods.length ? 'in' : 'unknown',
        county,
        region: p.state || null,
        country: p.country || null,
        countryCode: cc,
        water: p.osm_key === 'natural' && WATER_TYPES.has(p.osm_value) ? p.name || null : null,
      });
    },
  };
}

// -------------------------------------------------------------------- Esri

const ESRI_WATER = /^(Ocean|Sea|Gulf|Bay|Lake|Strait|Channel|Sound|Reservoir|Lagoon|Fjord|Inlet|Estuary)$/;
const ESRI_CONTAINED = new Set(['Neighborhood', 'City', 'Block', 'Sector', 'District', 'Village', 'Town']);

export function createEsriSource({
  baseUrl = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode',
  fetchImpl,
  languages = defaultLanguages,
} = {}) {
  const http = createPoliteFetcher({ fetchImpl, minIntervalMs: 300, label: 'Esri' });
  const call = (lat, lon, featureTypes, signal) => {
    const url = new URL(baseUrl);
    url.searchParams.set('location', `${lon.toFixed(5)},${lat.toFixed(5)}`);
    url.searchParams.set('f', 'json');
    url.searchParams.set('langCode', languages().split(',')[0].slice(0, 2));
    if (featureTypes) url.searchParams.set('featureTypes', featureTypes);
    return http.getJson(url, { signal });
  };
  return {
    id: 'esri',
    async lookup(lat, lon, { signal } = {}) {
      const [full, locality] = await Promise.all([call(lat, lon, '', signal), call(lat, lon, 'Locality', signal)]);
      const a = full?.address;
      if (!a) return emptyReport('esri', { note: "Esri's geocoder has nothing for this spot." });
      const l = locality?.address || {};
      const seen = new Set();
      const neighborhoods = [
        ['neighborhood', l.Type === 'Neighborhood' ? l.Neighborhood : a.Neighborhood],
        ['district', a.District],
      ]
        .filter(([, n]) => n && !sameName(n, a.City) && !seen.has(n) && seen.add(n))
        .map(([k, n]) => candidate(k, n));
      const water = ESRI_WATER.test(a.Type || '') ? a.PlaceName || null : null;
      return emptyReport('esri', {
        neighborhoods,
        settlement: a.City ? { name: a.City, kind: 'city' } : null,
        // The "Locality" lookup returns the smallest area containing the pin:
        // if that's a county or state, the City field is only the postal town.
        settlementStatus: ESRI_CONTAINED.has(l.Type) ? 'in' : l.Type ? 'near' : 'unknown',
        county: a.Subregion && !sameName(a.Subregion, a.City) ? a.Subregion : null,
        region: a.Region && !sameName(a.Region, a.City) ? a.Region : null,
        country: a.CntryName || null,
        countryCode: a.CountryCode === 'USA' ? 'us' : null, // Esri uses 3-letter codes; we only need "is it the US?"
        water,
      });
    },
  };
}

// ------------------------------------------------------------------ Zillow

const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico',
};

/** Zillow quirks: "Atlanta-Inman Park" -> "Inman Park"; "New York City-Manhattan" -> city + borough. */
export function cleanZillow({ name, city, county, state }) {
  let borough = null;
  let cityName = city;
  const nyc = /^New York City-(.+)$/.exec(city || '');
  if (nyc) {
    cityName = 'New York';
    borough = nyc[1];
  }
  const prefix = `${cityName}-`;
  const hood = name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name;
  let countyName = county || null;
  if (countyName && !/county|parish|borough|city$/i.test(countyName)) {
    countyName += state === 'LA' ? ' Parish' : state === 'AK' ? ' Borough' : ' County';
  }
  return { hood, borough, city: cityName, county: countyName, region: US_STATES[state] || state || null };
}

export function createZillowSource({ baseUrl = 'data/zillow/', fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  let index = null;
  const cells = new Map();
  const getJson = async (path) => {
    const res = await fetchImpl(new URL(path, new URL(baseUrl, globalThis.location?.href || 'http://localhost/')).toString());
    if (!res.ok) throw new Error(`Zillow data HTTP ${res.status}`);
    return res.json();
  };
  const outside = () =>
    emptyReport('zillow', { note: "Zillow's data only covers neighborhoods in 151 US cities, and this spot isn't in one." });

  return {
    id: 'zillow',
    async lookup(lat, lon) {
      index ||= getJson('index.json').catch((err) => {
        index = null;
        throw err;
      });
      const key = `${Math.floor(lat)}_${Math.floor(lon)}`;
      if (!(await index).cells[key]) return outside();
      if (!cells.has(key)) cells.set(key, getJson(`cells/${key}.json`).catch((err) => (cells.delete(key), Promise.reject(err))));
      const { features } = await cells.get(key);
      const hits = features
        .filter((f) => lon >= f.bbox[0] && lon <= f.bbox[2] && lat >= f.bbox[1] && lat <= f.bbox[3])
        .filter((f) => pointInGeometry(lon, lat, f.geometry))
        .sort((a, b) => roughArea(a.geometry) - roughArea(b.geometry)); // most specific first
      if (!hits.length) return outside();
      const z = cleanZillow(hits[0].properties);
      const neighborhoods = [z.hood, ...hits.slice(1).map((h) => cleanZillow(h.properties).hood), z.borough]
        .filter(Boolean)
        .filter((n, i, all) => all.findIndex((m) => sameName(m, n)) === i)
        .map((n) => candidate('neighborhood', n));
      return emptyReport('zillow', {
        neighborhoods,
        settlement: { name: z.city, kind: 'city' },
        settlementStatus: 'in',
        county: z.county,
        region: z.region,
        country: 'United States',
        countryCode: 'us',
        outline: { name: z.hood, geometry: hits[0].geometry, from: 'zillow' },
      });
    },
  };
}

// -------------------------------------------------------------- Map labels

/** The basemap's own neighborhood labels, with OSM's address lookup for town/county/state. */
export function createLabelsSource({ osm, labels }) {
  return {
    id: 'labels',
    async lookup(lat, lon, { signal } = {}) {
      const [o, ranked] = await Promise.all([osm.lookup(lat, lon, { signal }), labels.nearby(lat, lon)]);
      const { primary, broader } = pickLabels(ranked);
      if (!primary) return { ...o, source: 'labels', neighborhoods: [], note: 'The map has no neighborhood labels near this spot.' };
      return {
        ...o,
        source: 'labels',
        neighborhoods: [primary, ...broader].map((p) => candidate(p.cls, p.name)),
        settlementStatus: 'in',
        label: primary,
      };
    },
  };
}

// --------------------------------------------------------------- Best guess

/**
 * The names people actually use: the map label nearest the pin wins. Outlines
 * come from Zillow or OpenStreetMap boundaries with the same name. Without a
 * label nearby (tiles unavailable, countryside), OpenStreetMap's address
 * lookup decides, with Zillow's drawn boundaries breaking ties in US cities.
 */
export function createAutoSource({ osm, zillow, labels = null }) {
  return {
    id: 'auto',
    async lookup(lat, lon, { signal } = {}) {
      const [o, z, ranked] = await Promise.all([
        osm.lookup(lat, lon, { signal }),
        zillow.lookup(lat, lon).catch(() => null),
        labels ? labels.nearby(lat, lon).catch(() => null) : null,
      ]);
      const report = { ...o, source: 'auto' };
      const zHood = z?.neighborhoods?.[0]?.name || null;
      const osmPrimary = o.neighborhoods.find((n) => !n.adminCode && !n.weak)?.name || null;

      const { primary, broader } = pickLabels(ranked || []);
      if (primary) {
        return {
          ...report,
          neighborhoods: [primary, ...broader].map((p) => candidate(p.cls, p.name)),
          settlement: o.settlement || z?.settlement || null,
          settlementStatus: 'in',
          county: o.county || z?.county || null,
          region: o.region || z?.region || null,
          country: o.country || z?.country || null,
          countryCode: o.countryCode || (z ? 'us' : null),
          outline: z?.outline || null, // only drawn if its name matches, or as a labeled stand-in
          label: primary,
          merge: { label: primary.name, osm: osmPrimary, zillow: zHood, agreed: [osmPrimary, zHood].some((n) => sameName(n, primary.name)) },
        };
      }

      if (!zHood) return report;
      const agreed = o.neighborhoods.some((n) => sameName(n.name, zHood));
      return {
        ...report,
        // Agree: keep OSM's (often more local) name, e.g. Wicker Park inside Zillow's West Town.
        // Disagree: OSM's US neighborhoods are often just points, so trust Zillow's boundary.
        neighborhoods: agreed ? o.neighborhoods : z.neighborhoods,
        settlement: o.settlement || z.settlement,
        settlementStatus: 'in',
        county: o.county || z.county,
        region: o.region || z.region,
        country: o.country || z.country,
        countryCode: o.countryCode || 'us',
        outline: z.outline,
        merge: { zillow: zHood, osm: osmPrimary, agreed },
      };
    },
  };
}

// ---------------------------------------------------------------- outlines

/**
 * Find a boundary to draw for an answer: the source's own (Zillow, or the
 * town/county OSM already fetched), Zillow's for a matching US name, else ask
 * OpenStreetMap at the answer's level (1–2 requests). Prefers the headline
 * itself over a larger area it belongs to.
 */
export function createOutlineFinder({ nominatim, zillow }) {
  return async function findOutline(answer, report, lat, lon, { signal } = {}) {
    if (!['neighborhood', 'settlement', 'county', 'region'].includes(answer.kind)) return null;
    const names = [answer.title, ...answer.broader].filter(Boolean);
    const found = [];
    const consider = (o) => {
      if (o && names.some((n) => sameName(n, o.name)) && pointInGeometry(lon, lat, o.geometry)) {
        found.push({ ...o, isPrimary: sameName(o.name, answer.title), adminCode: looksLikeAdminCode(o.name) });
      }
    };
    consider(report.outline);
    if (answer.kind === 'neighborhood' && zillow && report.countryCode === 'us' && !['zillow', 'auto'].includes(report.source)) {
      try {
        consider((await zillow.lookup(lat, lon)).outline);
      } catch {
        /* static data unavailable: fine, OSM below */
      }
    }
    if (found.some((f) => f.isPrimary)) return pickBoundary(found);

    const plan = {
      neighborhood: [[15, 0.0001], [14, 0.0001]],
      settlement: [[SETTLEMENT_ZOOM[answer.tag] || 12, 0.0005]],
      county: [[8, 0.001]],
      region: [[5, 0.005]],
    }[answer.kind];
    for (const [zoom, threshold] of plan) {
      let r;
      try {
        r = await nominatim.reverse(lat, lon, { zoom, polygon: true, threshold, signal });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        break;
      }
      const b = boundaryFrom(r, { names, primary: answer.title, allowBig: answer.kind !== 'neighborhood' }, lat, lon);
      if (b) {
        found.push({ ...b, from: 'osm' });
        if (b.isPrimary) break;
      }
    }
    // Last resort: a drawn boundary around the pin under another name (Zillow
    // calls Austin's Mueller "RMMA"). Better than nothing; the note says so.
    if (!found.length && answer.kind === 'neighborhood' && report.outline && pointInGeometry(lon, lat, report.outline.geometry)) {
      return { ...report.outline, isPrimary: false, alias: true, adminCode: false };
    }
    return pickBoundary(found);
  };
}

// ------------------------------------------------------------- sea names

/** Names oceans and seas from the bundled IHO Sea Areas (loaded only when needed). */
export function createWaterLookup({ url = 'data/seas.json', fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  let data = null;
  return async function waterAt(lat, lon) {
    data ||= fetchImpl(new URL(url, globalThis.location?.href || 'http://localhost/').toString())
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`seas HTTP ${r.status}`))))
      .catch((err) => {
        data = null;
        throw err;
      });
    const { features } = await data;
    const hit = features.find(
      (f) => lon >= f.bbox[0] && lon <= f.bbox[2] && lat >= f.bbox[1] && lat <= f.bbox[3] && pointInGeometry(lon, lat, f.geometry),
    );
    return hit ? hit.properties.name : null;
  };
}
