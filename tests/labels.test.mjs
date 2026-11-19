// The map-label source: our tiny vector-tile reader (on a real OpenFreeMap
// tile, cross-checked against Mapbox's reference decoder during development),
// tile math, and how the nearest label is picked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createLabelSource, labelName, lonLatOf, pickLabels, placesInTile, rankLabels, readLayer, tileOf, tilesFor } from '../src/labels.js';
import { makeFetch } from './helpers.mjs';

const TILE = { z: 14, x: 3852, y: 6774 }; // Houston: Third Ward, Museum District, MacGregor...
const bytes = readFileSync(new URL('./fixtures/tile-14-3852-6774.pbf', import.meta.url));
const THIRD_WARD = [29.72437, -95.3576];

test('reads the place layer of a real vector tile', () => {
  const layer = readLayer(bytes, 'place');
  assert.equal(layer.name, 'place');
  assert.equal(layer.extent, 4096);
  assert.equal(layer.features.length, 15);
  assert.ok(layer.features.every((f) => f.type === 1 && f.points.length === 1));
  assert.equal(readLayer(bytes, 'no-such-layer'), null);

  const places = placesInTile(bytes, TILE);
  const third = places.find((p) => p.props.name === 'Third Ward');
  assert.equal(third.cls, 'suburb');
  assert.ok(Math.abs(third.lat - 29.725) < 0.01 && Math.abs(third.lon + 95.357) < 0.01, `${third.lat},${third.lon}`);
  assert.equal(typeof third.props.rank, 'number');
});

test('tile math round-trips, and edge pins read their neighbors too', () => {
  const { x, y } = tileOf(29.72437, -95.3576, 14);
  assert.deepEqual([Math.floor(x), Math.floor(y)], [TILE.x, TILE.y]);
  const [lon, lat] = lonLatOf(x, y, 14);
  assert.ok(Math.abs(lon + 95.3576) < 1e-9 && Math.abs(lat - 29.72437) < 1e-9);

  const [cx, cy] = [TILE.x + 0.5, TILE.y + 0.5];
  const [mlon, mlat] = lonLatOf(cx, cy, 14); // middle of a tile: just that tile
  assert.deepEqual(tilesFor(mlat, mlon), [TILE]);
  assert.equal(tilesFor(...THIRD_WARD).length, 4, 'near a corner: the 2x2 block around it');
});

test('labels in the viewer language, falling back to the local name', () => {
  const props = { name: '北沢', 'name:en': 'Kitazawa', 'name:de': 'Kitazawa (de)' };
  assert.equal(labelName(props, 'en'), 'Kitazawa');
  assert.equal(labelName(props, 'de'), 'Kitazawa (de)');
  assert.equal(labelName(props, 'fr'), '北沢');
  assert.equal(labelName({ name: 'Mueller Community', name_en: 'Mueller Community' }, 'en'), 'Mueller Community');
});

test('nearest label wins, with bigger areas counting as a little closer', () => {
  const at = (cls, name, km) => ({ cls, props: { name }, lat: 30 + km / 111.2, lon: -97 });
  const rank = (places) => rankLabels(places, 30, -97).map((p) => p.name);
  // Third Ward (suburb, 140 m) beats Canfield Oaks (neighbourhood, 570 m)
  assert.deepEqual(rank([at('neighbourhood', 'Canfield Oaks', 0.57), at('suburb', 'Third Ward', 0.14)])[0], 'Third Ward');
  // Berlin: Kreuzberg (suburb, 610 m) beats Spring-Siedlung (neighbourhood, 500 m)
  assert.equal(rank([at('neighbourhood', 'Spring-Siedlung', 0.5), at('suburb', 'Kreuzberg', 0.61)])[0], 'Kreuzberg');
  // Mexico City: Colonia Roma Norte (160 m) beats the Roma suburb label (300 m)...
  const roma = rankLabels([at('neighbourhood', 'Colonia Roma Norte', 0.16), at('suburb', 'Roma', 0.3)], 30, -97);
  assert.deepEqual(pickLabels(roma).primary.name, 'Colonia Roma Norte');
  assert.deepEqual(pickLabels(roma).broader.map((p) => p.name), ['Roma'], '...and Roma becomes the larger area');
  // Tokyo: the chome block "Kitazawa 2" is skipped as an admin code
  assert.equal(rank([at('neighbourhood', 'Kitazawa 2', 0.12), at('quarter', 'Kitazawa', 0.27)])[0], 'Kitazawa');
  // too far away, or not a neighborhood-level label: nothing
  assert.deepEqual(rank([at('neighbourhood', 'Far Away', 2.5), at('city', 'Houston', 0.1)]), []);
  assert.deepEqual(pickLabels([]), { primary: null, broader: [] });
});

test('label source: fetches the tiles around the pin (missing tiles are fine)', async () => {
  const { fetchImpl, log } = makeFetch();
  const source = createLabelSource({ fetchImpl, languages: () => 'en-US' });
  const ranked = await source.nearby(...THIRD_WARD);
  const { primary } = pickLabels(ranked);
  assert.equal(primary.name, 'Third Ward');
  assert.equal(primary.cls, 'suburb');
  assert.ok(primary.km < 0.2, `${primary.km} km`);
  const tiles = log.filter((u) => u.endsWith('.pbf'));
  assert.equal(tiles.length, 4);
  await source.nearby(...THIRD_WARD);
  assert.equal(log.filter((u) => u.endsWith('.pbf')).length, 4, 'tiles are cached');
});
