/* global maplibregl */
// WNIT: What Neighborhood Is This?
// Map + pin + "you're in ___". Everything runs in the browser against free
// OpenStreetMap services: OpenFreeMap tiles and the public Nominatim geocoder.
import { createNominatim } from './nominatim.js';
import { bboxOf, boundaryFrom, describePlace, parseLatLon, pickBoundary, placeLine } from './hood.js';

const STYLE = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const WORLD = { center: [-40, 25], zoom: 1.4 };
const LOOKUP_ZOOM = 15;
const ACCENT = '#e8590c';
const EMPTY = { type: 'FeatureCollection', features: [] };

const ids = ['search', 'q', 'locate', 'results', 'card', 'eyebrow', 'hood', 'broader', 'where', 'note', 'actions', 'share', 'fix', 'toast'];
const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

const geocoder = createNominatim();
const dark = matchMedia('(prefers-color-scheme: dark)');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ------------------------------------------------------------------ map

const map = new maplibregl.Map({
  container: 'map',
  style: dark.matches ? STYLE.dark : STYLE.light,
  ...WORLD,
  attributionControl: false,
});
map.addControl(
  new maplibregl.AttributionControl({
    compact: true,
    customAttribution:
      'Neighborhoods: <a href="https://nominatim.org/" target="_blank" rel="noopener">Nominatim</a>',
  }),
  'bottom-right',
);
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
map.on('error', (e) => console.warn('[map]', e?.error?.message || e));

let boundaryData = EMPTY;

// (Re)add our boundary layers whenever a style loads, e.g. on dark-mode switch.
map.on('style.load', () => {
  const firstLabel = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addSource('hood', { type: 'geojson', data: boundaryData });
  map.addLayer(
    { id: 'hood-fill', type: 'fill', source: 'hood', paint: { 'fill-color': ACCENT, 'fill-opacity': 0.12 } },
    firstLabel,
  );
  map.addLayer(
    { id: 'hood-line', type: 'line', source: 'hood', paint: { 'line-color': ACCENT, 'line-width': 2.5 } },
    firstLabel,
  );
});
dark.addEventListener('change', (e) => map.setStyle(e.matches ? STYLE.dark : STYLE.light, { diff: false }));

function setBoundary(b) {
  boundaryData = b ? { type: 'Feature', properties: { name: b.name }, geometry: b.geometry } : EMPTY;
  map.getSource('hood')?.setData(boundaryData);
}

let marker = null;
function placeMarker(lon, lat) {
  if (marker) {
    marker.setLngLat([lon, lat]);
    return;
  }
  marker = new maplibregl.Marker({ color: ACCENT, draggable: true }).setLngLat([lon, lat]).addTo(map);
  const el = marker.getElement();
  el.setAttribute('aria-label', 'Your pin. Drag it to look up another spot.');
  el.title = 'Drag me';
  marker.on('dragend', () => {
    const { lat: la, lng } = marker.getLngLat();
    go({ lat: la, lon: lng }, { move: false });
  });
}

map.on('click', (e) => {
  hideResults();
  go({ lat: e.lngLat.lat, lon: e.lngLat.lng }, { move: false });
});

// Zoom to a neighborhood's outline when it arrives, unless the user has
// started panning/zooming themselves since the lookup began.
let autoFit = false;
map.on('movestart', (e) => {
  if (e.originalEvent) autoFit = false;
});

// Keep the pin out from under the card / search bar. This becomes the map's
// own padding (MapLibre adds fitBounds' padding on top of it, so fitBounds
// below only passes a small margin).
function syncPadding() {
  const bar = els.search.getBoundingClientRect();
  const card = els.card.getBoundingClientRect();
  map.setPadding(
    innerWidth >= 720
      ? { top: 0, right: 0, bottom: 0, left: Math.min(card.right, innerWidth / 2) }
      : { top: bar.bottom, right: 0, left: 0, bottom: Math.max(innerHeight - card.top, 220) },
  );
}

function fitTo(bbox, { maxZoom = 17, animate = true } = {}) {
  syncPadding();
  map.fitBounds(bbox, { padding: 24, maxZoom, animate: animate && !reduceMotion.matches, maxDuration: 2000 });
}

function moveCamera({ lat, lon }, { zoom, bbox, instant } = {}) {
  if (bbox) {
    fitTo(bbox, { animate: !instant });
    return;
  }
  syncPadding();
  const options = { center: [lon, lat], zoom: Math.max(map.getZoom(), zoom ?? LOOKUP_ZOOM) };
  if (!instant && !reduceMotion.matches) map.flyTo({ ...options, maxDuration: 2200, essential: true });
  else map.jumpTo(options);
}

// ------------------------------------------------------------- lookups

let inflight = null;
let lastPlace = null;

/** Put the pin at a spot, optionally move the camera there, and name it. */
function go({ lat, lon }, { move = true, zoom, bbox, instant, accuracy } = {}) {
  placeMarker(lon, lat);
  autoFit = move;
  if (move) moveCamera({ lat, lon }, { zoom, bbox, instant });
  history.replaceState(null, '', `#${lat.toFixed(5)},${lon.toFixed(5)}`);
  return lookup(lat, lon, { accuracy });
}

async function lookup(lat, lon, { accuracy } = {}) {
  inflight?.abort();
  const ctrl = new AbortController();
  inflight = ctrl;
  setBoundary(null);
  els.fix.href = `https://www.openstreetmap.org/note/new#map=18/${lat.toFixed(5)}/${lon.toFixed(5)}`;
  render({ state: 'loading', eyebrow: 'Looking up', title: 'This spot…', note: `${lat.toFixed(5)}, ${lon.toFixed(5)}` });

  let res;
  try {
    res = await geocoder.reverse(lat, lon, { signal: ctrl.signal });
  } catch (err) {
    if (err.name === 'AbortError' || ctrl.signal.aborted) return;
    lastPlace = null;
    render({
      state: 'error',
      eyebrow: 'Hmm',
      title: "Couldn't look that up",
      note: "OpenStreetMap's free lookup service didn't answer. Tap the map to try again in a moment.",
    });
    return;
  }
  if (ctrl.signal.aborted) return;

  if (!res || res.error || !res.address) {
    lastPlace = null;
    render({ state: 'empty', eyebrow: 'Nothing here', title: 'No address here', note: 'Looks like water or wilderness. Drag the pin onto land.' });
    return;
  }

  const place = describePlace(res.address);
  lastPlace = { ...place, lat, lon };
  const gpsNote = accuracy > 150 ? `Your location is approximate (±${Math.round(accuracy)} m). Drag the pin if it's off.` : '';

  if (place.neighborhood) {
    render({
      state: 'result',
      eyebrow: "You're in",
      title: place.neighborhood,
      broader: place.broader.join(' · '),
      where: placeLine(place),
      note: gpsNote,
    });
  } else {
    const title = place.settlement || placeLine(place) || 'Somewhere';
    render({
      state: 'nohood',
      eyebrow: 'No neighborhood name here',
      title,
      where: placeLine({ ...place, settlement: title === place.settlement ? null : place.settlement }),
      note: `OpenStreetMap doesn't have a neighborhood for this spot yet. ${gpsNote}`.trim(),
    });
  }

  // Outline the neighborhood when OSM has it as an area (best effort; runs
  // after the name is already on screen). zoom 15 ~ neighborhood, 14 ~ suburb.
  if (!place.candidates.length) return;
  const found = [];
  for (const zoom of [15, 14]) {
    let r;
    try {
      r = await geocoder.reverse(lat, lon, { zoom, polygon: true, signal: ctrl.signal });
    } catch {
      break;
    }
    if (ctrl.signal.aborted) return;
    const b = boundaryFrom(r, place, lat, lon);
    if (b) found.push(b);
    if (b?.isPrimary) break;
  }
  const best = pickBoundary(found);
  if (!best || ctrl.signal.aborted) return;
  setBoundary(best);
  if (!best.isPrimary) addNote(`Outline shows ${best.name}.`);
  const [[w, s], [e, n]] = bboxOf(best.geometry);
  if (autoFit && e - w < 0.25 && n - s < 0.25) fitTo([[w, s], [e, n]], { maxZoom: 16 });
}

// ------------------------------------------------------------ rendering

function render({ state, eyebrow, title, broader = '', where = '', note = '' }) {
  els.card.dataset.state = state;
  els.eyebrow.textContent = eyebrow;
  els.hood.textContent = title;
  setText(els.broader, broader ? `in ${broader}` : '');
  setText(els.where, where);
  setText(els.note, note);
  els.actions.hidden = !(state === 'result' || state === 'nohood');
}

function setText(el, text) {
  el.textContent = text;
  el.hidden = !text;
}

function addNote(text) {
  setText(els.note, [els.note.textContent, text].filter(Boolean).join(' '));
}

function welcome(note) {
  render({ state: 'welcome', eyebrow: 'What neighborhood is this?', title: 'Pick a spot', note });
}

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 2400);
}

// ------------------------------------------------------------ location

function locate({ initial = false } = {}) {
  if (!('geolocation' in navigator)) {
    welcome("This browser can't share your location. Search an address or tap the map.");
    return;
  }
  els.locate.setAttribute('aria-busy', 'true');
  if (initial || !lastPlace) {
    render({ state: 'locating', eyebrow: 'What neighborhood is this?', title: 'Finding you…', note: 'Allow location access, or search / tap the map.' });
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      els.locate.removeAttribute('aria-busy');
      go({ lat: pos.coords.latitude, lon: pos.coords.longitude }, { accuracy: pos.coords.accuracy });
    },
    (err) => {
      els.locate.removeAttribute('aria-busy');
      const why = err.code === err.PERMISSION_DENIED ? 'Location is turned off for this site.' : "Couldn't get your location.";
      if (lastPlace) toast(why);
      else welcome(`${why} Search an address or tap the map to pick a spot.`);
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
  );
}

els.locate.addEventListener('click', () => locate());

// --------------------------------------------------------------- search

els.search.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = els.q.value.trim();
  if (!q) return;
  hideResults();
  const ll = parseLatLon(q);
  if (ll) {
    els.q.blur();
    go(ll);
    return;
  }
  els.search.setAttribute('aria-busy', 'true');
  try {
    let viewbox;
    if (map.getZoom() > 8) {
      const b = map.getBounds();
      viewbox = [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].map((n) => n.toFixed(4)).join(',');
    }
    const results = await geocoder.search(q, { viewbox });
    if (!results.length) showResults([], `No matches for “${q}”. Try adding a city or country.`);
    else if (results.length === 1) choose(results[0]);
    else showResults(results);
  } catch {
    showResults([], 'Search is unavailable right now. Try again in a moment.');
  } finally {
    els.search.removeAttribute('aria-busy');
  }
});

function choose(r) {
  hideResults();
  els.q.blur();
  let bbox;
  if (r.boundingbox) {
    const [s, n, w, e] = r.boundingbox.map(Number);
    bbox = [[w, s], [e, n]];
  }
  go({ lat: Number(r.lat), lon: Number(r.lon) }, { bbox });
}

function showResults(results, emptyText) {
  els.results.replaceChildren();
  if (!results.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyText;
    els.results.append(li);
  }
  for (const r of results) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = r.display_name;
    btn.addEventListener('click', () => choose(r));
    li.append(btn);
    els.results.append(li);
  }
  els.results.hidden = false;
  els.results.querySelector('button')?.focus();
}

function hideResults() {
  els.results.hidden = true;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideResults();
});

// ---------------------------------------------------------------- share

els.share.addEventListener('click', async () => {
  const url = location.href;
  const where = lastPlace?.neighborhood || lastPlace?.settlement;
  const text = where ? `I'm in ${where}${lastPlace.neighborhood && lastPlace.settlement ? `, ${lastPlace.settlement}` : ''}` : 'What neighborhood is this?';
  try {
    if (navigator.share) {
      await navigator.share({ title: 'What Neighborhood Is This?', text, url });
    } else {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    }
  } catch (err) {
    if (err.name !== 'AbortError') toast("Couldn't share. Copy the address bar instead.");
  }
});

// ---------------------------------------------------------------- start

window.addEventListener('hashchange', () => {
  const ll = parseLatLon(location.hash);
  if (ll) go(ll);
});

const start = parseLatLon(location.hash);
if (start) go(start, { zoom: LOOKUP_ZOOM, instant: true });
else locate({ initial: true });

// Handy in the console and used by the end-to-end test.
window.wnit = {
  go,
  map,
  get place() {
    return lastPlace;
  },
  get boundary() {
    return boundaryData;
  },
};
