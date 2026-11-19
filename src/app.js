/* global maplibregl */
// WNIT: What Neighborhood Is This?
// Map + pin + "you're in ___", with a choice of data sources. Everything runs
// in the browser: OpenFreeMap tiles, OpenStreetMap (Nominatim / Photon), Esri,
// and static files shipped with the site (Zillow boundaries, IHO sea areas).
import { answerFor, explain, levelsOf, wantsWater } from './answer.js';
import { apiBase } from './config.js';
import { bboxOf, parseLatLon } from './hood.js';
import { createLabelSource } from './labels.js';
import { createNominatim } from './nominatim.js';
import {
  SOURCE_IDS,
  SOURCE_INFO,
  createAutoSource,
  createEsriSource,
  createLabelsSource,
  createOsmSource,
  createOutlineFinder,
  createPhotonSource,
  createWaterLookup,
  createZillowSource,
} from './sources.js';

const STYLE = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const WORLD = { center: [-40, 25], zoom: 1.4 };
const LOOKUP_ZOOM = 15;
const ACCENT = '#e8590c';
const EMPTY = { type: 'FeatureCollection', features: [] };
// Largest outline (in degrees) worth zooming the map to, per kind of answer.
const FIT_SPAN = { neighborhood: 0.25, settlement: 1, county: 3 };

const ids = [
  'search', 'q', 'locate', 'results', 'card', 'eyebrow', 'tag', 'why', 'hood', 'broader', 'where', 'note', 'via',
  'actions', 'share', 'fix', 'toast', 'about', 'about-title', 'about-why', 'source-list', 'levels', 'osm-link',
];
const els = Object.fromEntries(ids.map((id) => [id.replace(/-(\w)/g, (_, c) => c.toUpperCase()), document.getElementById(id)]));

const dark = matchMedia('(prefers-color-scheme: dark)');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// -------------------------------------------------------------- sources

// With our lookup cache deployed, OSM lookups go through it (it enforces the
// 1 request/second limit for everyone, so the browser needn't wait as long).
const API = apiBase();
const nominatim = createNominatim(API ? { baseUrl: `${API}/nominatim`, minIntervalMs: 250 } : {});
const zillow = createZillowSource();
const osm = createOsmSource(nominatim);
const labels = createLabelSource(); // names printed on the map (same tiles the map draws)
const SOURCES = {
  auto: createAutoSource({ osm, zillow, labels }),
  labels: createLabelsSource({ osm, labels }),
  osm,
  photon: createPhotonSource(API ? { baseUrl: `${API}/photon` } : {}),
  zillow,
  esri: createEsriSource(),
};
const findOutline = createOutlineFinder({ nominatim, zillow });
const waterAt = createWaterLookup();

let sourceId = initialSource();

function initialSource() {
  const fromUrl = new URLSearchParams(location.search).get('source');
  if (SOURCE_IDS.includes(fromUrl)) return fromUrl;
  try {
    const saved = localStorage.getItem('wnit.source');
    if (SOURCE_IDS.includes(saved)) return saved;
  } catch {
    /* storage blocked: fine */
  }
  return 'auto';
}

function persistSource(id) {
  try {
    localStorage.setItem('wnit.source', id);
  } catch {
    /* ignore */
  }
  const url = new URL(location.href);
  if (id === 'auto') url.searchParams.delete('source');
  else url.searchParams.set('source', id);
  history.replaceState(null, '', url);
}

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
      'Names: <a href="https://nominatim.org/" target="_blank" rel="noopener">Nominatim</a>, ' +
      '<a href="https://github.com/zeke/hoods" target="_blank" rel="noopener">Zillow</a> (CC BY-SA), ' +
      '<a href="https://www.marineregions.org/" target="_blank" rel="noopener">Marine Regions</a> (CC BY)',
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
  boundaryData = b ? { type: 'Feature', properties: { name: b.name, from: b.from || 'osm' }, geometry: b.geometry } : EMPTY;
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

// Zoom to an outline when it arrives, unless the user has started
// panning/zooming themselves since the lookup began.
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

/** The spot being looked up, with every source's report for it (fetched lazily, cached). */
let spot = null;

/** Put the pin at a spot, optionally move the camera there, and name it. */
function go({ lat, lon }, { move = true, zoom, bbox, instant, accuracy } = {}) {
  placeMarker(lon, lat);
  autoFit = move;
  if (move) moveCamera({ lat, lon }, { zoom, bbox, instant });
  history.replaceState(null, '', `#${lat.toFixed(5)},${lon.toFixed(5)}`);
  return lookup(lat, lon, { accuracy });
}

function lookup(lat, lon, { accuracy } = {}) {
  spot?.ctrl.abort();
  const s = { lat, lon, accuracy, ctrl: new AbortController(), reports: new Map(), shown: null };
  spot = s;
  setBoundary(null);
  const ll = `${lat.toFixed(5)}/${lon.toFixed(5)}`;
  els.fix.href = `https://www.openstreetmap.org/note/new#map=18/${ll}`;
  els.osmLink.href = `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=17/${ll}`;
  render({ state: 'loading', eyebrow: 'Looking up', title: 'This spot…', note: `${lat.toFixed(5)}, ${lon.toFixed(5)}` });
  return show(s, sourceId);
}

/** One source's report for a spot (sea names filled in from the IHO areas when nothing on land fits). */
function reportFor(s, id) {
  if (!s.reports.has(id)) {
    const promise = (async () => {
      const report = await SOURCES[id].lookup(s.lat, s.lon, { signal: s.ctrl.signal });
      if (id !== 'zillow' && wantsWater(report)) {
        try {
          const water = await waterAt(s.lat, s.lon);
          if (water) Object.assign(report, { water, waterSource: 'iho' });
        } catch {
          /* sea data unavailable: answer without it */
        }
      }
      return report;
    })();
    s.reports.set(id, promise);
    promise.catch(() => s.reports.delete(id)); // allow a retry after network errors
  }
  return s.reports.get(id);
}

async function show(s, id) {
  let report;
  try {
    report = await reportFor(s, id);
  } catch (err) {
    if (s !== spot || id !== sourceId || err.name === 'AbortError') return;
    s.shown = null;
    render({
      state: 'error',
      eyebrow: 'Hmm',
      title: "Couldn't look that up",
      note: `${SOURCE_INFO[id].label} didn't answer. Tap the map to try again, or pick another source with the ? button.`,
    });
    refreshAbout();
    return;
  }
  if (s !== spot || id !== sourceId) return;

  const answer = answerFor(report);
  s.shown = { id, report, answer, outline: null };
  setBoundary(null);
  renderAnswer(s);
  refreshAbout();
  // Mid-ocean at street zoom is a blank screen: back off until a coast shows.
  const waterZoom = answer.tag === 'ocean' ? 2.5 : 4.5;
  if (answer.kind === 'water' && autoFit && map.getZoom() > waterZoom) {
    const camera = { center: [s.lon, s.lat], zoom: waterZoom };
    if (reduceMotion.matches) map.jumpTo(camera);
    else map.easeTo({ ...camera, duration: 1200 });
  }

  let outline = null;
  try {
    outline = await findOutline(answer, report, s.lat, s.lon, { signal: s.ctrl.signal });
  } catch {
    return;
  }
  if (s !== spot || s.shown?.id !== id) return;
  s.shown.outline = outline;
  setBoundary(outline);
  renderAnswer(s);
  refreshAbout();
  if (outline && autoFit) {
    const [[w, south], [e, n]] = bboxOf(outline.geometry);
    const max = FIT_SPAN[answer.kind] || 0;
    if (e - w < max && n - south < max) fitTo([[w, south], [e, n]], { maxZoom: 16 });
  }
}

// ------------------------------------------------------------ rendering

function renderAnswer(s) {
  const { id, report, answer, outline } = s.shown;
  const via = id === 'auto' ? '' : `Source: ${SOURCE_INFO[id].label}`;
  if (answer.kind === 'none') {
    render({
      state: 'empty',
      eyebrow: 'No name here',
      title: id === 'zillow' ? 'Not in Zillow’s data' : 'Somewhere unnamed',
      note: report.note || 'None of this data has a name for this spot. Try another source with the ? button.',
      via,
    });
    return;
  }
  const gps = s.accuracy > 150 ? `Your location is approximate (±${Math.round(s.accuracy)} m). Drag the pin if it's off.` : '';
  const outlineNote =
    !outline || outline.isPrimary
      ? ''
      : outline.alias
        ? `Outline: Zillow's boundary, which it calls “${outline.name}”.`
        : `Outline shows ${outline.name}.`;
  const coords = answer.kind === 'water' ? formatCoords(s.lat, s.lon) : '';
  render({
    state: 'result',
    eyebrow: "You're in",
    tag: answer.tag,
    title: answer.title,
    broader: answer.broader.join(' · '),
    where: [answer.near && `near ${answer.near}`, answer.where].filter(Boolean).join(' · '),
    note: [coords, outlineNote, gps].filter(Boolean).join(' '),
    via,
  });
}

function render({ state, eyebrow, tag = '', title, broader = '', where = '', note = '', via = '' }) {
  els.card.dataset.state = state;
  els.eyebrow.textContent = eyebrow;
  setText(els.tag, tag);
  els.hood.textContent = title;
  setText(els.broader, broader ? `in ${broader}` : '');
  setText(els.where, where);
  setText(els.note, note);
  setText(els.via, via);
  els.actions.hidden = !['result', 'empty'].includes(state);
  els.why.hidden = !['result', 'empty', 'error'].includes(state);
}

function formatCoords(lat, lon) {
  return `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
}

function setText(el, text) {
  el.textContent = text;
  el.hidden = !text;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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

// ------------------------------------------- "why this name?" + sources

els.why.addEventListener('click', () => {
  if (!spot) return;
  buildSourceList();
  els.about.showModal();
  refreshAbout();
  compareAll(spot);
});
els.about.addEventListener('click', (e) => {
  if (e.target === els.about) els.about.close(); // tap on the backdrop
});

function buildSourceList() {
  els.sourceList.replaceChildren(
    ...SOURCE_IDS.map((id) => {
      const row = el('label', 'src');
      const input = el('input');
      input.type = 'radio';
      input.name = 'source';
      input.value = id;
      input.checked = id === sourceId;
      input.addEventListener('change', () => chooseSource(id));
      const says = el('span', 'src-says pending', '…');
      says.dataset.for = id;
      row.append(input, el('span', 'src-name', SOURCE_INFO[id].label), says, el('span', 'src-blurb', SOURCE_INFO[id].blurb));
      return row;
    }),
  );
}

/** Ask every source about this spot (each is polite and cached) and show what it says. */
function compareAll(s) {
  for (const id of SOURCE_IDS) {
    reportFor(s, id)
      .then((report) => {
        if (s !== spot) return;
        const a = answerFor(report);
        setSays(id, a.kind === 'none' ? '—' : a.title, a.kind === 'none' ? 'no answer' : a.tag);
      })
      .catch((err) => {
        if (s === spot && err.name !== 'AbortError') setSays(id, 'unavailable', '');
      });
  }
}

function setSays(id, text, small) {
  const node = els.sourceList.querySelector(`[data-for="${id}"]`);
  if (!node) return;
  node.classList.remove('pending');
  node.replaceChildren(document.createTextNode(text), ...(small ? [el('small', '', small)] : []));
}

function refreshAbout() {
  if (!els.about.open) return;
  for (const input of els.sourceList.querySelectorAll('input')) input.checked = input.value === sourceId;
  const shown = spot?.shown;
  if (!shown) {
    els.aboutTitle.textContent = 'Looking…';
    els.aboutWhy.replaceChildren();
    els.levels.replaceChildren();
    return;
  }
  const { answer, report, outline } = shown;
  els.aboutTitle.textContent = answer.kind === 'none' ? 'No name here' : `“${answer.title}”`;
  els.aboutWhy.replaceChildren(...explain(answer, report, { outline }).map((t) => el('p', '', t)));
  els.levels.replaceChildren(
    ...levelsOf(report).map((row) => {
      const li = el('li');
      const name = el('span', row.note.startsWith('skipped') ? 'skip' : '', row.name);
      if (row.note) name.append(el('span', 'why-note', row.note));
      li.append(el('span', 'lvl', row.label), name);
      return li;
    }),
  );
  if (!els.levels.children.length) els.levels.append(el('li', 'small', 'Nothing: this source has no data here.'));
}

function chooseSource(id) {
  sourceId = id;
  persistSource(id);
  if (spot) show(spot, id);
}

// ------------------------------------------------------------ location

function locate({ initial = false } = {}) {
  if (!('geolocation' in navigator)) {
    welcome("This browser can't share your location. Search an address or tap the map.");
    return;
  }
  els.locate.setAttribute('aria-busy', 'true');
  if (initial || !spot) {
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
      if (spot) toast(why);
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
    const results = await nominatim.search(q, { viewbox });
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
  if (!results.length) els.results.append(el('li', 'empty', emptyText));
  for (const r of results) {
    const btn = el('button', '', r.display_name);
    btn.type = 'button';
    btn.addEventListener('click', () => choose(r));
    const li = el('li');
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
  const a = spot?.shown?.answer;
  const text = a?.title ? `I'm in ${a.title}${a.kind === 'neighborhood' && spot.shown.report.settlement ? `, ${spot.shown.report.settlement.name}` : ''}` : 'What neighborhood is this?';
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
  get source() {
    return sourceId;
  },
  get answer() {
    return spot?.shown?.answer ?? null;
  },
  get report() {
    return spot?.shown?.report ?? null;
  },
  get boundary() {
    return boundaryData;
  },
};
