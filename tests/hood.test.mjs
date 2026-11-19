// Unit tests for the neighborhood logic, using real Nominatim responses
// captured in tests/fixtures (data © OpenStreetMap contributors, ODbL).
// Run: npm test   (Node 18+, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  bboxOf,
  boundaryFrom,
  describePlace,
  looksLikeAdminCode,
  parseLatLon,
  pickBoundary,
  placeLine,
  pointInGeometry,
} from '../src/hood.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const place = (name) => describePlace(fixture(`reverse-${name}`).address);
const opts = (p) => ({ names: p.candidates.map((c) => c.name), primary: p.neighborhood });

const cases = [
  // fixture,              neighborhood,            broader,                                   place line
  ['austin-hyde-park', 'Hyde Park', [], 'Austin, Texas, United States'],
  ['nyc-upper-west-side', 'Upper West Side', ['Manhattan'], 'New York, United States'],
  ['chicago-wicker-park', 'Wicker Park', ['West Town'], 'Chicago, Illinois, United States'],
  ['paris-marais', 'Quartier des Archives', ['3rd Arrondissement'], 'Paris, Ile-de-France, France'],
  ['jakarta-kemang', 'Bangka', ['Mampang Prapatan', 'South Jakarta'], null],
  ['boise-north-end', 'North End', [], 'Boise, Idaho, United States'],
  ['albuquerque-nob-hill', 'Nob Hill', [], 'Albuquerque, New Mexico, United States'],
  ['rome-trastevere', 'Trastevere', [], 'Rome, Lazio, Italy'],
  ['berlin-kreuzberg', 'Luisenstadt', ['Kreuzberg', 'Friedrichshain-Kreuzberg'], 'Berlin, Germany'],
  ['plano-suburb', null, [], 'Plano, Texas, United States'],
  ['rural-iowa', null, [], 'Nevada, Iowa, United States'],
];

for (const [name, hood, broader, line] of cases) {
  test(`describePlace: ${name}`, () => {
    const p = place(name);
    assert.equal(p.neighborhood, hood);
    assert.deepEqual(p.broader, broader);
    if (line) assert.equal(placeLine(p), line);
  });
}

test('admin codes are demoted but kept as candidates', () => {
  const nyc = place('nyc-upper-west-side');
  const board = nyc.candidates.find((c) => c.name === 'Manhattan Community Board 7');
  assert.ok(board?.adminCode);
  assert.equal(nyc.level, 'quarter');

  // when nothing better exists the code is still returned (better than nothing)
  const dublin = describePlace({ city_district: 'Rathmines West C Ward 1986', city: 'Dublin' });
  assert.equal(dublin.neighborhood, 'Rathmines West C Ward 1986');
});

test('Tokyo: chome block numbers lose to the district name', () => {
  // live Nominatim (accept-language=en) answer for Shimokitazawa
  const tokyo = describePlace({ neighbourhood: 'Kitazawa 2', quarter: 'Kitazawa', city: 'Setagaya', country: 'Japan' });
  assert.equal(tokyo.neighborhood, 'Kitazawa');
  assert.deepEqual(tokyo.broader, []);
});

test('looksLikeAdminCode', () => {
  for (const s of ['RW 05', 'RT 3', 'Mumbai Zone 3', 'Municipio Roma I', 'Census Tract 12', 'Southeast Heights4350', '北沢二丁目', 'Kitazawa 2', 'Phase 2B']) {
    assert.ok(looksLikeAdminCode(s), s);
  }
  for (const s of ['Hyde Park', 'Upper West Side', 'Kreuzberg', 'East Village', '3rd Arrondissement', 'Roma Norte', 'Third Ward', 'Fifth Ward']) {
    assert.ok(!looksLikeAdminCode(s), s);
  }
});

test('village/town only count as sub-city when a city is present', () => {
  assert.equal(describePlace({ village: 'Bangka', city: 'Jakarta' }).neighborhood, 'Bangka');
  const smallTown = describePlace({ village: 'Lone Tree', county: 'Story County' });
  assert.equal(smallTown.neighborhood, null);
  assert.equal(smallTown.settlement, 'Lone Tree');
});

test('pointInGeometry handles polygons, misses and non-polygons', () => {
  const kreuzberg = fixture('boundary-z14-berlin-kreuzberg').geojson;
  assert.ok(pointInGeometry(13.403, 52.497, kreuzberg));
  assert.ok(!pointInGeometry(13.35, 52.52, kreuzberg)); // Tiergarten
  assert.ok(!pointInGeometry(13.403, 52.497, { type: 'Point', coordinates: [13.403, 52.497] }));
  const donut = {
    type: 'Polygon',
    coordinates: [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
    ],
  };
  assert.ok(pointInGeometry(2, 2, donut));
  assert.ok(!pointInGeometry(5, 5, donut)); // in the hole
});

test('boundaryFrom picks polygons that match the named areas and contain the pin', () => {
  const berlin = place('berlin-kreuzberg');
  const quarter = boundaryFrom(fixture('boundary-z15-berlin-kreuzberg'), opts(berlin), 52.497, 13.403);
  assert.equal(quarter?.name, 'Luisenstadt');
  assert.equal(quarter.isPrimary, true);

  const suburb = boundaryFrom(fixture('boundary-z14-berlin-kreuzberg'), opts(berlin), 52.497, 13.403);
  assert.equal(suburb?.name, 'Kreuzberg');
  assert.equal(suburb.isPrimary, false);

  const chicago = place('chicago-wicker-park');
  assert.equal(boundaryFrom(fixture('boundary-z14-chicago-wicker-park'), opts(chicago), 41.9088, -87.6796)?.name, 'West Town');

  const austin = place('austin-hyde-park');
  assert.equal(boundaryFrom(fixture('boundary-z15-austin-hyde-park'), opts(austin), 30.306, -97.729), null, 'node, not polygon');
  assert.equal(boundaryFrom(fixture('boundary-z14-austin-hyde-park'), opts(austin), 30.306, -97.729), null, 'whole city');

  // right shape, wrong place: name not in this spot's hierarchy
  assert.equal(boundaryFrom(fixture('boundary-z14-chicago-wicker-park'), opts(berlin), 52.497, 13.403), null);
  // name matches but the pin is outside the polygon
  assert.equal(boundaryFrom(fixture('boundary-z14-berlin-kreuzberg'), opts(berlin), 52.52, 13.35), null);
  assert.equal(boundaryFrom(fixture('reverse-atlantic-ocean'), opts(berlin), 0, -30), null);
});

test('pickBoundary prefers the named neighborhood, then real names over codes', () => {
  const code = { name: 'Kitazawa 2', isPrimary: false, adminCode: true };
  const real = { name: 'Kreuzberg', isPrimary: false, adminCode: false };
  const primary = { name: 'Luisenstadt', isPrimary: true, adminCode: false };
  assert.equal(pickBoundary([code, real, primary]), primary);
  assert.equal(pickBoundary([code, real]), real);
  assert.equal(pickBoundary([code]), code);
  assert.equal(pickBoundary([]), null);
});

test('bboxOf', () => {
  const [[w, s], [e, n]] = bboxOf(fixture('boundary-z14-berlin-kreuzberg').geojson);
  assert.ok(w < 13.403 && 13.403 < e && s < 52.497 && 52.497 < n);
  assert.ok(e - w < 0.1 && n - s < 0.1, 'Kreuzberg is a few km across');
  const multi = { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[5, 5], [6, 5], [6, 7], [5, 5]]]] };
  assert.deepEqual(bboxOf(multi), [[0, 0], [6, 7]]);
});

test('parseLatLon', () => {
  assert.deepEqual(parseLatLon('30.3060, -97.7290'), { lat: 30.306, lon: -97.729 });
  assert.deepEqual(parseLatLon('#52.497,13.403'), { lat: 52.497, lon: 13.403 });
  assert.deepEqual(parseLatLon('-33.886 151.211'), { lat: -33.886, lon: 151.211 });
  assert.deepEqual(parseLatLon('40.787,-73.9754,15'), { lat: 40.787, lon: -73.9754 });
  assert.equal(parseLatLon('95, 10'), null);
  assert.equal(parseLatLon('Hyde Park, Austin'), null);
  assert.equal(parseLatLon(''), null);
});
