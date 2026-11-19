// The neighborhood names printed on the basemap.
//
// They are OpenStreetMap place points (place=neighbourhood / quarter / suburb)
// shipped inside OpenFreeMap's vector tiles, the same tiles the map draws, so
// reading them usually costs nothing extra (the browser already has them
// cached). We decode just the "place" layer and pick the label nearest the pin.
// Bigger areas count as a little closer, so a suburb label 140 m away
// ("Third Ward") beats a small neighbourhood label 570 m away.
import { distanceKm, looksLikeAdminCode, sameName } from './hood.js';
import { defaultLanguages } from './nominatim.js';

export const LABEL_ZOOM = 14; // the only zoom whose tiles carry neighbourhood-level labels
const WEIGHT = { neighbourhood: 1, quarter: 0.8, suburb: 0.6 };
const MAX_KM = { neighbourhood: 1.5, quarter: 2, suburb: 3 };
const EDGE_KM = 1; // also read the neighboring tile when the pin is this close to an edge

// --------------------------------------------------------------- tile math

/** Fractional tile coordinates of a point (Web Mercator). */
export function tileOf(lat, lon, z) {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * n, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n };
}

/** [lon, lat] of fractional tile coordinates. */
export function lonLatOf(tx, ty, z) {
  const n = 2 ** z;
  return [(tx / n) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI];
}

/** The tiles to read for a pin: its own, plus neighbors when it sits near an edge. */
export function tilesFor(lat, lon, z = LABEL_ZOOM) {
  const n = 2 ** z;
  const { x, y } = tileOf(lat, lon, z);
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  const tileKm = (40075 * Math.cos((lat * Math.PI) / 180)) / n;
  const dxs = [0];
  const dys = [0];
  if ((x - tx) * tileKm < EDGE_KM) dxs.push(-1);
  if ((tx + 1 - x) * tileKm < EDGE_KM) dxs.push(1);
  if ((y - ty) * tileKm < EDGE_KM) dys.push(-1);
  if ((ty + 1 - y) * tileKm < EDGE_KM) dys.push(1);
  return dxs
    .flatMap((dx) => dys.map((dy) => ({ z, x: (tx + dx + n) % n, y: ty + dy })))
    .filter((t) => t.y >= 0 && t.y < n);
}

// ------------------------------------------------- minimal vector tile reader

/**
 * Reads one layer of a Mapbox Vector Tile (protobuf): its features' type,
 * properties and point geometry. Just enough for labels; lines and polygons
 * are skipped. Spec: https://github.com/mapbox/vector-tile-spec
 */
export function readLayer(bytes, wanted) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const utf8 = new TextDecoder();
  let pos = 0;

  const varint = () => {
    let value = 0;
    let mul = 1;
    let b;
    do {
      b = buf[pos++];
      value += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return value;
  };
  const zigzag = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);
  const string = () => {
    const len = varint();
    const s = utf8.decode(buf.subarray(pos, pos + len));
    pos += len;
    return s;
  };
  const skip = (wire) => {
    if (wire === 0) varint();
    else if (wire === 1) pos += 8;
    else if (wire === 2) pos += varint();
    else if (wire === 5) pos += 4;
    else throw new Error(`Unsupported protobuf wire type ${wire}`);
  };
  const fields = (end, onField) => {
    while (pos < end) {
      const key = varint();
      if (!onField(Math.floor(key / 8), key & 7)) skip(key & 7);
    }
  };

  const value = (end) => {
    let v = null;
    fields(end, (field, wire) => {
      if (field === 1 && wire === 2) v = string();
      else if (field === 2 && wire === 5) (v = view.getFloat32(pos, true)), (pos += 4);
      else if (field === 3 && wire === 1) (v = view.getFloat64(pos, true)), (pos += 8);
      else if ((field === 4 || field === 5) && wire === 0) v = varint();
      else if (field === 6 && wire === 0) v = zigzag(varint());
      else if (field === 7 && wire === 0) v = varint() === 1;
      else return false;
      return true;
    });
    return v;
  };

  const feature = (end, layer) => {
    const f = { type: 0, properties: {}, points: [] };
    const geometry = [];
    fields(end, (field, wire) => {
      if (field === 2 && wire === 2) {
        const stop = varint() + pos;
        while (pos < stop) {
          const k = varint();
          const v = varint();
          f.properties[layer.keys[k]] = layer.values[v];
        }
      } else if (field === 3 && wire === 0) f.type = varint();
      else if (field === 4 && wire === 2) {
        const stop = varint() + pos;
        while (pos < stop) geometry.push(varint());
      } else return false;
      return true;
    });
    if (f.type === 1) {
      // POINT / MULTIPOINT: MoveTo(count) followed by count zigzag (dx, dy) pairs
      let x = 0;
      let y = 0;
      for (let i = 0; i < geometry.length; ) {
        const cmd = geometry[i++];
        if ((cmd & 7) !== 1) break;
        for (let c = cmd >> 3; c > 0; c--) {
          x += zigzag(geometry[i++]);
          y += zigzag(geometry[i++]);
          f.points.push([x, y]);
        }
      }
    }
    return f;
  };

  const layer = (end) => {
    const l = { name: '', extent: 4096, keys: [], values: [], features: [] };
    const ranges = [];
    fields(end, (field, wire) => {
      if (field === 1 && wire === 2) l.name = string();
      else if (field === 2 && wire === 2) {
        const len = varint();
        ranges.push([pos, pos + len]);
        pos += len;
      } else if (field === 3 && wire === 2) l.keys.push(string());
      else if (field === 4 && wire === 2) l.values.push(value(varint() + pos));
      else if (field === 5 && wire === 0) l.extent = varint();
      else return false;
      return true;
    });
    if (l.name === wanted) {
      for (const [start, stop] of ranges) {
        pos = start;
        l.features.push(feature(stop, l));
      }
    }
    pos = end;
    return l;
  };

  while (pos < buf.length) {
    const key = varint();
    if (Math.floor(key / 8) === 3 && (key & 7) === 2) {
      const end = varint() + pos;
      const l = layer(end);
      if (l.name === wanted) return l;
    } else skip(key & 7);
  }
  return null;
}

/** Place points of a decoded tile as {cls, props, lon, lat}. */
export function placesInTile(bytes, { x, y, z }) {
  const layer = readLayer(bytes, 'place');
  if (!layer) return [];
  return layer.features
    .filter((f) => f.type === 1 && f.points.length)
    .map((f) => {
      const [px, py] = f.points[0];
      const [lon, lat] = lonLatOf(x + px / layer.extent, y + py / layer.extent, z);
      return { cls: f.properties.class, props: f.properties, lon, lat };
    });
}

// ------------------------------------------------------------ picking names

/** The label text in the viewer's language when the map has it. */
export function labelName(props, lang = 'en') {
  return (
    props[`name:${lang}`] ||
    (lang === 'en' && (props['name:en'] || props.name_en)) ||
    props.name ||
    props['name:latin'] ||
    null
  );
}

/** Neighborhood-level labels near a point, best first. */
export function rankLabels(places, lat, lon, lang = 'en') {
  const seen = new Set();
  return places
    .filter((p) => WEIGHT[p.cls] !== undefined)
    .map((p) => ({ name: labelName(p.props, lang), cls: p.cls, km: distanceKm(lat, lon, p.lat, p.lon) }))
    .filter((p) => p.name && p.km <= MAX_KM[p.cls] && !looksLikeAdminCode(p.name))
    .map((p) => ({ ...p, score: p.km * WEIGHT[p.cls] }))
    .sort((a, b) => a.score - b.score)
    .filter((p) => {
      const key = p.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** The label to name the spot by, plus the nearest larger area (a suburb) around it. */
export function pickLabels(ranked = []) {
  const primary = ranked[0] || null;
  if (!primary) return { primary: null, broader: [] };
  const around = primary.cls === 'suburb' ? null : ranked.find((p) => p.cls === 'suburb' && !sameName(p.name, primary.name));
  return { primary, broader: around ? [around] : [] };
}

// ------------------------------------------------------------------ source

export function createLabelSource({
  tilejsonUrl = 'https://tiles.openfreemap.org/planet',
  fetchImpl = (...a) => globalThis.fetch(...a),
  languages = defaultLanguages,
} = {}) {
  let template = null;
  const tiles = new Map();

  const tileUrl = async (t) => {
    template ||= fetchImpl(tilejsonUrl)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`TileJSON HTTP ${r.status}`))))
      .then((tj) => tj.tiles[0])
      .catch((err) => {
        template = null;
        throw err;
      });
    return (await template).replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
  };

  const places = (t) => {
    const key = `${t.z}/${t.x}/${t.y}`;
    if (!tiles.has(key)) {
      const job = (async () => {
        const res = await fetchImpl(await tileUrl(t));
        if (res.status === 204 || res.status === 404) return []; // empty tile (open sea)
        if (!res.ok) throw new Error(`tile HTTP ${res.status}`);
        let bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
          // still gzipped (served without Content-Encoding): unzip it here
          bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
        }
        return placesInTile(bytes, t);
      })();
      tiles.set(key, job);
      job.catch(() => tiles.delete(key));
      if (tiles.size > 40) tiles.delete(tiles.keys().next().value);
    }
    return tiles.get(key);
  };

  return {
    id: 'labels',
    /** Neighborhood-level labels near the point, best first ({name, cls, km, score}). */
    async nearby(lat, lon) {
      const lang = languages().split(',')[0].slice(0, 2).toLowerCase();
      const found = await Promise.all(tilesFor(lat, lon).map(places));
      return rankLabels(found.flat(), lat, lon, lang);
    },
  };
}
