// Data sources + the "always have an answer" ladder, against recorded responses.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { answerFor, emptyReport, explain, levelsOf, wantsWater } from '../src/answer.js';
import { createLabelSource } from '../src/labels.js';
import { createNominatim } from '../src/nominatim.js';
import {
  cleanZillow,
  createAutoSource,
  createEsriSource,
  createLabelsSource,
  createOsmSource,
  createOutlineFinder,
  createPhotonSource,
  createWaterLookup,
  createZillowSource,
} from '../src/sources.js';
import { makeFetch } from './helpers.mjs';

const EN = () => 'en';
function setup() {
  const { fetchImpl, log } = makeFetch();
  const nominatim = createNominatim({ fetchImpl, minIntervalMs: 0, languages: EN });
  const zillow = createZillowSource({ baseUrl: 'http://localhost/data/zillow/', fetchImpl });
  const osm = createOsmSource(nominatim);
  const labels = createLabelSource({ fetchImpl, languages: EN });
  return {
    log,
    nominatimCalls: () => log.filter((u) => u.includes('nominatim')).length,
    osm,
    zillow,
    auto: createAutoSource({ osm, zillow }), // without map labels: the older rules
    autoWithLabels: (l = labels) => createAutoSource({ osm, zillow, labels: l }),
    labelsSource: createLabelsSource({ osm, labels }),
    photon: createPhotonSource({ fetchImpl, languages: EN }),
    esri: createEsriSource({ fetchImpl, languages: EN }),
    findOutline: createOutlineFinder({ nominatim, zillow }),
    waterAt: createWaterLookup({ url: 'http://localhost/data/seas.json', fetchImpl }),
  };
}

// ----------------------------------------------------------------- ladder

test('ladder: Texas panhandle ranchland -> the county, near the ghost town', async () => {
  const { osm, findOutline } = setup();
  const report = await osm.lookup(35.4, -102.3);
  assert.deepEqual(report.settlement, { name: 'Tascosa', kind: 'hamlet' });
  assert.equal(report.settlementStatus, 'near');
  const a = answerFor(report);
  assert.equal(a.kind, 'county');
  assert.equal(a.title, 'Oldham County');
  assert.equal(a.tag, 'county');
  assert.equal(a.near, 'Tascosa');
  assert.equal(a.where, 'Texas, United States');
  const outline = await findOutline(a, report, 35.4, -102.3);
  assert.equal(outline?.name, 'Oldham County');
  assert.ok(outline.isPrimary);
  assert.match(explain(a, report, { outline }).join(' '), /outside any town \(the nearest one OpenStreetMap knows is Tascosa\)/);
  assert.deepEqual(
    levelsOf(report).map((r) => [r.label, r.name, r.note]),
    [
      ['hamlet', 'Tascosa', "nearest one; you're outside it"],
      ['county', 'Oldham County', ''],
      ['state', 'Texas', ''],
      ['country', 'United States', ''],
    ],
  );
});

test('ladder: suburb with no neighborhood -> the city you are in, outlined', async () => {
  const { osm, findOutline } = setup();
  const report = await osm.lookup(33.0198, -96.6989);
  assert.equal(report.settlementStatus, 'in');
  const a = answerFor(report);
  assert.deepEqual([a.kind, a.tag, a.title, a.where], ['settlement', 'city', 'Plano', 'Collin County, Texas, United States']);
  assert.equal((await findOutline(a, report, 33.0198, -96.6989))?.name, 'Plano');
});

test('ladder: open ocean -> IHO sea area name', async () => {
  const { osm, waterAt } = setup();
  const report = await osm.lookup(5, -140);
  assert.ok(wantsWater(report));
  report.water = await waterAt(5, -140);
  report.waterSource = 'iho';
  const a = answerFor(report);
  assert.deepEqual([a.kind, a.tag, a.title], ['water', 'ocean', 'North Pacific Ocean']);
  assert.match(explain(a, report).join(' '), /IHO/);
  assert.equal(await waterAt(25, -90), 'Gulf of Mexico');
  assert.equal(await waterAt(30.306, -97.729), null, 'Austin is not at sea');
});

test('ladder: order of fallbacks', () => {
  const r = (extra) => answerFor(emptyReport('osm', extra));
  assert.equal(r({ region: 'Agadez Region', country: 'Niger' }).title, 'Agadez Region');
  assert.equal(r({ region: 'Agadez Region', country: 'Niger' }).tag, 'region');
  assert.equal(r({ country: 'Mongolia' }).kind, 'country');
  assert.equal(r({}).kind, 'none');
  const offshore = r({ water: 'Gulf of Mexico', county: 'Galveston County', region: 'Texas', country: 'United States', countryCode: 'us' });
  assert.deepEqual([offshore.kind, offshore.where], ['water', 'off Texas, United States']);
  const near = r({ settlement: { name: 'Vega', kind: 'city' }, settlementStatus: 'near', county: 'Oldham County', countryCode: 'us' });
  assert.deepEqual([near.kind, near.near], ['county', 'Vega']);
});

// ----------------------------------------------------------------- sources

test('Photon: Austin, Seattle, and nothing at sea', async () => {
  const { photon } = setup();
  const austin = answerFor(await photon.lookup(30.306, -97.729));
  assert.deepEqual([austin.title, austin.where], ['Hyde Park', 'Austin, Texas, United States']);
  const seattle = answerFor(await photon.lookup(47.6253, -122.3222));
  assert.equal(seattle.title, 'Madison Valley');
  assert.deepEqual(seattle.broader, ['Capitol Hill']);
  const sea = await photon.lookup(0, -140);
  assert.equal(answerFor(sea).kind, 'none');
  assert.ok(wantsWater(sea));
});

test('Esri: neighborhoods, postal towns we are only near, oceans', async () => {
  const { esri } = setup();
  assert.equal(answerFor(await esri.lookup(30.306, -97.729)).title, 'Hyde Park');
  assert.equal(answerFor(await esri.lookup(47.6253, -122.3222)).title, 'Broadway');
  assert.equal(answerFor(await esri.lookup(52.497, 13.403)).title, 'Kreuzberg');
  const tx = await esri.lookup(35.4, -102.3);
  assert.equal(tx.settlementStatus, 'near');
  assert.deepEqual([answerFor(tx).kind, answerFor(tx).title, answerFor(tx).near], ['county', 'Oldham County', 'Vega']);
  const sea = answerFor(await esri.lookup(0, -140));
  assert.deepEqual([sea.kind, sea.title], ['water', 'Pacific Ocean']);
});

test('Zillow: static boundaries with outline; nothing outside its 151 cities', async () => {
  const { zillow } = setup();
  const austin = await zillow.lookup(30.306, -97.729);
  const a = answerFor(austin);
  assert.deepEqual([a.title, a.where], ['Hyde Park', 'Austin, Texas, United States']);
  assert.equal(austin.county, 'Travis County');
  assert.equal(austin.outline.name, 'Hyde Park');
  const nyc = await zillow.lookup(40.787, -73.9754);
  assert.deepEqual([answerFor(nyc).title, answerFor(nyc).broader, nyc.settlement.name], ['Upper West Side', ['Manhattan'], 'New York']);
  const plano = await zillow.lookup(33.0198, -96.6989);
  assert.equal(answerFor(plano).kind, 'none');
  assert.match(plano.note, /151 US cities/);
  assert.equal(answerFor(await zillow.lookup(52.497, 13.403)).kind, 'none', 'Berlin: no data');
});

test('cleanZillow fixes city prefixes, NYC boroughs and county names', () => {
  assert.equal(cleanZillow({ name: 'Atlanta-Inman Park', city: 'Atlanta', county: 'Fulton', state: 'GA' }).hood, 'Inman Park');
  assert.deepEqual(cleanZillow({ name: 'SoHo', city: 'New York City-Manhattan', county: 'New York', state: 'NY' }), {
    hood: 'SoHo',
    borough: 'Manhattan',
    city: 'New York',
    county: 'New York County',
    region: 'New York',
  });
  assert.equal(cleanZillow({ name: 'Bywater', city: 'New Orleans', county: 'Orleans', state: 'LA' }).county, 'Orleans Parish');
});

// -------------------------------------------------------------- best guess

test('Best guess: OSM and Zillow agree -> OSM name, Zillow outline, no extra requests', async () => {
  const { auto, findOutline, nominatimCalls } = setup();
  const report = await auto.lookup(30.306, -97.729);
  const a = answerFor(report);
  assert.equal(a.title, 'Hyde Park');
  assert.ok(report.merge.agreed);
  const before = nominatimCalls();
  const outline = await findOutline(a, report, 30.306, -97.729);
  assert.equal(outline.name, 'Hyde Park');
  assert.ok(outline.isPrimary);
  assert.equal(nominatimCalls(), before, 'outline came from the bundled Zillow data');
  assert.match(explain(a, report, { outline }).join(' '), /agree/);
});

test('Best guess: Zillow is coarser -> keep the more local OSM name inside it', async () => {
  const { auto } = setup();
  const report = await auto.lookup(41.9088, -87.6796);
  const a = answerFor(report);
  assert.deepEqual([a.title, a.broader], ['Wicker Park', ['West Town']]);
  assert.equal(report.outline.name, 'West Town');
});

test('Best guess: OSM point guess vs Zillow boundary -> Zillow wins, and says why', async () => {
  const { auto } = setup();
  const report = await auto.lookup(47.6253, -122.3222);
  const a = answerFor(report);
  assert.equal(a.title, 'Capitol Hill');
  assert.deepEqual(report.merge, { zillow: 'Capitol Hill', osm: 'Madison Valley', agreed: false });
  assert.match(explain(a, report).join(' '), /OpenStreetMap guesses “Madison Valley”, but Zillow/);
});

test('Best guess outside the US is plain OpenStreetMap', async () => {
  const { auto } = setup();
  const report = await auto.lookup(52.497, 13.403);
  assert.equal(answerFor(report).title, 'Luisenstadt');
  assert.equal(report.merge, undefined);
});

// ------------------------------------------------------- with map labels

test('Best guess + map labels, Houston: "Third Ward" (not Zillow\'s "Southeast"), outlined by OSM', async () => {
  const { autoWithLabels, findOutline } = setup();
  const report = await autoWithLabels().lookup(29.72437, -95.3576);
  const a = answerFor(report);
  assert.deepEqual([a.kind, a.title, a.where], ['neighborhood', 'Third Ward', 'Houston, Texas, United States']);
  assert.equal(report.merge.zillow, 'Southeast');
  const outline = await findOutline(a, report, 29.72437, -95.3576);
  assert.deepEqual([outline?.name, outline?.isPrimary, outline?.from], ['Third Ward', true, 'osm']);
  const why = explain(a, report, { outline }).join(' ');
  assert.match(why, /printed on the map nearest your pin \(1\d0 m away/);
  assert.match(why, /Zillow's boundary says “Southeast”/);
});

test('Best guess + map labels, Mueller: the label beats Zillow\'s "Rmma", whose boundary stays as a stand-in', async () => {
  const { autoWithLabels, findOutline } = setup();
  const mueller = { nearby: async () => [{ name: 'Mueller Community', cls: 'neighbourhood', km: 0.41, score: 0.41 }] };
  const report = await autoWithLabels(mueller).lookup(30.29743, -97.70436);
  const a = answerFor(report);
  assert.deepEqual([a.title, a.where], ['Mueller Community', 'Austin, Texas, United States']);
  const outline = await findOutline(a, report, 30.29743, -97.70436);
  assert.deepEqual([outline?.name, outline?.alias], ['Rmma', true]);
  assert.match(explain(a, report, { outline }).join(' '), /which Zillow calls “Rmma”/);
});

test('Map labels as their own source; no label nearby falls back to the older rules', async () => {
  const { labelsSource, autoWithLabels } = setup();
  const houston = await labelsSource.lookup(29.72437, -95.3576);
  assert.equal(answerFor(houston).title, 'Third Ward');
  assert.ok(levelsOf(houston).some((r) => r.label === 'suburb / district' && r.name === 'Third Ward'));
  // Seattle: no recorded tile, so no labels -> OSM + Zillow rules (Zillow's drawn Capitol Hill)
  const seattle = await autoWithLabels().lookup(47.6253, -122.3222);
  assert.equal(answerFor(seattle).title, 'Capitol Hill');
  assert.equal(seattle.label, undefined);
});

test('Outlines: OSM neighborhood polygon, and Zillow borrowed for other sources', async () => {
  const { osm, esri, findOutline } = setup();
  const berlin = await osm.lookup(52.497, 13.403);
  assert.equal((await findOutline(answerFor(berlin), berlin, 52.497, 13.403))?.name, 'Luisenstadt');
  const esriAustin = await esri.lookup(30.306, -97.729);
  const o = await findOutline(answerFor(esriAustin), esriAustin, 30.306, -97.729);
  assert.deepEqual([o?.name, o?.from], ['Hyde Park', 'zillow']);
});
