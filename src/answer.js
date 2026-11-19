// The "always have an answer" ladder, shared by every data source.
//
// Every source turns its response into the same Report shape; answerFor()
// then walks down: neighborhood -> town you're in -> named water -> county ->
// state -> country. explain() says, in plain words, why that answer won.
import { joinPlaces, rankNeighborhoods, sameName } from './hood.js';

/**
 * @typedef {{key: string, name: string, adminCode: boolean, weak: boolean}} Candidate
 * @typedef {{
 *   source: string,
 *   neighborhoods: Candidate[],           // sub-city names, most local first
 *   settlement: {name: string, kind: string}|null,
 *   settlementStatus: 'in'|'near'|'unknown',
 *   county: string|null, region: string|null, country: string|null,
 *   countryCode: string|null,             // ISO 3166-1 alpha-2, lower case
 *   water: string|null, waterSource?: string,
 *   outline: {name: string, geometry: object, from: string}|null,
 *   merge?: {zillow: string, osm: string|null, agreed: boolean},
 *   note?: string,
 * }} Report
 */

export function emptyReport(source, extra = {}) {
  return {
    source,
    neighborhoods: [],
    settlement: null,
    settlementStatus: 'unknown',
    county: null,
    region: null,
    country: null,
    countryCode: null,
    water: null,
    outline: null,
    ...extra,
  };
}

/** True when only water could still name this spot (worth checking the sea areas). */
export function wantsWater(report) {
  return !report.water && !report.neighborhoods.length && !(report.settlement && report.settlementStatus !== 'near');
}

export function waterTag(name) {
  if (/ocean/i.test(name)) return 'ocean';
  if (/\bsea\b/i.test(name)) return 'sea';
  if (/gulf/i.test(name)) return 'gulf';
  if (/\bbay\b|bight|cove/i.test(name)) return 'bay';
  if (/strait|channel|sound|passage/i.test(name)) return 'strait';
  if (/lake|reservoir/i.test(name)) return 'lake';
  return 'water';
}

/**
 * @returns {{kind: 'neighborhood'|'settlement'|'water'|'county'|'region'|'country'|'none',
 *   tag: string, title: string|null, broader: string[], near: string|null, where: string}}
 */
export function answerFor(report) {
  const r = report;
  const us = r.countryCode === 'us';
  const { primary, broader } = rankNeighborhoods(r.neighborhoods || []);
  const near = r.settlement && r.settlementStatus === 'near' ? r.settlement.name : null;
  const base = { broader: [], near: null };

  if (primary) {
    return {
      ...base,
      kind: 'neighborhood',
      tag: 'neighborhood',
      title: primary.name,
      broader: broader.map((b) => b.name),
      where: joinPlaces([r.settlement?.name, r.region, r.country]),
    };
  }
  if (r.settlement && r.settlementStatus !== 'near') {
    return { ...base, kind: 'settlement', tag: r.settlement.kind || 'town', title: r.settlement.name, where: joinPlaces([r.county, r.region, r.country]) };
  }
  if (r.water) {
    const coast = joinPlaces([r.region || r.county, r.country]);
    return { ...base, kind: 'water', tag: waterTag(r.water), title: r.water, near, where: coast ? `off ${coast}` : '' };
  }
  if (r.county) return { ...base, kind: 'county', tag: us ? 'county' : 'district', title: r.county, near, where: joinPlaces([r.region, r.country]) };
  if (r.region) return { ...base, kind: 'region', tag: us ? 'state' : 'region', title: r.region, near, where: joinPlaces([r.country]) };
  if (r.country) return { ...base, kind: 'country', tag: 'country', title: r.country, near, where: '' };
  return { ...base, kind: 'none', tag: '', title: null, where: '' };
}

const WHO = {
  auto: 'OpenStreetMap',
  labels: "The map's labels",
  osm: 'OpenStreetMap',
  photon: 'Photon (OpenStreetMap data)',
  zillow: "Zillow's neighborhood boundaries",
  esri: "Esri's World Geocoder",
};

/** Plain-language reasons for an answer, as a list of sentences. */
export function explain(answer, report, { outline = null } = {}) {
  const who = WHO[report.source] || 'This source';
  const out = [];
  const codes = report.neighborhoods.filter((n) => n.adminCode).map((n) => `“${n.name}”`);

  switch (answer.kind) {
    case 'neighborhood': {
      const m = report.merge;
      if (report.label) {
        out.push(`“${answer.title}” is the neighborhood name printed on the map nearest your pin (${formatKm(report.label.km)} away; OpenStreetMap data).`);
        const others = [];
        if (m?.osm && !sameName(m.osm, answer.title)) others.push(`OpenStreetMap's address lookup says “${m.osm}”`);
        if (m?.zillow && !sameName(m.zillow, answer.title)) others.push(`Zillow's boundary says “${m.zillow}”`);
        if (others.length) out.push(`${others.join(', and ')}.`);
        else if (m?.agreed) out.push('The other sources agree.');
      } else if (m && !m.agreed && m.osm) {
        out.push(`OpenStreetMap guesses “${m.osm}”, but Zillow has a drawn boundary for “${m.zillow}” that contains your pin, so we went with Zillow.`);
      } else if (m?.agreed && sameName(m.zillow, answer.title)) {
        out.push(`OpenStreetMap and Zillow's boundaries agree: this is “${answer.title}”.`);
      } else if (m?.agreed) {
        out.push(`OpenStreetMap names this spot “${answer.title}”, and it sits inside Zillow's boundary for “${m.zillow}”.`);
      } else if (report.source === 'zillow' || (report.source === 'auto' && m)) {
        out.push(`${WHO.zillow} (2015) put your pin inside “${answer.title}”.`);
      } else {
        out.push(`${who} calls the smallest named area here “${answer.title}”.`);
      }
      if (outline?.alias) out.push(`The outline is Zillow's boundary for this area, which Zillow calls “${outline.name}”.`);
      else if (outline?.isPrimary) out.push('Its boundary is outlined on the map.');
      else if (outline) out.push(`The outline shows ${outline.name}, a larger area this belongs to.`);
      else if (report.label) out.push('Map labels are points, not boundaries, so near the edge between two neighborhoods this is a best guess.');
      else if (report.source === 'osm' || report.source === 'auto') {
        out.push('Mappers marked it with a single point rather than a boundary, so near its edges this is a best guess.');
      } else out.push("This source doesn't share boundaries, so there's no outline.");
      if (codes.length) out.push(`We skipped ${codes.join(', ')}: ${codes.length > 1 ? 'they look' : 'it looks'} like an administrative code, not a name people use.`);
      break;
    }
    case 'settlement':
      out.push(`${who} has no neighborhood name here, so this is the ${answer.tag} you're in.`);
      if (outline) out.push('Its limits are outlined on the map.');
      break;
    case 'water':
      out.push(
        report.waterSource === 'iho'
          ? "You're over water. Sea and ocean names come from the IHO's official sea areas (Marine Regions)."
          : `You're over water; ${who} names it “${answer.title}”.`,
      );
      break;
    case 'county':
    case 'region':
      out.push(
        answer.near
          ? `You're outside any town (the nearest one ${who} knows is ${answer.near}), so this is the ${answer.tag} you're in.`
          : `${who} has no town here, so this is the ${answer.tag} you're in.`,
      );
      if (outline) out.push('Its boundary is outlined on the map.');
      break;
    case 'country':
      out.push(`${who} only knows the country here.`);
      break;
    default:
      out.push(report.note || `${who} has no name for this spot.`);
  }
  return out;
}

function formatKm(km) {
  return km < 1 ? `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m` : `${km.toFixed(1)} km`;
}

/** Friendly label for a level key in the "this spot is part of" list. */
export function levelLabel(key) {
  return (
    {
      neighbourhood: 'neighborhood',
      quarter: 'quarter',
      city_block: 'block / quarter',
      suburb: 'suburb / district',
      city_district: 'district',
      borough: 'borough',
      district: 'district',
      subdivision: 'subdivision',
      residential: 'land use',
      allotments: 'land use',
      hamlet: 'hamlet',
      village: 'village',
      town: 'town',
      locality: 'locality',
      neighborhood: 'neighborhood',
    }[key] || key
  );
}

/** Rows for the "this spot is part of" list, local -> broad. */
export function levelsOf(report) {
  const rows = report.neighborhoods.map((n) => ({
    label: levelLabel(n.key),
    name: n.name,
    note: n.adminCode ? 'skipped: looks like an admin code' : n.weak ? 'land-use name, used only as a last resort' : '',
  }));
  if (report.settlement) {
    rows.push({
      label: report.settlement.kind || 'town',
      name: report.settlement.name,
      note: report.settlementStatus === 'near' ? "nearest one; you're outside it" : '',
    });
  }
  const us = report.countryCode === 'us';
  if (report.county) rows.push({ label: us ? 'county' : 'district', name: report.county, note: '' });
  if (report.region) rows.push({ label: us ? 'state' : 'region', name: report.region, note: '' });
  if (report.country) rows.push({ label: 'country', name: report.country, note: '' });
  if (report.water) rows.push({ label: waterTag(report.water), name: report.water, note: '' });
  return rows.filter((row, i) => !rows.slice(0, i).some((p) => sameName(p.name, row.name) && p.label === row.label));
}
