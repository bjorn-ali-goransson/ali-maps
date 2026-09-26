// Ali Maps in the browser: draws, and routes, with no server behind it.
//
// Two flavours, and the difference between them is the whole reason the page
// says which one is on screen:
//
// * **corpus** — three districts of Riyadh, every road found by detection.
//   No imported network at any stage. Sparse, and the sparseness is honest.
// * **osm** — Riyadh from OpenStreetMap, cut into the same straight-carriageway
//   model by `services/maps/osm_model.py`. A **tech demo**: it exists to
//   exercise this app at city scale, and CLAUDE.md is unambiguous that it may
//   never be a reference for anything the corpus claims. The badge saying so
//   cannot be hidden, not even by the embed.
//
// **Routing is ADR 0004's, not a new one.** The coarse arterial level *plans*
// and the plan's only job is to say which fine tiles to fetch; the answer is
// always a fine-level route. That engine lives in `web/src/engine` and is
// compiled here rather than reimplemented — writing the A* twice is how the
// phone and the browser come to disagree about a route for no visible reason.
//
// **The corpus has no road classes**, so its arterial tier is empty by
// construction and every corpus route takes the engine's fallback path. That
// is correct rather than broken: nothing in the imagery pipeline measures a
// road class and none may be invented.

import { readDrawTile } from './alimap.js';
import { TileStore } from './engine/store.js';
import { route as planAndRoute, Subgraph } from './engine/router.js';
import { tileOf, metres } from './engine/tiles.js';

// ------------------------------------------------------------------ options
//
//   ?f=corpus|osm       which flavour
//   ?embed=1            hide the chrome, keep the attribution and the badge
//   ?lat=&lon=&z=       open on a place, z in metres across the view
//   ?from=lat,lon &to=  show a route straight away
//   ?k=                 how many distinct roads a snap may try
const Q = new URLSearchParams(location.search);

/**
 * Where the page's own files and the map data live.
 *
 * An embed endpoint sits two or three directories down (`/embed/v1/place/`),
 * so every fetch has to be relative to the site root rather than to the page.
 * And the data root is separate from the site root on purpose: the HTML can be
 * served from GitHub Pages while the tiles come from R2, which needs nothing
 * more than these two strings pointing at different origins.
 */
const ROOT = window.ALIMAPS_ROOT || './';
const DATA = (window.ALIMAPS_DATA || Q.get('data') || ROOT).replace(/\/?$/, '/');
// ------------------------------------------------------------- the embed API
//
// Ali: "I want to be able to embed this web app through the same mechanisms
// that Google Maps uses in an equivalent way."
//
// So the URL shape is theirs:
//
//     /embed/v1/<mode>?<parameters>
//
// with the same five modes and the same parameter names wherever we have the
// thing they name. The point is that somebody who has embedded a Google map
// can change the host and the path and keep the rest.
//
//   view        center, zoom, maptype
//   place       q, center, zoom, maptype
//   directions  origin, destination, mode, avoid
//   search      q, center, zoom
//   streetview  location, heading, pitch, fov
//
// **Where we differ, we differ loudly rather than silently.**
//
// * `key` is accepted and ignored. There is no quota to meter and no account
//   to bill, so requiring one would be theatre. A pasted Google snippet keeps
//   working with it left in.
// * `maptype=satellite` is **refused**, not ignored. Our imagery is licensed
//   for internal review only (`docs/ali-maps.md`), so there is no satellite
//   layer to switch to, and quietly showing roads to somebody who asked for
//   satellite is the kind of silence this project keeps trying to remove.
// * `q`, `origin` and `destination` take `lat,lon` always, and a street name
//   where we have street names -- which is the OSM flavour only, because no
//   street name has ever been invented in the corpus.
// * `zoom` is a slippy zoom level as Google's is. Our own `z` (metres across
//   the view) still works and wins when both are given.

/** The five modes, from `/embed/v1/<mode>` anywhere in the path. */
const EMBED_MODE = (() => {
  const m = location.pathname.match(
    /\/embed\/v1\/(view|place|directions|search|streetview)(?:\/|\.html|$)/);
  return m ? m[1] : null;
})();

const EMBED = EMBED_MODE !== null || Q.get('embed') === '1' || (() => {
  // Framed by somebody else counts as embedded even without the flag, so a
  // bare <iframe src="..."> still looks deliberate.
  try { return window.self !== window.top; } catch { return true; }
})();
if (EMBED) document.body.classList.add('embed');

/** `lat,lon` -> `[lon, lat]`, or null if it is not a coordinate. */
function parseLatLon(v) {
  if (!v) return null;
  const m = String(v).trim().match(
    /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}

/** A slippy zoom level to metres per pixel at this latitude. */
function zoomToMpp(z, lat) {
  return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);
}

/**
 * Everything the embed parameters ask for, resolved into our own terms.
 *
 * Returned rather than applied, so the caller can apply it once the flavour is
 * loaded and the page knows how big it is.
 */
function embedIntent() {
  if (!EMBED_MODE) return null;
  const out = { mode: EMBED_MODE, warnings: [] };

  const maptype = (Q.get('maptype') || 'roadmap').toLowerCase();
  if (maptype === 'satellite' || maptype === 'hybrid') {
    out.warnings.push(
      'Satellite imagery is not available: our imagery licence is internal '
      + 'review only. Showing the road map.');
  }
  if (Q.get('key')) out.ignored = 'key';

  const zoom = parseFloat(Q.get('zoom'));
  if (Number.isFinite(zoom)) out.zoom = Math.max(1, Math.min(22, zoom));

  const centre = parseLatLon(Q.get('center'));
  if (centre) out.centre = centre;

  if (EMBED_MODE === 'directions') {
    out.from = parseLatLon(Q.get('origin'));
    out.to = parseLatLon(Q.get('destination'));
    out.fromText = out.from ? null : Q.get('origin');
    out.toText = out.to ? null : Q.get('destination');
    const m = (Q.get('mode') || 'driving').toLowerCase();
    if (m !== 'driving') {
      out.warnings.push(
        `Only driving directions exist here: nothing in this corpus has ever `
        + `measured a walking, cycling or transit network. Showing driving.`);
    }
    if (Q.get('avoid')) {
      out.warnings.push(
        'Avoidances are not modelled: there are no tolls, ferries or '
        + 'motorway flags in this road model.');
    }
  } else if (EMBED_MODE === 'streetview') {
    out.location = parseLatLon(Q.get('location'));
    const heading = parseFloat(Q.get('heading'));
    if (Number.isFinite(heading)) out.heading = heading;
    const pitch = parseFloat(Q.get('pitch'));
    if (Number.isFinite(pitch)) out.pitch = Math.max(-38, Math.min(38, pitch));
    const fov = parseFloat(Q.get('fov'));
    if (Number.isFinite(fov)) out.fov = Math.max(20, Math.min(120, fov));
  } else {
    const q = Q.get('q');
    out.point = parseLatLon(q);
    out.text = out.point ? null : q;
  }
  return out;
}

const INTENT = embedIntent();

// **k stays at 1 unless somebody asks.** E357 measured 22.2 of An Narjis's
// 24.5 missing routability points as the app trying only one node, and E354
// measured the cost: rescued journeys walk p50 46 m and p90 102 m. Past some
// distance "there is a route" is the worse answer, and that distance is Ali's
// to set — so the page offers the retry rather than taking it silently.
const K_DEFAULT = Math.max(1, parseInt(Q.get('k') || '1', 10) || 1);

/**
 * Half-width of the fine-tile square fetched around each end of a journey.
 *
 * ADR 0004 measured the corridor and then said of this: "5x5 is currently an
 * untested guess rather than a measurement." `?endBlocks=` exists so it can
 * stop being one.
 */
const END_BLOCKS = Math.max(0,
  parseInt(Q.get('endBlocks') ?? '2', 10) || 0);

const cv = document.getElementById('map');
const ctx = cv.getContext('2d');
const $ = (id) => document.getElementById(id);
let DPR = Math.min(devicePixelRatio || 1, 2);

const state = {
  flavour: null,
  areas: [],            // {dir, title, bounds, index, tiles:Map, overview, store}
  bounds: null,
  from: null,
  to: null,
  route: null,
  steps: [],
  unreached: [],        // road we can draw but cannot route on
  hover: null,          // the step the pointer is over
  me: null,
  k: K_DEFAULT,
};

// --------------------------------------------------------------- viewport
let scale = 1, ox = 0, oy = 0;
let LAT0 = 24.71, KX = Math.cos(LAT0 * Math.PI / 180);

const sx = (lon) => lon * KX * scale + ox;
const sy = (lat) => -lat * scale + oy;
const lonAt = (px) => (px - ox) / (KX * scale);
const latAt = (py) => (oy - py) / scale;
const mpp = () => 111132 / scale;

/**
 * Which compass direction is at the top of the screen, in radians.
 *
 * **`sx`/`sy` stay NORTH-UP and the rotation is a canvas transform.** The
 * alternative -- projecting straight to final screen pixels -- means every
 * one of them takes both a longitude and a latitude, because a rotation mixes
 * the axes, and every call site in the file changes. Rotating the context
 * instead leaves the roads, the route, the highlight and the blips drawing
 * exactly as they did, and confines the problem to four places: what a
 * pointer means, what is on screen, how big a scene buffer has to be, and the
 * handful of things that must stay upright while the map turns.
 */
let heading = 0;

/**
 * How far a two-finger gesture must twist before the map starts turning.
 *
 * **Without a threshold every pinch is also a rotation.** Two fingers never
 * scale along a perfectly fixed line, and a few degrees of wobble on a zoom
 * leaves the map off north with nothing to say why -- which is the failure
 * that makes people distrust a rotating map. Eight degrees is past the wobble
 * and well under a deliberate turn, and once the gesture has crossed it the
 * rotation tracks from where it crossed, so the map does not jump.
 */
const TWIST_SLOP = 8 * Math.PI / 180;

/** Half the viewport, which is what the map turns about. */
const viewCx = () => cv.width / DPR / 2;
const viewCy = () => cv.height / DPR / 2;

/** Screen pixels to north-up pixels: what the eye sees, back to what we store. */
function unrot(x, y) {
  if (!heading) return [x, y];
  const cx = viewCx(), cy = viewCy();
  const c = Math.cos(heading), sn = Math.sin(heading);
  const dx = x - cx, dy = y - cy;
  return [cx + dx * c - dy * sn, cy + dx * sn + dy * c];
}

/** North-up pixels to screen pixels. The inverse, for things drawn upright. */
function rot(x, y) {
  if (!heading) return [x, y];
  const cx = viewCx(), cy = viewCy();
  const c = Math.cos(heading), sn = Math.sin(heading);
  const dx = x - cx, dy = y - cy;
  return [cx + dx * c + dy * sn, cy - dx * sn + dy * c];
}

/** Turn the context so that north-up drawing lands the way the map is held. */
function mapIn(g = ctx) {
  g.save();
  if (heading) {
    g.translate(viewCx(), viewCy());
    g.rotate(-heading);
    g.translate(-viewCx(), -viewCy());
  }
}
const mapOut = (g = ctx) => g.restore();

/**
 * The north-up rectangle the rotated viewport needs, as `{x0,y0,x1,y1}`.
 *
 * Turned 45 degrees a square viewport reaches out to its own diagonal, so
 * "the corners of the screen" is no longer the same rectangle as "the ground
 * on screen", and every consumer that asked for tiles by the screen's corners
 * would quietly stop fetching the ones in the four triangles.
 */
function viewBox() {
  const w = cv.width / DPR, h = cv.height / DPR;
  if (!heading) return { x0: 0, y0: 0, x1: w, y1: h };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]]) {
    const [ux, uy] = unrot(x, y);
    x0 = Math.min(x0, ux); y0 = Math.min(y0, uy);
    x1 = Math.max(x1, ux); y1 = Math.max(y1, uy);
  }
  return { x0, y0, x1, y1 };
}

function fit(b = state.bounds) {
  if (!b) return;
  const w = cv.width / DPR, h = cv.height / DPR;
  // **A hash beats a fit and loses to an explicit query.** It is what the
  // address bar is showing, so reloading the page has to land where the page
  // said it was -- but `?lat=&lon=` is somebody deliberately asking for a
  // place, and an embed's URL must not be overridden by a leftover fragment.
  if (!Q.get('lat') && !Q.get('from') && applyHash()) { draw(); showWhere(); return; }
  const qlat = parseFloat(Q.get('lat')), qlon = parseFloat(Q.get('lon'));
  if (Number.isFinite(qlat) && Number.isFinite(qlon)) {
    const acrossM = Math.max(60, parseFloat(Q.get('z')) || 600);
    scale = (h / acrossM) * 111132;
    ox = w / 2 - qlon * KX * scale;
    oy = h / 2 + qlat * scale;
    draw();
    return;
  }
  const bw = (b[2] - b[0]) * KX, bh = b[3] - b[1];
  scale = Math.min(w / Math.max(bw, 1e-9), h / Math.max(bh, 1e-9)) * 0.92;
  ox = w / 2 - ((b[0] + b[2]) / 2) * KX * scale;
  oy = h / 2 + ((b[1] + b[3]) / 2) * scale;
  draw();
}

// The canvas is laid out by CSS (`position: fixed; inset: 0`) and only its
// BACKING STORE is set here. An earlier version also wrote `style.width` in
// pixels, which pins the element to the size the window had when the handler
// last ran — so between a window growing and the resize event arriving, the
// page showed a band of background down two sides.
let sized = false;
function resize() {
  // `innerWidth`/`innerHeight`, NOT `clientWidth`. A canvas with no CSS
  // applied yet is 300x150 by specification, and a module script can run
  // before the stylesheet has landed — so reading the element's own size gave
  // a 300x150 backing store, a map painted into one corner, and a `?z=` zoom
  // computed against a 146-pixel-high viewport.
  // The element's own box, which CSS now pins to the viewport. `innerWidth`
  // would do as well but this cannot drift from what is on screen.
  const w = cv.clientWidth || innerWidth;
  const h = cv.clientHeight || innerHeight;
  // Hold the view still across a resize. Refitting here would throw away the
  // framing of a route somebody is reading the moment their phone rotates.
  const keep = sized
    ? { lon: lonAt((cv.width / DPR) / 2), lat: latAt((cv.height / DPR) / 2) }
    : null;
  DPR = Math.min(devicePixelRatio || 1, 2);
  cv.width = Math.floor(w * DPR);
  cv.height = Math.floor(h * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (keep) {
    ox = w / 2 - keep.lon * KX * scale;
    oy = h / 2 + keep.lat * scale;
    draw();
  } else {
    fit();
  }
  sized = true;
}

// ------------------------------------------------------------ drawn tiles
//
// Three levels. The coarsest is a single file per area rather than tiles,
// because at the fitted view of a whole city every tile is on screen and 97
// round trips to paint the first frame is a spinner where one fetch is a map.

function levelFor(area) {
  const m = mpp();
  const sw = area.index.switchMpp || [2, 12];
  if (m > sw[1]) return area.index.levels.find(l => !l.tiled);
  if (m > sw[0]) return area.index.levels.find(l => l.name === 'mid')
    || area.index.levels[0];
  return area.index.levels[0];
}

/**
 * The line groups to draw for this area right now, and nothing asynchronous
 * about it.
 *
 * An earlier version awaited a promise and stored the result in a per-level
 * cache. For the single-file overview that worked, because the promise
 * resolved with the data; for the TILED levels it returned only what was
 * already in hand — an empty list on the first pass — and the fetches that
 * followed updated the tile map that nothing read again. The city view drew
 * and every closer view was blank.
 *
 * So the painter asks for what exists, this schedules whatever is missing,
 * and an arriving tile simply asks for another frame.
 */
function visibleGroups(area, level) {
  if (!level.tiled) {
    if (area.overview === undefined) {
      area.overview = null;                     // in flight; do not ask twice
      fetch(`${area.base}/overview.alimap`)
        .then(r => (r.ok ? r.arrayBuffer() : null))
        .then(b => { if (b) area.overview = readDrawTile(b).lines; invalidate(); })
        .catch(() => {});
    }
    return area.overview ? [area.overview] : [];
  }
  const z = area.index.zoom;
  const v = viewBox();
  const [tx0, ty0] = tileOf(lonAt(v.x0), latAt(v.y0), z);
  const [tx1, ty1] = tileOf(lonAt(v.x1), latAt(v.y1), z);
  const out = [];
  // What the view is using, so the eviction pass cannot take it away.
  // `paintFrame` empties it once a frame and every level in play adds to it,
  // because a blend draws two of them and both are on screen.
  const keep = area.onScreen || (area.onScreen = new Set());
  for (const [x, y] of area.index.tiles) {
    if (x < tx0 - 1 || x > tx1 + 1 || y < ty0 - 1 || y > ty1 + 1) continue;
    const key = `${x}_${y}${level.suffix}`;
    keep.add(key);
    const hit = area.tiles.get(key);
    if (hit) {
      // Refresh recency. A Map keeps insertion order, so deleting and
      // re-setting is the whole of the LRU.
      area.tiles.delete(key);
      area.tiles.set(key, hit);
      out.push(hit);
      continue;
    }
    if (area.pending.has(key)) continue;
    area.pending.add(key);
    fetch(`${area.base}/${key}.alimap`)
      .then(r => (r.ok ? r.arrayBuffer() : null))
      .then(b => {
        if (!b) return;
        area.tiles.set(key, readDrawTile(b).lines);
        while (area.tiles.size > MAX_DECODED_TILES) {
          // Never the one just decoded, and never one the view is using.
          const oldest = [...area.tiles.keys()]
            .find((k) => k !== key && !area.onScreen.has(k));
          if (oldest === undefined) break;
          area.tiles.delete(oldest);
          rasterStats.evicted++;
        }
        invalidate();
      })
      .catch(() => {})
      .finally(() => area.pending.delete(key));
  }
  // While a closer level is still arriving, keep showing the coarser one
  // rather than blanking the map under somebody's finger.
  if (!out.length && area.overview) return [area.overview];
  return out;
}

// ------------------------------------------------------------------ drawing

// **The road network is static; the view is not.** Ali: "the thousands of
// static vertices do not need to be re-rendered every time ... render to
// bitmaps, and then render them at different zoom levels."
//
// So a **scene** is one fidelity level, rasterised once into an offscreen
// canvas larger than the window. A pan inside that margin is a single
// `drawImage`; a zoom is the same bitmap scaled, which is not an
// approximation of the geometry because road width is in METRES and scales
// exactly as it should. Only the kerb is in pixels, so a scene is redrawn
// when the scale has drifted far enough for that to show.
//
// **Levels cross-fade rather than switch**, which is the rest of what Ali
// asked for:
//
//   "can we have a span of zoom ... then we will fade between the low/high
//    fidelity in a way that the opacity is a function of the zoom level"
//
// Inside the span the blend tracks the finger, so the transition is something
// you drive rather than something that happens to you. And:
//
//   "if I zoom aggressively above or below the zoom threshold, and the tiles
//    are not already rasterized, then there will obviously be a delay and
//    zoom must commence without changing fidelity. then, we should fade
//    slowly ... without need for zooming to fade"
//
// So rasterising a level never blocks a frame: it runs in slices of a few
// milliseconds across successive frames, the zoom carries on against whatever
// is already drawn, and when the new level finishes it fades in over three
// seconds on a clock of its own. Crossing the threshold is what *starts* the
// work, not what waits for it.
//
// **Sliced on the main thread rather than in a worker.** A worker would need
// the tiles decoded on its own side — four hundred thousand polylines is not
// something to post across a boundary each time the view moves — so it would
// mean the worker owning fetching and decoding too. Time-slicing gets the
// same thing that actually matters, which is that no single frame does more
// than a few milliseconds of work, without a second copy of the tile store.

/** How much bigger than the window a scene is, each side, as a fraction. */
const SCENE_MARGIN = 0.25;

/** Milliseconds of rasterising allowed per frame, across ALL levels.
 *
 * Ali: "when these zoom thresholds are hit, the whole browser almost hangs ...
 * perhaps we are bursting all in parallel."
 *
 * That was it. Inside a blend span two levels want rasterising at once, and
 * each was given its own budget — so a 7 ms slice became 14 ms of work plus
 * the blits, every frame, for as long as it took. The budget is now shared
 * and **one level is rasterised at a time**: the map is showing something
 * already, so finishing one level sooner is strictly better than advancing
 * two halfway.
 */
let SLICE_MS = 6;

/**
 * ...and this much while a finger or a wheel is still moving.
 *
 * Ali: "right now though i dont see ANY partial rendering which makes me
 * wonder." Quite right, and it was not subtle: a continuous wheel keeps
 * `gesturing` true and the old rule refused every rebuild until it stopped,
 * so a measured thirty-notch zoom produced **zero** rasterisations while it
 * was happening and one after. Work happens during the gesture now, on a
 * smaller slice so the wheel still turns smoothly.
 */
let SLICE_GESTURE_MS = 3;

/** Give the main thread a whole frame off after one this long. */
let OVERRUN_MS = 22;

/**
 * How far ahead of the wheel to look, in seconds.
 *
 * Ali: "we can see the users intent when he starts to zoom and prefetch and
 * prerender BEFORE we need them." The wheel's own velocity says where the
 * view is going; rasterising that level while the zoom is still travelling
 * means it is ready on arrival rather than started there.
 */
let PREDICT_S = 0.45;

/**
 * How many decoded drawing tiles to keep, across all levels of one area.
 *
 * Ali: "we should not keep everything in memory I guess."
 *
 * Quite right, and until this existed nothing was ever dropped. A decoded
 * `LPM3` tile is a Float64Array of every vertex plus a small object per road,
 * so Riyadh's fine level alone is 97 tiles of roughly 4,000 roads — tens of
 * megabytes that a pan across the city would accumulate and never release.
 *
 * Sixty is comfortably more than any one view needs (nine z12 tiles at the
 * closest level, plus the coarser levels' share) and small enough that the
 * ceiling is a few tens of megabytes rather than unbounded.
 */
/**
 * How many decoded drawing tiles to hold, and the rule that matters more.
 *
 * **A tile that is on screen is never evicted.** Ali, at z11.49: "on this
 * zoom level, some tiles are flickering on and off." Measured at that exact
 * view: 97 tiles in sight, a cache of 60, **1,074 evictions and 1,066
 * refetches**, 765 of them from six small pans. The LRU was throwing away
 * tiles the very next frame needed, fetching them again, and throwing away
 * others to make room -- so the map flickered in proportion to how much of
 * the city was visible, which is why it only showed up zoomed out.
 *
 * A cache smaller than the working set is not a cache, it is a queue. The
 * count is raised past the biggest working set any level actually has, and
 * the eviction pass is told what is visible so that even an undersized cache
 * degrades into "hold the screen, drop the rest" rather than into thrash.
 *
 * The coarse levels are what a whole-city view uses and they are small: the
 * `wide` set is 660 kB over 97 tiles for Riyadh, against `fine`'s 9.1 MB --
 * and at a fine zoom four tiles are in view, not ninety-seven. So the
 * worst case here is a few megabytes, not a multiple of the old one.
 */
const MAX_DECODED_TILES = 320;

/**
 * Scene canvases are the other half of the memory, and much the bigger half.
 *
 * Each is the viewport plus a 25% margin each side, at device pixels: on a
 * 1440x840 screen at DPR 2 that is about 30 MB apiece. Three levels holding a
 * front, a back and a spare each would be a quarter of a gigabyte, so a level
 * nothing is showing or fading to gives its buffers back.
 */
const KEEP_SCENES = 2;

/** Half-width of the cross-fade, in zoom levels (log2 of metres per pixel). */
const BLEND_HALF = 0.5;

/** How long a level takes to fade in when the span was skipped. */
const FADE_MS = 3000;

/** Re-rasterise once the blit has been stretched by more than this. */
const RESCALE_AT = 1.35;

/**
 * ...and this much while a gesture is still running.
 *
 * Ali: "i dont think the fade is working correctly at close zoom ... it seems
 * the debounce is blocking the fade from happening as it only fades once i
 * stop the mouse from zooming."
 *
 * Exactly that, though it was the rescale threshold rather than the debounce.
 * A continuous wheel keeps `gesturing` true, and a scene that had drifted past
 * 1.35x was then refused a rebuild until the wheel stopped -- so one of the two
 * levels the blend needs had no buffer, the blend could not run, and the fade
 * only appeared on settling. A blit stretched 2.5x is soft at the kerb and
 * perfectly good to cross-fade against, so while the view is moving the
 * tolerance opens up and the crisp redraw waits for the pause.
 */
const RESCALE_AT_GESTURE = 2.5;

/**
 * Spans, so "it gets really slow sometimes" becomes a number.
 *
 * Ali: "can you optimize CPU usage by somehow getting telemetry / spans from
 * the code? when zooming it gets really slow sometimes."
 *
 * Every span is also a `performance.measure`, so Chrome's own profiler shows
 * them on the timeline beside the frames they belong to -- and the ring buffer
 * here means the answer is available without opening a profiler at all:
 * `__alimaps.spans()` gives the count, total and worst of each kind, and
 * `__alimaps.slow()` the individual offenders.
 */
const SPAN_KEEP = 400;
const spanLog = [];
let pendingAsync = false;

function span(name, fn) {
  const t0 = performance.now();
  try {
    const out = fn();
    // **An async `fn` finishes long after it returns.** Timing only the
    // synchronous part reported a 985 ms route as 0.3 ms, which is the sort
    // of number that makes a real problem invisible.
    if (out && typeof out.then === 'function') {
      pendingAsync = true;
      return out.finally(() => {
        const ms = performance.now() - t0;
        spanLog.push({ name, ms, at: t0 });
        if (spanLog.length > SPAN_KEEP) spanLog.shift();
      });
    }
    return out;
  } finally {
    const ms = performance.now() - t0;
    if (!pendingAsync) {
      spanLog.push({ name, ms, at: t0 });
      if (spanLog.length > SPAN_KEEP) spanLog.shift();
    }
    pendingAsync = false;
    // A measure costs about a microsecond and makes the span visible in the
    // Performance panel, where the surrounding frame is also visible.
    try { performance.measure(`alimaps:${name}`, { start: t0, duration: ms }); }
    catch (e) { /* older browsers take a different signature; not load heading */ }
  }
}

function spanSummary() {
  const by = new Map();
  for (const s of spanLog) {
    let r = by.get(s.name);
    if (!r) by.set(s.name, (r = { name: s.name, n: 0, total: 0, worst: 0 }));
    r.n++;
    r.total += s.ms;
    r.worst = Math.max(r.worst, s.ms);
  }
  return [...by.values()]
    .map((r) => ({ ...r, total: +r.total.toFixed(1), worst: +r.worst.toFixed(1),
                   mean: +(r.total / r.n).toFixed(2) }))
    .sort((a, b) => b.total - a.total);
}

// ------------------------------------------------------- one map, one source
//
// **The pre-rendered tileset is gone.** Ali: "delete the prerendered tileset
// please, for now its not working. its splitting our focus for now."
//
// It was an experiment with a clear question -- is one `drawImage` per tile
// cheaper than ninety thousand paths? -- and it answered it. What it could
// not do was stay honest: the ladder, the palettes and the widths all had to
// be expressed twice, in the builder and in the renderer, and the two drifted
// every time either moved. The raster/vector mismatch Ali reported was
// exactly that drift, and fixing it once did not stop it happening again.
//
// A second copy of the map that has to be kept in step with the first is a
// second map. `services/maps/rastertiles.py` and its output are deleted.

/** The slippy zoom this view is at. */
function slippyZoom() {
  return Math.log2(156543.03392 * Math.cos(LAT0 * Math.PI / 180) / mpp());
}

const lon2tx = (lon, z) => (lon + 180) / 360 * 2 ** z;
const lat2ty = (lat, z) => {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z;
};
const tx2lon = (x, z) => x / 2 ** z * 360 - 180;
const ty2lat = (y, z) => {
  const n = Math.PI - 2 * Math.PI * y / 2 ** z;
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

/**
 * Where the zoom is heading, from how fast it is moving.
 *
 * Recorded on every wheel notch and pinch frame. `predictedScale` is what the
 * view would be at in `PREDICT_S` seconds if the hand kept doing what it is
 * doing -- a good enough guess to start the right level early, and a harmless
 * one to get wrong: the worst case is a scene rasterised for a zoom nobody
 * reaches, and the cancellation pass throws it away.
 */
const zoomIntent = { at: 0, scale: 0, vel: 0 };

function noteZoom() {
  const now = performance.now();
  if (zoomIntent.at && now > zoomIntent.at) {
    const dt = (now - zoomIntent.at) / 1000;
    if (dt > 0.008 && zoomIntent.scale > 0) {
      const v = Math.log2(scale / zoomIntent.scale) / dt;
      // Smoothed, or one jittery notch decides where the view is going.
      zoomIntent.vel = zoomIntent.vel * 0.6 + v * 0.4;
    }
  }
  zoomIntent.at = now;
  zoomIntent.scale = scale;
}

/** The scale the view is heading for, or the current one when it is still. */
function predictedScale() {
  const idle = performance.now() - zoomIntent.at;
  if (idle > 220 || !Number.isFinite(zoomIntent.vel)) return scale;
  const clamped = Math.max(-6, Math.min(6, zoomIntent.vel));
  return scale * Math.pow(2, clamped * PREDICT_S);
}

// ------------------------------------------------------ routing tile blips
//
// Ali: "show a radar blip on the tile that was just loaded, which should
// expand ... this way we can get away with longer loading times as the user
// will be engaged for longer."
//
// A cross-town route fetches fifty-odd routing tiles over a second or two and
// the map had nothing to say meanwhile. Each arrival pings where it landed.
// It is a readout rather than a decoration: every blip is a tile that really
// arrived, so watching it is watching the corridor being fetched.

/** How long a ping lives. */
const BLIP_RING_MS = 520;

/** Tiles that have landed recently. */
const blips = [];

/**
 * The artery the coarse plan found, pinged along its length.
 *
 * Ali: "i want them to emanate from the artery route first off." This is the
 * first thing there is to say: the plan exists before a single fine tile has
 * been asked for, and it is the reason every one of them is about to be
 * fetched. A wave running from the start of the journey to its end says both
 * "here is the way" and "this is what we are going to load", in the order
 * those two facts become true.
 *
 * Staggered by distance ALONG the line, not by index -- a planned route has
 * long motorway legs and short link roads, so pinging per point would crawl
 * through the junctions and jump across the motorways.
 */
const ARTERY_MS = 1100;

function noteArtery(line) {
  if (!line || line.length < 2) return;
  let total = 0;
  const at = [0];
  for (let i = 1; i < line.length; i++) {
    total += metresBetween(line[i - 1], line[i]);
    at.push(total);
  }
  if (total <= 0) return;
  const now = performance.now();
  // One ping every so many metres, capped, so a cross-city plan does not
  // become four hundred rings.
  const step = Math.max(total / 60, 250);
  let next = 0;
  for (let i = 0; i < line.length; i++) {
    if (at[i] < next && i !== line.length - 1) continue;
    next = at[i] + step;
    blips.push({ kind: 'artery', lon: line[i][0], lat: line[i][1],
                 t0: now + (at[i] / total) * ARTERY_MS });
  }
  draw();
}

/** A routing tile arrived. Remember where, so the map can show it. */
function noteTile(level, x, y, bytes, zoom, onRoute) {
  const n = 2 ** zoom;
  const lon0 = (x / n) * 360 - 180;
  const lon1 = ((x + 1) / n) * 360 - 180;
  const lat = (yy) => {
    const r = Math.PI - 2 * Math.PI * yy / n;
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(r) - Math.exp(-r)));
  };
  // **The journey's own tiles ping as they land; their neighbours wait.**
  // The corridor is the planned line plus everything within a couple of tiles
  // of each end, and those two are different claims: one is ground the route
  // crosses, the other is insurance in case the first and last few streets
  // are not on the plan. Showing them at once is what made fifty arrivals
  // read as one wave over ground nobody is driving through.
  blips.push({ kind: onRoute ? 'route' : 'near',
               w: lon0, e: lon1, n: lat(y), s: lat(y + 1),
               t0: performance.now() + (onRoute ? 0 : NEAR_DELAY_MS),
               bytes });
  if (blips.length > 200) blips.shift();
  draw();
}

/** How long a neighbouring tile waits behind the route's own. */
const NEAR_DELAY_MS = 420;

/**
 * The pings, and only the pings.
 *
 * Ali: "lets not give each tile a border when blipping. Just the blip is
 * fine." The lit rectangle it used to draw was also what made fifty arrivals
 * read as one wave washing over ground with nothing to do with the journey --
 * most of a corridor is the blocks around the two endpoints, which are
 * fetched and never driven.
 *
 * Returns true while any are alive, so the caller keeps asking for frames.
 */
function drawBlips() {
  if (!blips.length) return false;
  const now = performance.now();
  const W = cv.width / DPR, H = cv.height / DPR;
  let live = false;
  ctx.save();
  ctx.lineWidth = 2;
  for (let i = blips.length - 1; i >= 0; i--) {
    const b = blips[i];
    const age = now - b.t0;
    // A ping scheduled for later is not dead, it has not started.
    if (age < 0) { live = true; continue; }
    if (age > BLIP_RING_MS) { blips.splice(i, 1); continue; }
    live = true;
    let cx, cy, span;
    if (b.kind === 'artery') {
      cx = sx(b.lon); cy = sy(b.lat);
      // The plan is drawn at a size the eye reads as "a place on the route",
      // not as a tile: it is not a tile, and pretending otherwise would be
      // the 5 x 5 mistake in another costume.
      span = 34;
    } else {
      const L = sx(b.w), R = sx(b.e), Tp = sy(b.n), B = sy(b.s);
      cx = (L + R) / 2; cy = (Tp + B) / 2;
      // Half the tile's WIDTH, not its diagonal: a ring reaching the corners
      // overlaps its neighbours and the pings merge into a front.
      span = Math.abs(R - L);
    }
    if (cx < -60 || cx > W + 60 || cy < -60 || cy > H + 60) continue;
    const t = age / BLIP_RING_MS;
    const r = ease(t) * (span / 2);
    // Three weights, because the three mean three different things: the plan
    // is the brightest, a tile on it is next, a neighbour is a whisper.
    const strength = b.kind === 'artery' ? 1 : b.kind === 'route' ? 0.85 : 0.4;
    ctx.globalAlpha = (1 - t) * strength;
    ctx.strokeStyle = b.kind === 'artery' ? T.route : T.blip;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  return live;
}

/** Bumped when new tiles land, so a scene knows its content is stale. */
let dataEpoch = 0;

/** Cubic in-out. Ali: "all fading should have easing". */
const ease = (t) => (t < 0.5
  ? 4 * t * t * t
  : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Which level or pair of levels this zoom calls for.
 *
 * Returns `{a, b, t}` where `t` is how far across the blend we are: 0 is pure
 * `a`, 1 is pure `b`, and `b` is null outside a span.
 */
function levelBlend(area, atScale) {
  const L = area.index.levels;
  const sw = area.index.switchMpp || [1.5, 9];
  const lz = Math.log2(atScale ? 111132 / atScale : mpp());
  for (let i = 0; i < sw.length && i + 1 < L.length; i++) {
    const c = Math.log2(sw[i]);
    if (lz <= c - BLEND_HALF) break;                 // finer than this span
    if (lz >= c + BLEND_HALF) continue;              // coarser; try the next
    return { a: L[i], b: L[i + 1],
             t: (lz - (c - BLEND_HALF)) / (2 * BLEND_HALF) };
  }
  // Outside every span: one level, chosen by the plain thresholds.
  let pick = L[0];
  for (let i = 0; i < sw.length && i + 1 < L.length; i++) {
    if (lz >= Math.log2(sw[i])) pick = L[i + 1];
  }
  return { a: pick, b: null, t: 0 };
}

/** One rasterised fidelity level, as a cache of tiles in world space.
 *
 * **Tiles, not a viewport-sized bitmap.** Ali: "I thought that we are using
 * rasterization as a kind of double buffering, which means that we render a
 * tile using the path data at a quite high resolution and don't re-render
 * that until the whole tile is discarded."
 *
 * What was there before was a double buffer per LEVEL, one bitmap the size of
 * the viewport plus a 25% margin, redrawn whenever the view left that margin.
 * It was right about zoom and wrong about pan, and the measurement says how
 * wrong: ten pans across five screens at 1.5 m/px cost **41 rasterisations
 * and 3,735 ms of drawing in 11.7 seconds of wall clock** -- a third of the
 * CPU spent redrawing ground it had already drawn, with the sharp map lagging
 * the finger by up to 461 ms. Nothing ever blocked, because the work is
 * sliced; it was simply wasted.
 *
 * A tile is drawn once and kept until it is evicted. Panning costs the strip
 * of new tiles and nothing else.
 *
 * **The reference scale is the octave ABOVE the display scale**, so
 * `scale / ref` is always in (0.5, 1] and a tile is only ever shrunk on
 * screen. The old scheme redrew every 1.35x and could magnify by 35% in
 * between, which is blur; this cannot magnify at all.
 *
 * **A missing tile falls back to its own ancestor**, the coarser octave that
 * contains it, blitted from the matching sub-rectangle. That is what stops a
 * hole appearing at the edge of a pan or in the middle of a zoom out, and it
 * is why the cache does not need a margin.
 */
const TILE_CSS = 384;

/** How far a tile fades in on its own, when it arrives during a pan. */
const TILE_FADE_MS = 200;

/**
 * And how long a whole level takes when it arrives after a zoom.
 *
 * Long enough that no single frame moves the picture much. At 260 ms the
 * worst frame of the dissolve moved the ink by 23%; the cost of a longer one
 * is only that a sharper tile set arrives a little later, and nothing is
 * waiting on it -- the old octave is a complete picture of the same place.
 */
const LEVEL_FADE_MS = 420;

/** How many octaves up to look for a stand-in before giving up. */
const FALLBACK_OCTAVES = 4;

/** Canvas the cache may hold. A tile is TILE_CSS^2 x DPR^2 x 4 bytes. */
const RT_MAX_BYTES = 110e6;

const rt = new Map();               // key -> {canvas, ctx, done, t0, bytes, ...}
let rtBytes = 0;

/**
 * Which octave each level is SHOWING, and the fade running into it.
 *
 * The distinction Ali drew, and it is the whole of the fade policy: "when
 * zooming, we should be rendering async and only start fading in when we have
 * all the tiles necessary ... But when panning, that is not necessary. And
 * it's not good actually, because panning is a continuous process and we need
 * to show tiles as they become available."
 *
 * So a change of OCTAVE is gated -- the new octave is not drawn until every
 * tile it needs exists, and then the whole level fades in at once. A change
 * of tile SET at the same octave is not gated at all: each tile fades in as
 * it lands, over whatever stand-in is under it.
 */
const gen = new Map();

const octFor = (s) => Math.ceil(Math.log2(s));
const rtKey = (lv, oct, ix, iy) => `${lv}|${oct}|${ix}|${iy}`;

function genOf(name) {
  let g = gen.get(name);
  if (!g) gen.set(name, (g = { oct: null, swapAt: 0 }));
  return g;
}

/** The tiles of `oct` the view needs, as integer indices. */
function tileRange(oct) {
  const v = viewBox();
  const k = Math.pow(2, oct) / (scale * TILE_CSS);
  return {
    ix0: Math.floor((v.x0 - ox) * k), ix1: Math.floor((v.x1 - ox) * k),
    iy0: Math.floor((v.y0 - oy) * k), iy1: Math.floor((v.y1 - oy) * k),
  };
}

/** Where a tile lands on the north-up screen, snapped to whole pixels. */
function tileBox(oct, ix, iy) {
  const z = scale / Math.pow(2, oct);
  const x = ix * TILE_CSS * z + ox;
  const y = iy * TILE_CSS * z + oy;
  // **Integers, or every tile edge antialiases against its neighbour** and
  // the map ships a seam grid (E381). Ceil the far edge so adjacent tiles
  // always meet or overlap by a pixel and never leave a gap.
  const L = Math.floor(x), Tp = Math.floor(y);
  return { L, Tp, W: Math.ceil(x + TILE_CSS * z) - L,
           H: Math.ceil(y + TILE_CSS * z) - Tp };
}

function surface() {
  const px = Math.round(TILE_CSS * DPR);
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const c = canvas.getContext('2d');
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  return { canvas, ctx: c, bytes: px * px * 4 };
}

/**
 * A tile record, with NO canvas until something actually draws into it.
 *
 * **Allocating eagerly was worth eleven long tasks.** A pan crossing a tile
 * boundary wants several tiles in the same frame, and each one used to
 * allocate a 768 x 768 canvas -- two megabytes apiece -- for work that would
 * not start until a later frame. The record is cheap; the pixels wait until
 * `stepTile` needs somewhere to put them.
 */
function newTile(lv, oct, ix, iy) {
  const rec = { key: rtKey(lv, oct, ix, iy), lv, oct, ix, iy,
                canvas: null, ctx: null,
                done: false, t0: 0, used: performance.now(),
                bytes: 0, jobs: null, job: 0, line: 0, paths: 0,
                dpr: DPR, data: dataEpoch, back: null };
  rt.set(rec.key, rec);
  return rec;
}

/**
 * How far the display factor may drift before a floored tile is redrawn.
 *
 * 0.18 of an octave is 13% of stroke width -- under what an eye can see on a
 * hairline, and a tenth of the 2x it used to jump. Only tiles that actually
 * hit a minimum are ever refreshed, so at the zooms where every road is wider
 * than the floor this costs nothing at all.
 */
const FLOOR_DRIFT = 0.18;

function floorDrifted(rec) {
  if (!rec.done || !rec.floored || rec.back || !rec.z0) return false;
  const z = scale / Math.pow(2, rec.oct);
  return Math.abs(Math.log2(z / rec.z0)) > FLOOR_DRIFT;
}

/**
 * Start redrawing a tile whose data has changed, WITHOUT blanking it.
 *
 * A tile that is already on screen redraws into a second canvas and swaps in
 * one statement when the last line lands. Only tiles actually being refreshed
 * hold two, and a first render holds one.
 */
function refreshTile(rec) {
  if (rec.back) return;
  rec.data = dataEpoch;
  if (!rec.done) { rec.jobs = null; rec.job = 0; rec.line = 0; return; }
  rec.back = surface();
  rtBytes += rec.back.bytes;
  rec.jobs = null;
  rec.job = 0;
  rec.line = 0;
  rec.paths = 0;
}

/** Draw a slice of one tile. Returns true when the tile is finished. */
function stepTile(rec, budget) {
  const deadline = performance.now() + budget;
  const ref = Math.pow(2, rec.oct);
  const m = 111132 / ref;
  const SX = (lon) => lon * KX * ref - rec.ix * TILE_CSS;
  const SY = (lat) => -lat * ref - rec.iy * TILE_CSS;
  if (!rec.canvas) {
    const sf = surface();
    rec.canvas = sf.canvas;
    rec.ctx = sf.ctx;
    rec.bytes = sf.bytes;
    rtBytes += sf.bytes;
  }
  const into = rec.back ? rec.back.ctx : rec.ctx;
  // One screen pixel, in this tile's own units, at the scale it is being
  // drawn FOR. Recorded so the blit can tell when the view has moved far
  // enough that a floored stroke would be the wrong width.
  rec.z0 = scale / ref;
  PXS = 1 / rec.z0;
  if (!rec.jobs) {
    const level = levelNamed(rec.lv);
    const groups = [];
    for (const area of state.areas) {
      if (!area.index || !level) continue;
      for (const lines of groupsUnder(area, level, rec)) groups.push(lines);
    }
    // Two passes over EVERYTHING, not one per road: a kerb drawn straight
    // after its own carriageway is overpainted by the next road's carriageway
    // wherever two streets meet, and every junction ends up with a seam.
    rec.jobs = [...groups.map((g) => ({ lines: g, pass: 0 })),
                ...groups.map((g) => ({ lines: g, pass: 1 }))];
    rec.t1 = performance.now();
    rec.floored = false;
  }
  FLOOR_HIT = false;
  while (rec.job < rec.jobs.length) {
    const job = rec.jobs[rec.job];
    const next = drawChunk(into, job.lines, m, job.pass, SX, SY,
                           TILE_CSS, TILE_CSS, 0, 0, rec.line, deadline);
    rec.paths += next.drawn;
    rec.floored = rec.floored || FLOOR_HIT;
    if (next.index >= job.lines.length) { rec.job++; rec.line = 0; } else {
      rec.line = next.index;
      PXS = 1;
      return false;
    }
    if (performance.now() >= deadline) { PXS = 1; return false; }
  }
  PXS = 1;
  if (rec.back) {
    // One statement, and the old canvas is released rather than kept: a spare
    // per tile would be most of a second cache.
    rtBytes -= rec.bytes;
    rec.canvas = rec.back.canvas;
    rec.ctx = rec.back.ctx;
    rec.bytes = rec.back.bytes;
    rec.back = null;
  } else {
    rec.done = true;
    rec.t0 = performance.now();
  }
  rec.jobs = null;
  rasterStats.count++;
  rasterStats.lastMs = Math.round(performance.now() - rec.t1);
  rasterStats.totalMs += performance.now() - rec.t1;
  rasterStats.lastWhy = 'tile';
  rasterStats.byWhy.tile = (rasterStats.byWhy.tile || 0) + 1;
  rasterStats.lastLevel = rec.lv;
  return true;
}

/**
 * Only the DATA tiles a raster tile actually overlaps.
 *
 * **The first version asked for the whole viewport's geometry per raster
 * tile, and it cost more than the thing it replaced**: ten pans measured
 * 9,610 ms of drawing against the old viewport bitmap's 3,735, because
 * twenty-five raster tiles each walked -- and each batched and stroked -- all
 * of the city on screen. A tile cache whose tiles are not culled is not a
 * tile cache, it is the same work done twenty-five times.
 *
 * The data tiles are already a spatial index, so this is a box test against
 * `index.tiles` and nothing more. The 120 m halo is a road's own half-width
 * and its join: a line whose vertices are all outside the tile can still put
 * ink inside it.
 */
const GROUP_HALO_M = 120;

function groupsUnder(area, level, rec) {
  const ref = Math.pow(2, rec.oct);
  const lon0 = (rec.ix * TILE_CSS) / (KX * ref);
  const lon1 = ((rec.ix + 1) * TILE_CSS) / (KX * ref);
  const lat1 = -(rec.iy * TILE_CSS) / ref;
  const lat0 = -((rec.iy + 1) * TILE_CSS) / ref;
  const dLat = GROUP_HALO_M / 111132;
  const dLon = GROUP_HALO_M / (111320 * KX);
  const w = lon0 - dLon, e = lon1 + dLon;
  const so = lat0 - dLat, no = lat1 + dLat;
  const z = area.index.zoom;
  const out = [];
  for (const [x, y] of area.index.tiles) {
    // A data tile's own box, from the same projection that made it.
    if (tx2lon(x + 1, z) < w || tx2lon(x, z) > e) continue;
    if (ty2lat(y + 1, z) > no || ty2lat(y, z) < so) continue;
    const hit = area.tiles.get(`${x}_${y}${level.suffix}`);
    if (hit) out.push(hit);
  }
  if (!level.tiled && area.overview) out.push(area.overview);
  return out;
}

function levelNamed(name) {
  const a = state.areas.find((x) => x.index);
  return a ? a.index.levels.find((l) => l.name === name) : null;
}

/** How many bytes the tile cache is holding. */
const sceneBytes = () => rtBytes;

/**
 * Drop the least recently used tiles until the cache fits.
 *
 * Never one the view is using: the flicker at z11.49 was a cache smaller than
 * its working set throwing away what the next frame needed, and the rule that
 * fixed it there is the rule here.
 */
function evictTiles(live) {
  if (rtBytes <= RT_MAX_BYTES) return;
  const order = [...rt.values()].sort((a, b) => a.used - b.used);
  for (const rec of order) {
    if (rtBytes <= RT_MAX_BYTES) break;
    if (live.has(rec.key)) continue;
    rt.delete(rec.key);
    rtBytes -= rec.bytes + (rec.back ? rec.back.bytes : 0);
    rasterStats.evicted++;
  }
}

/**
 * Draw one level, and say whether it managed to cover the view.
 *
 * `alpha` is the level's own share of the blend. `wanted` collects the keys
 * this frame is relying on, so the eviction pass cannot take them.
 */
function blitLevel(name, alpha, wanted, queue) {
  if (alpha <= 0) return false;
  const oct = octFor(scale);
  const g = genOf(name);
  if (g.oct === null) g.oct = oct;
  const r = tileRange(oct);
  const now = performance.now();

  // Everything the target octave needs, and whether it is all here.
  let missing = 0;
  const targets = [];
  for (let ix = r.ix0; ix <= r.ix1; ix++) {
    for (let iy = r.iy0; iy <= r.iy1; iy++) {
      const key = rtKey(name, oct, ix, iy);
      wanted.add(key);
      let rec = rt.get(key);
      if (rec && rec.dpr !== DPR) {
        rt.delete(key);
        rtBytes -= rec.bytes + (rec.back ? rec.back.bytes : 0);
        rec = null;
      }
      if (!rec) { rec = newTile(name, oct, ix, iy); }
      rec.used = now;
      // New data is a redraw, not a hole: a tile already on screen keeps
      // being drawn while its replacement is built beside it.
      if (rec.data !== dataEpoch || floorDrifted(rec)) refreshTile(rec);
      if (!rec.done || rec.back) queue.push(rec);
      if (!rec.done) missing++;
      targets.push(rec);
    }
  }

  // **The gate, and it applies to a change of OCTAVE only.** Zooming waits
  // for the whole level; panning does not wait for anything.
  // **Recorded BEFORE the gate can return.** What this frame put on screen
  // from the target octave, and what it would take to cover the view. The
  // gate below returns early, so setting these after it left them holding a
  // previous frame's numbers -- and the coverage pass, which asks exactly
  // this question, concluded the level was fine while it was drawing almost
  // nothing.
  g.need = targets.length;
  g.missing = missing;
  g.drawn = 0;

  const zooming = oct !== g.oct;
  if (zooming && missing > 0) {
    // Hold the octave already on screen, filling anything it cannot cover
    // from a coarser ancestor. Ali: "keep old until new is available."
    return drawOctave(name, g.oct, alpha, wanted, true)
      || drawAnything(name, alpha, wanted);
  }
  if (zooming) {
    // Every tile is here: swap, and stamp them all with one clock so the
    // level arrives as one picture rather than as a mosaic assembling.
    //
    // **Unless there is nothing to dissolve FROM, in which case do not
    // dissolve.** Ali: "we should not fade out any tiles unless new tiles
    // have taken their place." The same sentence read the other way is the
    // bug that survived three fixes: after a fast zoom out the octave being
    // left has no tiles on screen at all -- the level was entered mid-flight
    // and never finished one -- so the cross-dissolve had nothing to fade out
    // and faded the new octave IN FROM BLACK. Which is the flash, arriving by
    // the back door.
    const leaving = onScreenCount(name, g.oct);
    for (const rec of targets) rec.t0 = now;
    g.prevOct = leaving > 0 ? g.oct : null;
    g.oct = oct;
    g.swapAt = leaving > 0 ? now : now - LEVEL_FADE_MS;
  }

  // A zoom must never show a number between zero and all of them; a pan may
  // show any number at all.
  let drew = false;

  // **A true cross-dissolve: the old octave fades out as the new fades in.**
  // Ali: "Fade in and out simultaneously", and then, on the residual
  // brightness step between octaves: "if there is a difference, it should not
  // be sudden."
  //
  // Two versions of this were wrong before this one. The first stopped
  // drawing the old octave in the same statement that stamped the new one at
  // alpha zero -- six blank frames. The second held the old one at FULL
  // strength underneath, reasoning that two half-transparent copies of one
  // picture composite to three quarters of its ink and so a dissolve would
  // dip. That reasoning is right and the conclusion was still wrong, because
  // it never compared the two: holding it underneath ADDS the two layers'
  // ink, measured at **+82% through the fade and then a 23% drop in a single
  // frame** when the underlay was removed. The arithmetic for the dip
  // assumes OPAQUE content; these are antialiased hairlines at about a third
  // alpha, where the same formula gives a dip of 8%.
  //
  // So: 8% gradual, against 82% up and 23% down in one frame.
  const since = g.swapAt ? now - g.swapAt : Infinity;
  const crossing = g.prevOct != null && g.prevOct !== oct
    && since < LEVEL_FADE_MS;
  if (crossing) {
    const out = 1 - ease(Math.min(1, since / LEVEL_FADE_MS));
    drew = drawOctave(name, g.prevOct, alpha * out, wanted, false) || drew;
    draw();                                   // keep the dissolve running
  } else if (g.prevOct != null) {
    g.prevOct = null;
  }

  // The stand-in goes underneath at full strength wherever the target has
  // nothing yet, so a pan never shows a hole -- and ONLY there. The first
  // version filled the whole range, so every ready tile was drawn twice a
  // frame for no benefit, which doubled the one pass that had become the
  // cost.
  if (missing > 0) drew = drawOctave(name, oct, alpha, wanted, true, true) || drew;
  if (!drew && missing >= targets.length) {
    drew = drawAnything(name, alpha, wanted) || drew;
  }
  for (const rec of targets) {
    if (!rec.done) continue;
    const fade = g.swapAt === rec.t0
      ? Math.min(1, (now - rec.t0) / LEVEL_FADE_MS)
      : Math.min(1, (now - rec.t0) / TILE_FADE_MS);
    if (fade < 1) draw();
    const b = tileBox(rec.oct, rec.ix, rec.iy);
    ctx.globalAlpha = alpha * ease(fade);
    ctx.drawImage(rec.canvas, b.L, b.Tp, b.W, b.H);
    g.drawn++;
    drew = true;
  }
  ctx.globalAlpha = 1;
  return drew;
}

/**
 * Draw every finished tile of a level that touches the view, whatever octave
 * it is at, coarsest first.
 *
 * **The ancestor walk only looks COARSER, and that is the wrong way for a
 * zoom out.** Ali: "I zoomed out extremely quickly and everything went black
 * ... we should not fade out any tiles unless new tiles have taken their
 * place." Zooming out fast, every tile in the cache is FINER than the octave
 * now wanted -- they are the ground you were just looking at -- so the
 * per-tile fallback, which climbs towards coarser octaves, found nothing at
 * all and the map had nothing to draw.
 *
 * This is the last resort and it is deliberately dumb: no ranges, no
 * ancestry, just every tile of this level that is finished and on screen,
 * painted coarse-to-fine so the sharper ones land on top. After a four-octave
 * zoom out that is a small sharp patch in the middle of the view, which is
 * honest -- it is exactly the ground we have -- and it is not black.
 *
 * It costs one pass over the cache, and only on frames where the ordinary
 * path drew nothing.
 */
/** How many finished tiles of this level and octave are on screen. */
function onScreenCount(name, oct) {
  if (oct == null) return 0;
  const W = cv.width / DPR, H = cv.height / DPR;
  let n = 0;
  for (const rec of rt.values()) {
    if (rec.lv !== name || rec.oct !== oct || !rec.done) continue;
    const b = tileBox(rec.oct, rec.ix, rec.iy);
    if (b.L > W || b.Tp > H || b.L + b.W < 0 || b.Tp + b.H < 0) continue;
    n++;
  }
  return n;
}

function drawAnything(name, alpha, wanted, allow, maxGap) {
  const W = cv.width / DPR, H = cv.height / DPR;
  const target = octFor(scale);
  const shown = [];
  for (const rec of rt.values()) {
    if ((name !== null && rec.lv !== name) || !rec.done) continue;
    // **A stand-in has to be a stand-in for THIS zoom.** Ali, after the last
    // fix: "they started not hiding at all. so we have the max fidelity tiles
    // still showing when zoom is ~10." A fine-level tile from an earlier
    // visit is still in the cache and still touches the view -- as a postage
    // stamp of the densest geometry we own, drawn over the overview. Which is
    // the LOD failure the whole ladder exists to prevent, reintroduced by the
    // pass that was meant to stop a black screen.
    //
    // So: only levels at or COARSER than the one being asked for. That is
    // the whole rule, and an octave cap on top of it was worse than useless
    // -- a four-octave zoom out has nothing within three octaves, so the
    // blackout came back. The OCTAVE only changes how big a patch a tile
    // covers; the LEVEL is what decides how much road is in it, and drawing
    // the wrong level is the only one of the two that can look wrong.
    if (allow && !allow.has(rec.lv)) continue;
    if (maxGap != null && Math.abs(rec.oct - target) > maxGap) continue;
    const b = tileBox(rec.oct, rec.ix, rec.iy);
    if (b.L > W || b.Tp > H || b.L + b.W < 0 || b.Tp + b.H < 0) continue;
    shown.push([rec, b]);
  }
  if (!shown.length) return false;
  // Coarsest first, so the sharper tiles land on top of the stand-in rather
  // than under it. With `name === null` this mixes levels, which during a
  // fast zoom is exactly right: the question is what covers the ground, not
  // which ladder rung it came from.
  shown.sort((a, b) => a[0].oct - b[0].oct);
  ctx.globalAlpha = alpha;
  for (const [rec, b] of shown) {
    wanted.add(rec.key);
    rec.used = performance.now();
    ctx.drawImage(rec.canvas, b.L, b.Tp, b.W, b.H);
  }
  ctx.globalAlpha = 1;
  return true;
}

/**
 * Draw `oct`'s tiles where they exist, and an ancestor's where they do not.
 *
 * An ancestor is the same ground at a coarser octave: tile `(ix, iy)` at
 * `oct - k` is `(ix >> k, iy >> k)`, and the part of it that matters is the
 * `(ix & mask, iy & mask)` cell of a `2^k` grid. Blitting that sub-rectangle
 * is what every tiled map does and what stops a hole existing at all.
 */
function drawOctave(name, oct, alpha, wanted, fallback, onlyGaps) {
  const r = tileRange(oct);
  // **A range from a stale octave is not a range, it is a scan.** After a
  // four-octave zoom out, covering the view with the octave that was on
  // screen needs 256 times as many tiles as exist, so this looped thousands
  // of lookups, missed almost all of them, and returned true on the handful
  // it found -- which is why the fallback below it never ran and the screen
  // stayed nearly black.
  if ((r.ix1 - r.ix0 + 1) * (r.iy1 - r.iy0 + 1) > 400) return false;
  let drew = false;
  for (let ix = r.ix0; ix <= r.ix1; ix++) {
    for (let iy = r.iy0; iy <= r.iy1; iy++) {
      const key = rtKey(name, oct, ix, iy);
      const own = rt.get(key);
      if (own && own.done && onlyGaps) continue;      // the caller has it
      if (own && own.done) {
        wanted.add(key);
        own.used = performance.now();
        const b = tileBox(oct, ix, iy);
        ctx.globalAlpha = alpha;
        ctx.drawImage(own.canvas, b.L, b.Tp, b.W, b.H);
        drew = true;
        continue;
      }
      if (!fallback) continue;
      for (let k = 1; k <= FALLBACK_OCTAVES; k++) {
        const anc = rt.get(rtKey(name, oct - k, ix >> k, iy >> k));
        if (!anc || !anc.done) continue;
        wanted.add(anc.key);
        anc.used = performance.now();
        const n = 1 << k;
        const sx0 = (ix & (n - 1)) * (anc.canvas.width / n);
        const sy0 = (iy & (n - 1)) * (anc.canvas.height / n);
        const b = tileBox(oct, ix, iy);
        ctx.globalAlpha = alpha;
        ctx.drawImage(anc.canvas, sx0, sy0,
                      anc.canvas.width / n, anc.canvas.height / n,
                      b.L, b.Tp, b.W, b.H);
        drew = true;
        break;
      }
    }
  }
  ctx.globalAlpha = 1;
  return drew;
}

let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; paint(); });
}

/**
 * New data landed, so every tile drawn from the old data is out of date.
 *
 * It does NOT drop what is on screen. Tiles arrive in a stream while somebody
 * is zooming, and clearing on each one is half of why the map used to go
 * black. The epoch marks the raster tiles stale; each one then redraws into a
 * SECOND canvas of its own and swaps when it is finished, so the picture
 * never has a hole in it while the refresh runs. Ali: "keep old until new is
 * available."
 *
 * Coalesced, because ninety-seven data tiles arriving in a second should
 * cause one refresh and not ninety-seven.
 */
let dataTimer = 0;
function invalidate() {
  // **Coalesce, do not debounce.** Clearing the timer on every arrival
  // starves it: tiles land in a steady stream while somebody is moving, each
  // call pushes the deadline out, and the epoch is never bumped at all.
  if (dataTimer) return;
  dataTimer = setTimeout(() => {
    dataTimer = 0;
    dataEpoch++;
    draw();
  }, 250);
}

/** Rasterisations since load, and what caused the last one. */
const rasterStats = { count: 0, cancelled: 0, evicted: 0, lastMs: 0,
                      totalMs: 0,
                      lastWhy: '', lastLevel: '',
                      // One counter per reason. `count` alone cannot answer
                      // "did the pan cost a rebuild", because a tile landing
                      // during the pan moves it too -- and that is the sort of
                      // proxy that keeps a suite green while the thing it names
                      // is broken.
                      byWhy: Object.create(null) };

/** The level currently on screen, and a timed fade towards another. */
let shownLevel = null;
let lastShown = null;
let fade = null;                   // {from, to, start}

/**
 * True while a finger or a wheel is moving the view.
 *
 * **Declared here, not beside the gesture handlers**, and that is not tidiness.
 * This module ends in a top-level `await` for the flavour manifest, so an
 * animation frame scheduled during the load can run while module evaluation is
 * still suspended. A `let` further down the file is in its temporal dead zone
 * at that moment, and `paint` reading it throws -- silently, inside a
 * requestAnimationFrame callback, and only when the fetch happens to be fast
 * enough. The map then rendered or did not depending on the network.
 */
let gesturing = false;
let settleTimer = 0;

/**
 * A one-pointer rotate-drag, for a desktop that has no second finger.
 *
 * **Declared here with `gesturing` and for the same reason.** This module ends
 * in a top-level `await`, and anything a frame or a handler can reach while
 * evaluation is still suspended must be above the point that reaches it, or
 * the read throws from the temporal dead zone -- silently, and only when the
 * network happens to be fast enough.
 */
let twist = null;
let twistArmed = false;

/**
 * `?tiles=1` writes the level, octave and index on every tile.
 *
 * Ali: "you're very much free to render the level reference on each tile so I
 * can easily troubleshoot. There are some important adjustments I want to
 * make, but I have too little information to instruct you." A screenshot with
 * `fine @ oct 18` across it answers in one glance what a table of thresholds
 * answers only if you also know what zoom you were at.
 */
const DEBUG_TILES = Q.get('tiles') === '1';

function labelTiles(wanted) {
  ctx.save();
  ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (const key of wanted) {
    const rec = rt.get(key);
    if (!rec) continue;
    const b = tileBox(rec.oct, rec.ix, rec.iy);
    if (b.W < 40) continue;
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = rec.done ? T.blip : T.unreached;
    ctx.lineWidth = 1;
    ctx.strokeRect(b.L + 0.5, b.Tp + 0.5, b.W - 1, b.H - 1);
    const txt = `${rec.lv} @ ${rec.oct}`;
    const sub = `${rec.ix},${rec.iy}${rec.done ? '' : ' …'}`;
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillRect(b.L + 2, b.Tp + 2, Math.max(ctx.measureText(txt).width,
      ctx.measureText(sub).width) + 8, 30);
    ctx.fillStyle = '#ffd166';
    ctx.fillText(txt, b.L + 6, b.Tp + 4);
    ctx.fillStyle = '#9fb0c4';
    ctx.fillText(sub, b.L + 6, b.Tp + 17);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** How long the hand must be still before the map commits to the finer level. */
const SETTLE_HOLD_MS = 240;

/** And how long the commit takes. Short: this is a resolve, not a transition. */
const SETTLE_FADE_MS = 700;

/**
 * Once the zooming stops, go all the way to the finer level.
 *
 * Ali: "if i stop zooming, the highest fidelity layers should fade in
 * completely, so we dont get stuck in a half mode."
 *
 * The blend is a function of the zoom, which is right while the zoom is
 * moving -- it tracks the finger exactly -- and wrong the moment it stops.
 * Park at the middle of a span and the map sits there for good at half detail,
 * showing neither level properly and looking like a rendering fault rather
 * than a choice. There is no reason to hold back detail from somebody who has
 * stopped: the work is done, the scene is in hand, and the coarser level was
 * only ever there to make the movement cheap.
 *
 * So: hold briefly, in case the hand is only pausing between notches, then
 * run `t` down to zero and drop the coarser level entirely. `b` has to become
 * null and not merely reach `t = 0`, or the drawing pass still believes it is
 * inside a span and takes the not-ready branch.
 */
function settleBlend(want) {
  if (!want.b || want.t <= 0 || gesturing) return want;
  const idle = zoomIntent.at ? performance.now() - zoomIntent.at : Infinity;
  if (idle < SETTLE_HOLD_MS) return want;
  const k = Math.min(1, (idle - SETTLE_HOLD_MS) / SETTLE_FADE_MS);
  const t = want.t * (1 - ease(k));
  if (k < 1) draw();                       // keep the clock running
  return t <= 0.002 ? { a: want.a, b: null, t: 0 }
                    : { a: want.a, b: want.b, t };
}

function paint() {
  return span('frame', () => paintFrame());
}

function paintFrame() {
  const frameStart = performance.now();
  const w = cv.width / DPR, h = cv.height / DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = T.bg;
  ctx.fillRect(0, 0, w, h);

  const area = state.areas.find((a) => a.index);
  if (!area) { drawOverlay(w, h, false); return; }
  const want = settleBlend(levelBlend(area));

  // Whatever the zoom asks for, ask for it -- but never wait for it. A level
  // that is not rasterised yet simply is not drawn this frame, and the level
  // that IS in hand carries on being shown.
  const need = want.b && want.t > 0 ? [want.a, want.b] : [want.a];

  // **Ask for data tiles every frame, whatever the rasteriser is doing.**
  // Fetching used to happen only inside the rasterisation, so while a scene
  // stayed fresh enough not to rebuild, nothing new was ever requested --
  // Ali: "there is some kind of debouncing that prevents tiles from being
  // downloaded as long as there is movement."
  for (const a2 of state.areas) {
    if (!a2.index) continue;
    // One list of what is on screen per frame, refilled by the levels in
    // play. It is what stops the eviction pass taking a tile the next blit
    // needs -- see `MAX_DECODED_TILES`.
    if (a2.onScreen) a2.onScreen.clear();
    for (const lv of need) visibleGroups(a2, lv);
  }

  // Everything from here to `mapOut` is drawn north-up and turned as one.
  mapIn();
  const wanted = new Set();
  const queue = [];
  let drewSomething = false;
  // `drawn` is only written by `blitLevel`, so a level that stops being asked
  // for keeps its last count for ever -- which made a diagnostic report
  // `fine` as on screen at z 10 when it had not been drawn in seconds.
  for (const g of gen.values()) g.drawn = 0;

  // **Whatever the cache can cover the ground with, under everything, while
  // the wanted level is incomplete.** Ali: "I zoomed out extremely quickly
  // and everything went black ... we should not fade out any tiles unless new
  // tiles have taken their place."
  //
  // The per-tile fallback climbs towards COARSER octaves, which is the right
  // way for a pan and the wrong way for a zoom out -- everything cached is
  // then finer than what is wanted, so it found nothing. And a fast zoom out
  // crosses level boundaries too, so the level being entered has an empty
  // cache and the level being left is no longer asked for.
  //
  // This ignores both distinctions. It is the last thing that can go wrong
  // before a black screen, so it answers the only question that matters: is
  // there anything at all, anywhere in the cache, that covers this ground?
  // Mid-dissolve counts as incomplete: the level is on its way in, not in.
  const incomplete = need.some((lv) => {
    const g = gen.get(lv.name);
    return !g || g.oct !== octFor(scale) || g.missing > 0
      || (g.swapAt && performance.now() - g.swapAt < LEVEL_FADE_MS);
  });
  if (incomplete) {
    // **The levels this zoom asks for, everything coarser, and two rungs
    // finer.** Coarser is always a legitimate picture of the same place. Zero
    // rungs finer is not enough: zooming out, the only thing in the cache IS
    // a finer level -- it is the ground you were just looking at -- so
    // allowing none of it brought the black screen straight back. Two rungs
    // is the stand-in you were just shown; four is `fine` under `overview`,
    // which is what Ali saw: "the max fidelity tiles still showing when zoom
    // is ~10."
    const order = area.index.levels.map((l) => l.name);
    const from = Math.min(...need.map((lv) => order.indexOf(lv.name)));
    const allow = new Set(order.slice(Math.max(0, from - 2)));
    drewSomething = drawAnything(null, 1, wanted, allow, null);
  }
  span('blit', () => {
  if (want.b && want.t > 0) {
    // **The COARSER level goes underneath at full opacity and the finer one
    // fades on top.** The first version had it the other way round, and the
    // fade was invisible by construction: a coarse level is a SUBSET of the
    // fine one, so fading it in over a fine level that already draws all of
    // it changes nothing on screen. What the eye can see is the extra detail
    // arriving and leaving, so that is what is faded.
    drewSomething = blitLevel(want.b.name, 1, wanted, queue);
    blitLevel(want.a.name, 1 - ease(want.t), wanted, queue) ;
    shownLevel = want.t < 0.5 ? want.a.name : want.b.name;
  } else {
    drewSomething = blitLevel(want.a.name, 1, wanted, queue);
    shownLevel = want.a.name;
  }
  });
  if (DEBUG_TILES) labelTiles(wanted);
  mapOut();

  // A level change is a reason to re-read the readout: the zoom has not moved
  // but the answer to "which level am I on" has.
  if (shownLevel !== lastShown) { lastShown = shownLevel; showWhere(); }

  // Rasterise a slice of what is outstanding, after drawing, so the work
  // lands in the gap at the end of the frame rather than in front of it.
  //
  // **Nearest the middle of the screen first.** A tile queue is a list of
  // places somebody is looking at, and the one under their eye is worth more
  // than the one at the corner. It also means a gated zoom finishes the
  // middle of the picture first, so the moment it is allowed to appear it
  // appears from where the attention already is.
  const cx0 = w / 2, cy0 = h / 2;
  queue.sort((p1, p2) => {
    const b1 = tileBox(p1.oct, p1.ix, p1.iy);
    const b2 = tileBox(p2.oct, p2.ix, p2.iy);
    return Math.hypot(b1.L - cx0, b1.Tp - cy0)
      - Math.hypot(b2.L - cx0, b2.Tp - cy0);
  });
  span('evict', () => evictTiles(wanted));
  const budget = gesturing ? SLICE_GESTURE_MS : SLICE_MS;
  let did = false;
  if (queue.length && performance.now() - frameStart < OVERRUN_MS) {
    did = span('raster:tile', () => stepTile(queue[0], budget));
    if (did) {
      toastRaster(`${queue[0].lv} · tile · ${rasterStats.lastMs} ms · `
        + `${queue[0].paths.toLocaleString()} paths · `
        + `${(sceneBytes() / 1e6).toFixed(0)} MB canvas`);
    }
  }
  if (queue.length || !drewSomething) draw();

  drawOverlay(w, h, drewSomething);
}

/** The route, the pins and the scale bar: tens of paths, redrawn every frame. */
function drawOverlay(w, h, drew) {
  const m = mpp();
  mapIn();
  // Road we can draw and cannot route on, in UNREACHED pink. A map that
  // quietly hides it is lying to the driver.
  if (state.unreached.length) {
    ctx.save();
    ctx.strokeStyle = T.unreached;
    ctx.lineWidth = Math.max(1.4, Math.min(9, 12 / m));
    ctx.lineCap = 'round';
    for (const pts of state.unreached) {
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const X = sx(pts[i][0]), Y = sy(pts[i][1]);
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  // Under the route and the pins: a tile landing is background news.
  if (drawBlips()) draw();
  if (state.route) span('overlay', () => { drawRoute(); drawHighlight(); });
  else drawHighlight();
  mapOut();
  // **Upright, whatever the map is doing.** A pin is a symbol pointing at a
  // place, not a feature lying on the ground, and a scale bar that reads at
  // an angle is a scale bar nobody reads. Both are drawn in screen pixels,
  // outside the turn, with the pin's anchor carried through `rot`.
  drawPins();
  drawScale(w, h);
  drawCompass(w, h);
  if (drew) hideLoading();
}

/** The spinner goes when there is a map to look at, not on a timer. */
let loadingGone = false;
// ...but it may never outlive its welcome either. A full-screen overlay that
// stays up because something upstream failed does not merely look wrong: it
// swallows every touch on the map underneath it.
setTimeout(() => hideLoading(), 12000);
function hideLoading() {
  if (loadingGone) return;
  loadingGone = true;
  const el = $('loading');
  if (!el) return;
  el.classList.add('gone');
  setTimeout(() => { el.style.display = 'none'; }, 400);
}

/**
 * The stretch of road the hovered instruction is about, and which way it goes.
 *
 * A turn-by-turn list is a set of claims about specific pieces of road, and
 * until you can see WHICH piece, "turn right in 340 m" is unfalsifiable. The
 * arrow matters as much as the highlight: on a dual carriageway the same
 * ribbon carries both directions, so a highlight with no direction on it
 * still leaves the useful question open.
 */
function drawHighlight() {
  const step = state.hover;
  if (!step || !step.pts || step.pts.length < 2) return;
  const pts = step.pts;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = T.highlight;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = Math.max(5, Math.min(22, 30 / mpp()));
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const X = sx(pts[i][0]), Y = sy(pts[i][1]);
    if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
  }
  ctx.stroke();

  // Chevrons ALONG the highlight, not one arrowhead at the end. On a 19 km
  // instruction a single arrow is off screen at every zoom that shows the
  // road, and the question the highlight answers -- which way does this go --
  // goes back to being unanswerable.
  ctx.globalAlpha = 1;
  ctx.fillStyle = T.highlight;
  const stepPx = Math.max(64, Math.min(200, 26 / Math.max(mpp(), 0.05)));
  const size = Math.max(5, Math.min(14, 18 / Math.max(mpp(), 0.4)));
  let run = stepPx * 0.5;
  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = sx(pts[i][0]), ay = sy(pts[i][1]);
    const bx = sx(pts[i + 1][0]), by = sy(pts[i + 1][1]);
    const d = Math.hypot(bx - ax, by - ay);
    if (d < 1e-6) continue;
    const ux = (bx - ax) / d, uy = (by - ay) / d;
    const ang = Math.atan2(uy, ux);
    for (let at = stepPx - run; at < d; at += stepPx) {
      const x = ax + ux * at, y = ay + uy * at;
      ctx.beginPath();
      ctx.moveTo(x + size * Math.cos(ang), y + size * Math.sin(ang));
      ctx.lineTo(x - size * 0.8 * Math.cos(ang - 0.6),
                 y - size * 0.8 * Math.sin(ang - 0.6));
      ctx.lineTo(x - size * 0.8 * Math.cos(ang + 0.6),
                 y - size * 0.8 * Math.sin(ang + 0.6));
      ctx.closePath();
      ctx.fill();
    }
    run = (run + d) % stepPx;
  }
  ctx.restore();
}

// Our own cartography, and it is the model drawn literally.
//
// "A road is the space between two long parallel straight edges. Detect the
// edges; pair them; the pair is the carriageway, its separation is the
// width." So a road here is not a stroke of arbitrary weight: it is a
// carriageway between two luminous kerbs, at the width we measured, and
// zooming in shows the measurement rather than a thicker line.
/**
 * Two palettes, because a map is looked at in two kinds of light.
 *
 * The dark one is the original and stays the default where the system says
 * nothing: a dark surround stops the chrome competing with the map, and the
 * roads are the only bright thing on it. The light one inverts the
 * RELATIONSHIP rather than the colours -- on paper the roads are dark and the
 * ground is pale, which is how every printed map has ever worked. Lightening
 * the dark palette instead would have given pastel roads on white that nobody
 * could follow.
 *
 * Everything the canvas draws comes from here; the stylesheet carries the
 * same two sets for the chrome, keyed off `body.light`.
 */
const THEMES = {
  dark: {
    bg: '#0b0d11',
    carriageway: '#1d2531',
    kerbTwoWay: '#4fdf91',
    kerbOneWay: '#57ccf2',
    route: '#ffd166',
    routeEdge: '#fff0c2',
    routeDim: '#6b5a2e',
    unreached: '#d67a8a',
    highlight: '#ffffff',
    blip: '#8fe9ff',
    scale: 'rgba(233,237,243,.75)',
    scaleLine: 'rgba(233,237,243,.55)',
    sky0: '#05070c',
    sky1: '#131d29',
    ground: '#0a0d11',
    horizon: 'rgba(87,204,242,.22)',
    star: '#ffffff',
    starBright: '#cfe6ff',
    stars: true,
  },
  light: {
    bg: '#f3f1ec',
    carriageway: '#ffffff',
    kerbTwoWay: '#2c7f55',
    kerbOneWay: '#256d94',
    route: '#d4820a',
    routeEdge: '#8a5300',
    routeDim: '#e0c48f',
    unreached: '#bb3c56',
    highlight: '#1b1f26',
    blip: '#0f6f95',
    scale: 'rgba(27,31,38,.8)',
    scaleLine: 'rgba(27,31,38,.5)',
    sky0: '#a9c9e2',
    sky1: '#e9eff4',
    ground: '#e4e0d8',
    horizon: 'rgba(37,109,148,.4)',
    star: '#ffffff',
    starBright: '#ffffff',
    // No stars in daylight. Drawing them and hoping nobody looks is the sort
    // of detail that makes the rest look careless.
    stars: false,
  },
};

/** What was CHOSEN -- `system`, `light` or `dark`. */
let themeChoice = (() => {
  try {
    const saved = localStorage.getItem('alimap.theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch (e) { /* a private window still gets a theme, just not a memory */ }
  return 'system';
})();

/** And what is actually on screen, which for `system` is what the phone says. */
let themeName = themeChoice === 'system'
  ? (() => {
    try {
      return matchMedia('(prefers-color-scheme: light)').matches
        ? 'light' : 'dark';
    } catch (e) {
      return 'dark';
    }
  })()
  : themeChoice;
let T = THEMES[themeName];

function applyTheme(name) {
  themeName = THEMES[name] ? name : 'dark';
  T = THEMES[themeName];
  document.body.classList.toggle('light', themeName === 'light');
  const btn = $('theme');
  if (btn) {
    const face = { system: ['◐', 'Auto'], light: ['☀', 'Light'],
                   dark: ['☾', 'Dark'] }[themeChoice] || ['☾', 'Dark'];
    btn.innerHTML = `<span class="ico">${face[0]}</span>${face[1]}`;
    btn.setAttribute('aria-label', `Theme: ${face[1]}. Tap to change.`);
    btn.setAttribute('aria-pressed', String(themeChoice !== 'system'));
  }
  // Every scene is now the wrong colour.
  invalidate();
  paintNav3d();
}


// **Dimmer when a road is a hairline, and it is not a style preference.**
//
// Ali: "the anti-aliasing is causing the whole thing to seem more bright when
// we are very much zoomed out because of the close vertices proximity to each
// other."
//
// Exactly so, and the mechanism is compositing rather than antialiasing on its
// own. Each road was stroked in its own `beginPath`/`stroke` pair at alpha
// 0.85, so two roads landing on one pixel composite to 1 - 0.15^2 = 0.98, and
// a hundred of them saturate. A measured city view showed the green channel
// smeared evenly across every brightness bucket -- a continuum where a map
// should be bimodal: road, or not road.
//
// Two changes, together. Hairlines are drawn at **alpha 1** so overlap cannot
// accumulate at all, and in a **dimmer** colour so a dense grid reads as a
// calm field rather than a neon slab. Wide roads keep the full brand colour,
// because at that zoom each one is a distinct object worth its brightness.
/**
 * How wide a hairline road is, in pixels.
 *
 * **This is the real control over the glow, and the first attempt missed it.**
 * Removing the alpha stopped strokes compositing on top of each other, but
 * antialiasing still spreads a line's coverage over neighbouring pixels, and
 * two lines a pixel apart each covering half a pixel still sum to three
 * quarters. Dimming the colour hid that at the cost of the map being hard to
 * see -- Ali: "its still glowing and not as visible anymore. Maybe we can just
 * use a thinner line width?"
 *
 * Right: the cure is less ink, not darker ink. At a city view a road's true
 * width is a twentieth of a pixel and the floor is what puts it on screen at
 * all, so the floor IS the brightness of a dense district. Tunable, because
 * where it should sit is a matter of looking at it:
 *
 *   __alimaps.tune({ thinPx: 0.7 })
 */
let THIN_PX = 0.33;

/**
 * How many units of the current draw target make one SCREEN pixel.
 *
 * **Every minimum width in this renderer is a statement about the screen, and
 * a cached tile is not drawn at screen scale.** A tile is rasterised at its
 * octave's reference scale and shown at `scale / ref`, which slides from 1
 * down to 0.5 as you zoom out through the octave and snaps back at the
 * boundary. A stroke clamped to `THIN_PX` in TILE pixels therefore appeared
 * at 0.6 screen pixels just after a boundary and 0.3 just before the next
 * one, and DOUBLED the moment you crossed -- which is what Ali saw: "it's
 * almost like the border width of the arteries is increasing when I zoom
 * out", at z 9.4, which is the octave 9/10 boundary to two decimal places.
 *
 * It was never specific to arteries or to that zoom. The floor binds wherever
 * a road is thinner than it, so it bound on everything from `coarse` outward
 * and jumped at every octave boundary.
 *
 * **And the floor is now the THIN end of what it used to do**, 0.33 rather
 * than 0.6. Ali, offered the choice: "when we zoom out, it doesn't look
 * better because the line width is increased. We can keep the thinner line
 * width as is." So a zoomed-out map is a hairline map, consistently, and
 * `__alimaps.tune({ thinPx })` moves it without a rebuild.
 *
 * So the constants are multiplied by this on the way in, and the tile
 * remembers the factor it was drawn for.
 */
let PXS = 1;

/** True if anything in the last draw actually hit a minimum width. */
let FLOOR_HIT = false;

// The carriageway has to be clearly lighter than the page. The first version
// filled it at #11161d against a #0b0d11 background, so a 14 m road at
// 0.5 m/px was a 29-pixel black ribbon on a black field with two hairlines on
// it -- the map looked empty at exactly the zoom that shows the most.

/** How wide this road is on screen, in pixels. */
function widthPx(l, m) {
  // `widthM` is measured on the corpus and estimated on the OSM demo; either
  // way it is the road's own width, not a styling choice. The floor keeps a
  // service road visible at city zoom, the ceiling stops a motorway becoming
  // a slab when somebody zooms to the kerb.
  const w = (l.widthM || 6) / m;
  if (w < THIN_PX * PXS) FLOOR_HIT = true;
  return Math.max(THIN_PX * PXS, Math.min(140 * PXS, w));
}

/**
 * Draw part of one group, stopping at `deadline`.
 *
 * Returns where to resume. The cull runs against the SCENE's own box, which
 * is the view at the moment the scene was started -- not the live view, which
 * may have moved on while this was still being rasterised.
 */
function drawChunk(c, lines, m, pass, SX, SY, w, h, mx, my, from, deadline) {
  // Invert SX/SY to recover the scene's own geographic box.
  const kLon = SX(1) - SX(0);
  const lon0 = (0 - SX(0)) / kLon;
  const lon1 = (w - SX(0)) / kLon;
  const kLat = SY(1) - SY(0);
  const lat0 = (0 - SY(0)) / kLat;
  const lat1 = (h - SY(0)) / kLat;
  const padLon = 80 / (111320 * KX), padLat = 80 / 111132;
  const west = Math.min(lon0, lon1) - padLon;
  const east = Math.max(lon0, lon1) + padLon;
  const south = Math.min(lat0, lat1) - padLat;
  const north = Math.max(lat0, lat1) + padLat;

  // **One path per style, stroked once.** Canvas rasterises a stroked path as
  // a single coverage mask, so two roads of the same style overlapping inside
  // it cost the same ink as one -- which is the whole of the brightness fix.
  // It is also far fewer draw calls than a `stroke()` per road.
  //
  // Keyed by colour and by width rounded to a quarter pixel: finer buckets
  // would be more faithful and would put the batching back where it started.
  const batches = new Map();
  const add = (style, width, pts) => {
    const key = style + '|' + width;
    let bt = batches.get(key);
    if (!bt) batches.set(key, (bt = { style, width, path: new Path2D() }));
    const path = bt.path;
    path.moveTo(SX(pts[0]), SY(pts[1]));
    for (let q = 2; q < pts.length; q += 2) {
      path.lineTo(SX(pts[q]), SY(pts[q + 1]));
    }
  };

  let drawn = 0;
  let i = from;
  for (; i < lines.length; i++) {
    // Check the clock every so often rather than every line: the call itself
    // costs more than adding a short residential street to a path.
    if ((i & 255) === 0 && performance.now() >= deadline) break;
    const l = lines[i];
    const p = l.pts;
    // A cheap bounding test on the first and last vertex rejects most of a
    // city without walking every point of every way.
    if (p.length >= 4) {
      const aLon = p[0], aLat = p[1];
      const bLon = p[p.length - 2], bLat = p[p.length - 1];
      if ((aLon < west && bLon < west) || (aLon > east && bLon > east)
        || (aLat > north && bLat > north)
        || (aLat < south && bLat < south)) continue;
    }
    // **Always a casing with a carriageway inside it, at every width.** Ali:
    // "there is no transition or fade for it. It is a sudden flip ... lets
    // always do hollow."
    //
    // It flipped because of a threshold that is now gone: under five pixels
    // the road was drawn as one line in the kerb colour and the second pass
    // skipped it entirely, so a road crossed from hollow to solid between one
    // wheel notch and the next. And the level cross-fade could not soften it,
    // because this is not a level boundary -- it is a per-road decision
    // taken inside one level's rasterisation, and it fires at a different
    // zoom for every width of road.
    //
    // The two passes were already casing-then-fill rather than a fill with
    // two offset kerbs, so the fix is to stop special-casing and let the
    // carriageway simply RUN OUT: pass 0 strokes the full width in the kerb
    // colour, pass 1 strokes what is left after two kerbs in the carriageway
    // colour, and when that is nothing there is nothing to draw. A road
    // therefore closes up continuously as it narrows -- the last of the
    // carriageway is a sub-pixel line that Canvas draws at partial alpha,
    // which IS the fade, with no blend and no second representation.
    const W = widthPx(l, m);
    // The kerb keeps a share of the width rather than a fixed 1.2 px, so a
    // motorway at close zoom still reads as a road with edges.
    const kerb = Math.max(1.1 * PXS, Math.min(4 * PXS, W * 0.09));
    const inner = W - 2 * kerb;
    // **No cutoff, so there is no step.** Skipping under a twentieth of a
    // pixel looked harmless and put a 0.06 px jump back into the very
    // place that has to be smooth; a stroke thinner than that costs
    // nothing and Canvas draws it at the alpha it deserves.
    if (pass === 1 && inner <= 0) continue;
    let style, width;
    if (pass === 1) {
      style = T.carriageway;
      width = inner;
    } else {
      style = l.oneway ? T.kerbOneWay : T.kerbTwoWay;
      width = Math.max(THIN_PX * PXS, W);
    }
    // Quantised for batching, but finely under a pixel: rounding a 0.2 px
    // carriageway to the nearest quarter would put the flip back at the
    // bottom of the range, which is the one place it has to be smooth.
    const q = width / PXS;          // quantise in SCREEN pixels, not tile ones
    add(style, PXS * (q < 1 ? Math.round(q * 16) / 16
                            : Math.round(q * 4) / 4), p);
    drawn++;
  }

  c.globalAlpha = 1;
  for (const bt of batches.values()) {
    c.strokeStyle = bt.style;
    c.lineWidth = bt.width;
    c.stroke(bt.path);
  }
  return { index: i, drawn };
}

/**
 * A micro toast when a level is re-rasterised.
 *
 * Ali: "if the tiles are going black because of rerasterization, then it would
 * seem we are rerendering a bit too often (?) ... can you add a micro toast
 * when doing this so I know."
 *
 * It reports the level, WHY it was redrawn, how long it took, how many paths
 * it drew, and how much canvas the scene buffers are holding. The reason is
 * the useful part: 'pan' and 'zoom' repeating at the same thresholds would
 * mean the margins are too tight, 'data' repeating would mean tile arrivals
 * are not being coalesced, and 'ahead' is the prefetch doing its job.
 */
let toastTimer = 0;
function toastRaster(text) {
  const el = $('raster-toast');
  if (!el) return;
  el.textContent = `${rasterStats.count} · ${text}`;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

/**
 * The compass, which is the only thing telling you the map has been turned.
 *
 * A map that rotates without one is a map you can get lost on: every other
 * cue -- the grid, the arterials, the shape of a district -- looks equally
 * plausible at any angle, and Riyadh's grid in particular is a field of
 * parallel lines that says nothing about which way is north.
 *
 * Drawn on the canvas beside the scale bar rather than as a button, because
 * it has to be exact: it is reporting a number, and a CSS rotation lagging
 * the canvas by a frame would be reporting the wrong one. The tap target is
 * a DOM button over it, which is a separate problem with a separate answer.
 *
 * It is always there, at every heading including north. Hiding it at north is
 * the fashion and it costs the one thing the control is for -- somebody who
 * has not discovered that the map turns never sees the control that turns it
 * back.
 */
const COMPASS_R = 16;

/**
 * Top right, under whatever the toolbar turns out to be.
 *
 * Ali: "i want it top right, not bottom right." The corner itself belongs to
 * the toolbar, which wraps to two rows when the provenance badge is long and
 * to one when it is not -- so the position is measured off the toolbar's own
 * box rather than guessed from a screen width, the same way the readout is.
 */
function compassAt(w, h) {
  const x = w - COMPASS_R - 16;
  let y = COMPASS_R + 16;
  // **Everything that can take the top right corner, asked in turn.** The
  // toolbar wraps to two rows when the provenance badge is long, and the 3d
  // window opens at `right: 12px; top: 58px` -- which is the compass, exactly.
  // Two passes, because clearing the toolbar can move the compass into the
  // 3d window and clearing the 3d window can move it back under the toolbar.
  for (let pass = 0; pass < 2; pass++) {
    for (const id of ['top', 'nav3dwrap']) {
      const el = $(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (!r.height || !r.width || getComputedStyle(el).display === 'none') {
        continue;
      }
      const overlaps = r.right > x - COMPASS_R && r.left < x + COMPASS_R
        && r.bottom > y - COMPASS_R && r.top < y + COMPASS_R;
      if (overlaps) y = r.bottom + COMPASS_R + 10;
    }
  }
  return [x, Math.min(y, h - COMPASS_R - 12)];
}

function drawCompass(w, h) {
  const [cx, cy] = compassAt(w, h);
  const north = -heading;                 // where north has ended up on screen
  ctx.save();
  ctx.translate(cx, cy);

  ctx.beginPath();
  ctx.arc(0, 0, COMPASS_R, 0, Math.PI * 2);
  ctx.fillStyle = themeName === 'light'
    ? 'rgba(255,255,255,.86)' : 'rgba(11,13,17,.78)';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = T.scaleLine;
  ctx.stroke();

  ctx.rotate(north);
  // **Short and narrow, so the N stays readable.** Ali: "compass pin is a bit
  // too big (occludes the N)." The needle now stops well inside the ring and
  // the letter sits in the gap between its tip and the rim.
  //
  // Two halves of one needle, because a single arrow reads as "go this way"
  // rather than "this is where north is". North is RED, which is the one
  // convention every compass ever made agrees on -- and it is a fixed red on
  // both themes rather than a palette colour, because a compass that changes
  // which end is north with the light would be worse than no compass.
  const tip = COMPASS_R - 9.5;
  ctx.beginPath();
  ctx.moveTo(0, -tip);
  ctx.lineTo(3.4, 2.5);
  ctx.lineTo(-3.4, 2.5);
  ctx.closePath();
  ctx.fillStyle = themeName === 'light' ? '#c0282e' : '#ef4b52';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, tip);
  ctx.lineTo(3.4, 2.5);
  ctx.lineTo(-3.4, 2.5);
  ctx.closePath();
  ctx.fillStyle = T.scale;
  ctx.fill();
  ctx.restore();

  // The letter stays upright: it is a label on the instrument, not part of
  // the needle, and a rotating N is a puzzle rather than a reading.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = T.scale;
  ctx.font = '700 8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // **Radius to the letter's CENTRE, so half its cap height is the clearance
  // that matters.** At 8 px that is about 2.9, so sitting it 4 px in from the
  // rim left 1 px of air and it read as touching. 5.5 in, and the needle is
  // shortened by the same amount so the letter does not gain one gap by
  // losing the other. The clearance is identical at every bearing, since both
  // the rim and the letter's path are circles about the same centre.
  const rr = COMPASS_R - 5.5;
  ctx.fillText('N', Math.sin(north) * rr, -Math.cos(north) * rr);
  ctx.restore();
}

/** Did that land on the compass? */
function tappedCompass(x, y) {
  const [cx, cy] = compassAt(cv.width / DPR, cv.height / DPR);
  return Math.hypot(x - cx, y - cy) <= COMPASS_R + 6;
}

/**
 * Turn the map back to north over a few hundred milliseconds.
 *
 * Snapping would be one line and it would also be the moment somebody loses
 * track of which way round the map is. The short way round, always: a map at
 * 350 degrees turns forward through ten, not back through three hundred and
 * fifty.
 */
let northAnim = null;
function faceNorth() {
  if (!heading) return;
  const from = ((heading + Math.PI) % (Math.PI * 2) + Math.PI * 2)
    % (Math.PI * 2) - Math.PI;
  northAnim = { from, t0: performance.now(), ms: 320 };
  const step = () => {
    if (!northAnim) return;
    const t = Math.min(1, (performance.now() - northAnim.t0) / northAnim.ms);
    heading = northAnim.from * (1 - ease(t));
    if (t >= 1) { heading = 0; northAnim = null; }
    showWhere();
    draw();
    if (northAnim) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// A scale bar, because a map with nothing under it has no other way of
// telling you how big anything is.
function drawScale(w, h) {
  const m = mpp();
  const want = Math.min(180, w * 0.28) * m;
  const pow = 10 ** Math.floor(Math.log10(want));
  const step = [1, 2, 5, 10].map(k => k * pow).find(v => v >= want) || pow * 10;
  const px = step / m;
  if (!Number.isFinite(px) || px < 20) return;
  // Bottom LEFT: the credit lives bottom right and the two overlapped.
  const x = 16, y = h - 14;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = T.scaleLine;
  ctx.beginPath();
  ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + px, y);
  ctx.lineTo(x + px, y - 4);
  ctx.stroke();
  ctx.fillStyle = T.scale;
  ctx.font = '11px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(step >= 1000 ? `${step / 1000} km` : `${step} m`, x + px / 2, y - 7);
  ctx.restore();
}

function drawRoute() {
  const line = state.route.line;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = themeName === 'light' ? 'rgba(255,255,255,.7)' : 'rgba(0,0,0,.55)';
  ctx.lineWidth = Math.max(6, Math.min(18, 26 / mpp()));
  strokeLine(line);
  ctx.strokeStyle = T.route;
  ctx.lineWidth = Math.max(3, Math.min(12, 17 / mpp()));
  strokeLine(line);
  ctx.restore();
}

function strokeLine(line) {
  ctx.beginPath();
  for (let i = 0; i < line.length; i++) {
    const X = sx(line[i][0]), Y = sy(line[i][1]);
    if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
  }
  ctx.stroke();
}

function pin(p, fill, ring) {
  if (!p) return;
  const [X, Y] = onGlass(p);
  ctx.save();
  ctx.beginPath();
  ctx.arc(X, Y, 7, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = ring;
  ctx.stroke();
  ctx.restore();
}

function drawPins() {
  // The walk from the requested point to the road it snapped to, drawn as the
  // dashed line it actually is. E358 measured this at 32.1 m and it was
  // invisible in the app; a driver who cannot see it cannot judge it.
  const r = state.route;
  if (r && r.snapFrom) walkLine(state.from, r.snapFrom);
  if (r && r.snapTo) walkLine(state.to, r.snapTo);
  pin(state.from, T.kerbTwoWay, T.bg);
  pin(state.to, T.route, T.bg);
  if (state.me) pin(state.me, T.kerbOneWay, T.bg);
}

/** Where a place is on the glass, with the map's turn applied. */
const onGlass = (p) => rot(sx(p[0]), sy(p[1]));

function walkLine(a, b) {
  if (!a || !b) return;
  const [ax, ay] = onGlass(a);
  const [bx, by] = onGlass(b);
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = T.scale;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.restore();
}

// -------------------------------------------------------------- gestures
//
// One map of live pointers and one decision per move. An earlier version had
// TWO pointerdown handlers — one starting a pan, one collecting pointers for a
// pinch — and on the first move of a two-finger gesture the pan handler had
// already run while `pinch` was still null. The map jumped by one finger's
// delta before the pinch began, and it only behaved when the second finger
// happened to arrive first, which is why it worked from one side of the
// screen and not the other.
const pts = new Map();
let drag = null, pinch = null, downAt = null, moved = 0;
function settle() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { gesturing = false; draw(); }, 120);
}

function begin() {
  drag = null;
  pinch = null;
  if (twist) return;              // a rotate-drag owns the pointer it started on
  if (pts.size === 1) {
    const [a] = pts.values();
    const [wx, wy] = worldAt(a.x, a.y);
    drag = { wx, wy };
  } else if (pts.size >= 2) {
    const [a, b] = [...pts.values()];
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const [wx, wy] = worldAt(cx, cy);
    pinch = {
      d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      // Screen angle between the two fingers. It grows CLOCKWISE, because y
      // points down, and so does the map's apparent turn -- so the heading,
      // which names what is at the top, moves the other way.
      ang: Math.atan2(b.y - a.y, b.x - a.x),
      wx, wy, scale, heading,
    };
    inputSeen.pinch++;
  }
}

/**
 * How far two fingers must twist before the map starts turning, in radians.
 *
 * **Without a threshold every pinch is also a rotation.** Two fingers never
 * scale along a perfectly fixed line, and a few degrees of wobble on a zoom
 * leaves the map a few degrees off north with nothing to say why -- which is
 * the failure that makes people distrust a rotating map. Eight degrees is
 * past the wobble and well under a deliberate turn, and once the gesture has
 * crossed it the rotation tracks from where it crossed, so the map does not
 * jump by the threshold.
 */


/**
 * Where a pointer is, relative to the canvas.
 *
 * `clientX` is the viewport; the canvas fills it today and might not tomorrow,
 * and on a phone the visual viewport moves under the layout viewport when the
 * URL bar collapses. One rect lookup removes the whole class of problem.
 */
function at(e) {
  const r = cv.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

/** What place a screen pixel is over, with the map's turn undone. */
function llAt(x, y) {
  const [ux, uy] = unrot(x, y);
  return [lonAt(ux), latAt(uy)];
}

/**
 * The world point under a screen pixel, in the units `ox`/`oy` are in.
 *
 * **Every gesture is expressed as "this place stays under this finger".**
 * Panning, pinching and twisting all move two or three of scale, heading and
 * offset at once, and chasing each with its own increment is how a pinch ends
 * up sliding the map out from under the hand. Grab the world point once when
 * the gesture starts, set the new scale and heading, then solve for the
 * offset that puts that point back where the finger now is. It is exact at
 * every frame and there is nothing to accumulate error in.
 */
function worldAt(x, y) {
  const [ux, uy] = unrot(x, y);
  return [(ux - ox) / scale, (uy - oy) / scale];
}

/** Put a world point back under a screen pixel, at the current scale/heading. */
function place(wx, wy, x, y) {
  const [ux, uy] = unrot(x, y);
  ox = ux - wx * scale;
  oy = uy - wy * scale;
}

// Right-drag or shift-drag turns the map, which is where every other map puts
// it. The angle is taken about the middle of the screen rather than about the
// pointer's own starting position: a twist has to be about something, and the
// centre is the only point a mouse can express.
cv.addEventListener('contextmenu', (e) => {
  // Only when the right button was actually used to turn the map. A plain
  // right-click anywhere else on the page still gets its menu.
  if (twist || twistArmed) e.preventDefault();
});

cv.addEventListener('pointerdown', (e) => {
  // **Capture is best-effort.** It throws when the browser does not consider
  // the id an active pointer, and an exception here used to abort the handler
  // BEFORE the pointer was recorded -- so a second finger never joined, `pinch`
  // stayed null, and a two-finger gesture ran the one-finger pan path. That is
  // exactly what "the thing I'm pinching in on is flying away" looks like.
  try { cv.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
  const [x, y] = at(e);
  // **Dragging the compass turns the map, and this is the discoverable way.**
  // Right-drag, shift-drag and shift-wheel all need somebody to already know
  // they exist, and a trackpad cannot express a twist at all -- so the one
  // control that is visibly about which way round the map is also works.
  // A tap on it still faces north; the two are told apart by travel, the same
  // rule as the drawer handle.
  if (tappedCompass(x, y)) {
    // **Spun about the compass, not about the middle of the screen.** The
    // needle is what the hand is on, and a compass in the corner subtends
    // almost no angle at the view centre -- a 100 px drag there moved the map
    // by less than a degree, which reads as a control that does not work.
    const [kx, ky] = compassAt(cv.width / DPR, cv.height / DPR);
    twistArmed = true;
    twist = { a0: Math.atan2(y - ky, x - kx), b0: heading, pivot: [kx, ky],
              id: e.pointerId, from: [x, y], onCompass: true };
    pts.clear();
    drag = null;
    pinch = null;
    return;
  }
  if (e.pointerType === 'mouse' && (e.button === 2 || e.shiftKey)) {
    twistArmed = true;
    twist = { a0: Math.atan2(y - viewCy(), x - viewCx()), b0: heading,
              id: e.pointerId };
    pts.clear();
    drag = null;
    pinch = null;
    return;
  }
  pts.set(e.pointerId, { id: e.pointerId, x, y });
  if (pts.size === 1) { downAt = [x, y]; moved = 0; }
  begin();
});

cv.addEventListener('pointermove', (e) => {
  const [mx, my] = at(e);
  // **The twist is checked FIRST, and before the `pts` guard.** A rotate-drag
  // deliberately empties `pts` -- it is not a pan and must not also be one --
  // so every later test in this handler is false for it, including the one
  // that returns early. Put below that guard it silently did nothing.
  if (twist) {
    if (twist.from) {
      twist.moved = Math.max(twist.moved || 0,
        Math.hypot(mx - twist.from[0], my - twist.from[1]));
    }
    // **A gesture whose end was missed must not own the pointer forever.**
    // A right-drag can lose its `pointerup` to the context menu, and a stuck
    // twist turns every later mouse move into a rotation -- so the map spins
    // and nothing else works, which is exactly what "pinching doesn't really
    // work anymore, nor does rotation" looks like from the outside. `buttons`
    // is the ground truth about what is held down; ask it every move.
    if (e.buttons === 0) { endTwist(); return; }
    const [px_, py_] = twist.pivot || [viewCx(), viewCy()];
    const a = Math.atan2(my - py_, mx - px_);
    heading = twist.b0 - (a - twist.a0);
    gestureFrame();
    return;
  }
  // Hovering the drawn route picks the instruction that stretch belongs to.
  // Only when no gesture is in flight: a finger dragging the map is panning,
  // not pointing at a step.
  if (!pts.size && state.steps.length) {
    const [hlon, hlat] = llAt(mx, my);
    const st = stepAt(hlon, hlat, Math.max(12, 14 * mpp()));
    if (st !== state.hover) {
      setHover(st, st
        ? document.querySelector(`#steps li[data-step="${state.steps.indexOf(st)}"]`)
        : null);
    }
  }
  // **No street view under the cursor.** It was built and it was confusing:
  // a driver's-eye view that swings about while you are reading a map is
  // answering a question nobody asked. The window belongs to a journey now,
  // and `/embed/v1/streetview` is the way to ask for one deliberately.
  if (!pts.has(e.pointerId)) return;
  pts.set(e.pointerId, { id: e.pointerId, x: mx, y: my });
  if (pts.size >= 2 && pinch) {
    const [a, b] = [...pts.values()];
    const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    // Twist, past the slop and measured from where it crossed.
    let da = Math.atan2(b.y - a.y, b.x - a.x) - pinch.ang;
    da = ((da + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    if (pinch.turning || Math.abs(da) > TWIST_SLOP) {
      if (!pinch.turning) {
        pinch.turning = true;
        inputSeen.twist++;
        pinch.ang += Math.sign(da) * TWIST_SLOP;
        da -= Math.sign(da) * TWIST_SLOP;
      }
      heading = pinch.heading - da;
    }
    scale = pinch.scale * (d / pinch.d);
    // Scale and heading first, then put the place that was between the two
    // fingers back between them. Zoom, pan and turn in one gesture, exactly.
    place(pinch.wx, pinch.wy, cx, cy);
    gestureFrame();
  } else if (pts.size === 1 && drag) {
    place(drag.wx, drag.wy, mx, my);
    if (downAt) moved = Math.max(moved, Math.hypot(mx - downAt[0],
                                                   my - downAt[1]));
    gestureFrame();
  }
});

function endTwist() {
  if (!twist) return;
  // A press on the compass that never travelled is a tap, and a tap on the
  // compass is the whole reason it is a control and not a readout.
  const tap = twist.onCompass && (twist.moved || 0) < 6;
  twist = null;
  setTimeout(() => { twistArmed = false; }, 0);
  if (tap) faceNorth(); else gestureFrame();
}

// Any of these means the gesture is over, whoever forgot to say so.
addEventListener('blur', endTwist);
addEventListener('pointerup', endTwist);
addEventListener('pointercancel', endTwist);

const lift = (e) => {
  if (twist) { endTwist(); return; }
  const wasLast = pts.size === 1;
  const [x, y] = at(e);
  pts.delete(e.pointerId);
  begin();
  // A tap is a pointer that went down and up without travelling. Ten pixels
  // is the slack a thumb needs; below it the map would set a destination
  // every time somebody tried to pan.
  if (wasLast && downAt && moved < 10 && !EMBED) {
    const [tlon, tlat] = llAt(x, y);
    onTap(tlon, tlat);
  }
  downAt = null;
};
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);

/**
 * Two fingers orbiting each other on a trackpad.
 *
 * Ali: "I put both my fingers on the mouse pad and then I rotate them like
 * two planets orbiting around each other ... This actually works in Google
 * Maps."
 *
 * It does, and this is the event it works through. A trackpad rotate reaches
 * the page as `gesturestart` / `gesturechange` / `gestureend` -- WebKit's, not
 * a standard, and implemented in Blink **only on macOS**. They carry the whole
 * gesture as two cumulative numbers, `scale` and `rotation` in degrees, so a
 * pinch and a twist arrive together and the map does both at once, which is
 * what the hand is actually doing.
 *
 * **On Windows and Linux the browser never tells the page**: a precision
 * touchpad's pinch is translated into `wheel` with `ctrlKey`, and its rotation
 * is translated into nothing at all. There is no API to read it and no trick
 * that recovers it -- which is why the compass drags, and why shift-wheel and
 * right-drag exist. `__alimaps.inputs()` says which of these a given machine
 * actually delivers, so the question can be settled by looking rather than by
 * guessing at a user agent.
 *
 * The anchor is the pointer, as everywhere else: the place under the cursor
 * when the gesture started is still under it when the gesture ends.
 */
let gesture = null;
const inputSeen = { wheel: 0, wheelCtrl: 0, wheelShift: 0, gesture: 0,
                    pinch: 0, twist: 0 };

function onGestureStart(e) {
  e.preventDefault();
  inputSeen.gesture++;
  const [x, y] = at(e);
  const [wx, wy] = worldAt(x, y);
  gesture = { wx, wy, x, y, scale, heading,
              sc0: e.scale || 1, rot0: e.rotation || 0 };
}

function onGestureChange(e) {
  e.preventDefault();
  if (!gesture) return;
  const [x, y] = Number.isFinite(e.clientX) ? at(e) : [gesture.x, gesture.y];
  scale = gesture.scale * Math.max(0.02, (e.scale || 1) / gesture.sc0);
  // Degrees, positive clockwise. The map's content turning clockwise means
  // the compass direction at the top has gone the other way, which is the
  // same sign the two-finger pinch uses.
  let d = ((e.rotation || 0) - gesture.rot0) * Math.PI / 180;
  if (gesture.turning || Math.abs(d) > TWIST_SLOP) {
    // Past the slop and measured from where it crossed, so the map does not
    // jump by the threshold -- the same rule as a touch twist, and for the
    // same reason: a pinch is never a perfectly fixed line.
    if (!gesture.turning) {
      gesture.turning = true;
      gesture.rot0 += Math.sign(d) * TWIST_SLOP * 180 / Math.PI;
      d -= Math.sign(d) * TWIST_SLOP;
    }
    heading = gesture.heading - d;
  }
  place(gesture.wx, gesture.wy, x, y);
  gestureFrame();
}

function onGestureEnd(e) {
  e.preventDefault();
  gesture = null;
  settle();
}

for (const [name, fn] of [['gesturestart', onGestureStart],
                          ['gesturechange', onGestureChange],
                          ['gestureend', onGestureEnd]]) {
  cv.addEventListener(name, fn, { passive: false });
}

/**
 * The wheel, which on a desktop is three different input devices wearing one
 * event, and telling them apart is the whole of making a trackpad feel right.
 *
 * * **A mouse notch** arrives as a large `deltaY` -- 100 or so, or 3 in
 *   `deltaMode` 1, which is lines and not pixels. A factor tuned for pixels
 *   makes a line-mode mouse move the map by a hair per notch.
 * * **A trackpad pinch** arrives as `wheel` with `ctrlKey` set and NO control
 *   key held: the browser synthesises it, and the deltas are small and
 *   continuous. Ali: "pinching on desktop doesnt really work anymore." At the
 *   mouse's factor a pinch is a crawl, so it gets its own, and every map
 *   library ends up here.
 * * **A trackpad two-finger scroll** is an ordinary `deltaY`, which we zoom
 *   on, because there is nothing to scroll.
 *
 * And **shift + wheel is horizontal scroll on Windows**, so the rotation
 * reads `deltaX` before `deltaY` -- shift-wheeling a rotation with only
 * `deltaY` is shift-wheeling nothing at all, which is the other half of "nor
 * does rotation".
 */
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  // **A macOS pinch fires a gesture AND a ctrl-wheel for the same fingers.**
  // Acting on both zooms twice as fast as the hand is moving.
  if (gesture) return;
  const [px, py] = at(e);
  inputSeen.wheel++;
  if (e.ctrlKey) inputSeen.wheelCtrl++;
  if (e.shiftKey) inputSeen.wheelShift++;
  // `deltaMode` 1 is lines, 2 is pages. Normalise to something like pixels.
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  if (e.shiftKey) {
    const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
    heading -= d * unit * 0.004;
    gestureFrame();
    return;
  }
  // A synthesised pinch is finer-grained than a notch and needs more gain.
  const gain = e.ctrlKey ? 0.012 : 0.0015;
  const [wx, wy] = worldAt(px, py);
  scale *= Math.exp(-Math.max(-160, Math.min(160, e.deltaY * unit)) * gain);
  place(wx, wy, px, py);
  gestureFrame();
}, { passive: false });

function refresh() {
  draw();
  showWhere();
}

function gestureFrame() {
  gesturing = true;
  settle();
  noteZoom();
  draw();
  showWhere();
}

/**
 * Where the map is, said out loud and written into the address bar.
 *
 * Ali: "i need to see the zoom level (it can show momentarily or update the
 * hashtag) to investigate." Both, because they answer different questions.
 * The readout says what is true NOW, which is what you want while your finger
 * is still moving; the hash says it in a form you can copy into a message, or
 * reload, or send to whoever is going to look at the same place.
 *
 * It carries the DETAIL LEVEL as well as the zoom, because that is the thing
 * actually under investigation and "z 15.2" alone does not say which of the
 * five is on screen.
 *
 * `replaceState`, never `pushState`: a map that writes a history entry every
 * time somebody pans turns the back button into a way of retracing a gesture.
 */
let hashAt = 0;
let hashTimer = 0;

function showWhere() {
  const m = mpp();
  const z = slippyZoom();
  const scaleTxt = m > 1000 ? `${(m / 1000).toFixed(1)} km/px`
    : `${m.toFixed(m < 10 ? 1 : 0)} m/px`;
  const deg = ((heading * 180 / Math.PI) % 360 + 360) % 360;
  const el = $('where');
  if (el) {
    el.textContent = `z ${z.toFixed(1)} · ${scaleTxt}`
      + (shownLevel ? ` · ${shownLevel}` : '')
      + (deg > 0.5 && deg < 359.5 ? ` · ${Math.round(deg)}°` : '');
    // On a phone the toolbar has no room for a permanent readout, so it
    // appears while the map is moving and fades. The desktop keeps it.
    //
    // **Placed under whatever the toolbar actually is**, measured rather than
    // assumed: it wraps to two rows when the badge is long and to one when it
    // is not, and a fixed offset covers the readout in one case or floats it
    // in the middle of the map in the other.
    const top = $('top');
    if (top && getComputedStyle(el).position === 'fixed') {
      const r = top.getBoundingClientRect();
      el.style.top = `${Math.round(r.bottom + 8)}px`;
    }
    el.classList.add('show');
    clearTimeout(whereTimer);
    whereTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }
  noteHash();
}
let whereTimer = 0;

function noteHash() {
  const now = performance.now();
  if (now - hashAt < 400) {
    if (!hashTimer) {
      hashTimer = setTimeout(() => { hashTimer = 0; noteHash(); }, 420);
    }
    return;
  }
  hashAt = now;
  const w = cv.width / DPR, h = cv.height / DPR;
  const lat = latAt(h / 2), lon = lonAt(w / 2);
  const deg = ((heading * 180 / Math.PI) % 360 + 360) % 360;
  // OpenStreetMap's own order -- zoom, latitude, longitude -- because it is
  // the one anybody reading a map URL already knows.
  let hash = `#${slippyZoom().toFixed(2)}/${lat.toFixed(5)}/${lon.toFixed(5)}`;
  if (deg > 0.5 && deg < 359.5) hash += `/${deg.toFixed(0)}`;
  try { history.replaceState(null, '', hash); } catch (e) { /* file:// */ }
}

/** Put the map where a `#z/lat/lon/heading` hash says. */
function applyHash() {
  const parts = (location.hash || '').replace(/^#/, '').split('/');
  if (parts.length < 3) return false;
  const [z, lat, lon, deg] = parts.map(parseFloat);
  if (![z, lat, lon].every(Number.isFinite)) return false;
  const m = 156543.03392 * Math.cos(LAT0 * Math.PI / 180) / (2 ** z);
  scale = 111132 / m;
  ox = cv.width / DPR / 2 - lon * KX * scale;
  oy = cv.height / DPR / 2 + lat * scale;
  heading = Number.isFinite(deg) ? deg * Math.PI / 180 : 0;
  return true;
}

// ------------------------------------------------------------- navigation
//
// **The search runs in a worker.** Ali: "is the A* pathfinding a web worker?
// Should it be?" It was not; it is now, and the measurement is why: a route
// blocked the main thread for 163 to 196 ms in one long task, which is three
// to four frames' worth and well past the fifty milliseconds at which a
// person feels a freeze. `route.worker.js` owns the tile store, the plan, the
// search and the flood for unreachable road, and posts back plain data.

let routeWorker = null;
let routeSeq = 0;
const routeWaiting = new Map();

function ensureRouteWorker() {
  if (routeWorker !== null) return routeWorker;
  try {
    const tag = document.querySelector('script[src*="app.js"]');
    const src = (tag && tag.src) || '';
    const q = src.includes('?v=') ? '?v=' + src.split('?v=')[1] : '';
    routeWorker = new Worker(`${ROOT}route.worker.js${q}`, { type: 'module' });
    routeWorker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'tile') {
        noteTile(m.level, m.x, m.y, m.bytes, m.zoom, m.onRoute);
        return;
      }
      if (m.type === 'plan') {
        noteArtery(m.line);
        return;
      }
      const waiter = routeWaiting.get(m.id);
      if (!waiter) return;
      routeWaiting.delete(m.id);
      if (m.type === 'error') waiter.reject(new Error(m.message));
      else waiter.resolve(m);
    };
    routeWorker.onerror = () => {
      // A worker that will not start is not a reason to have no routing.
      routeWorker = false;
      for (const w of routeWaiting.values()) {
        w.reject(new Error('the routing worker did not start'));
      }
      routeWaiting.clear();
    };
  } catch (e) {
    routeWorker = false;
  }
  return routeWorker;
}

/** Ask the worker for a route. Falls back to this thread if it cannot run. */
function routeInWorker(area, from, to) {
  const w = ensureRouteWorker();
  if (!w) {
    // No worker: do it here rather than not at all. It janks, and it works.
    return planAndRoute(area.store, from, to, { endBlocks: END_BLOCKS })
      .then((res) => ({ local: true, res }));
  }
  const id = ++routeSeq;
  return new Promise((resolve, reject) => {
    routeWaiting.set(id, { resolve, reject });
    w.postMessage({ type: 'route', id, base: area.base, from, to,
                    endBlocks: END_BLOCKS });
  });
}

function onTap(lon, lat) {
  if (!state.from || (state.from && state.to)) {
    state.from = [lon, lat];
    state.to = null;
    state.route = null;
    state.steps = [];
    $('nav').classList.remove('open');
    hint('Now tap where you are going.');
  } else {
    state.to = [lon, lat];
    hint(null);
    go();
  }
  draw();
}

function hint(text) {
  const el = $('hint');
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = text;
}

function fmtM(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`
    : `${Math.round(m)} m`;
}

function fmtS(s) {
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')}`;
}

async function go(k = state.k) {
  const area = areaFor(state.from) || areaFor(state.to) || state.areas[0];
  if (!area || !area.store) return;
  hint('Routing…');
  try {
    const msg = await span('route',
      () => routeInWorker(area, state.from, state.to));
    const res = msg.local ? msg.res : fromWorker(msg, area);
    if (!res.route) {
      state.route = null;
      showFailure(res, area, k);
      draw();
      return;
    }
    res.snapFrom = res.route.line[0];
    res.snapTo = res.route.line[res.route.line.length - 1];
    state.route = res.route;
    state.route.snapFrom = res.snapFrom;
    state.route.snapTo = res.snapTo;
    state.steps = buildSteps(res, area);
    markUnreached(res);
    showRoute(res, area);
    hint(null);
    // The route is overlay, not scene, so nothing else was going to ask for a
    // frame. Without this it appeared only when the next pan or zoom happened
    // to repaint -- which looked exactly like the router having failed.
    draw();
    // Outside the try: the catch below reports "some routing tiles did not
    // arrive", and a fault in the 3d window is not that. Conflating them sent
    // a correct 2.85 km route back as a transport failure.
    queueMicrotask(() => drawNav3d(null));

    // **Street names come AFTER the route, never before it.** Ali: "it seems
    // navigation depends on name JSONs being loaded? not really correct,
    // right?" Right -- the route is complete without them. A name decorates
    // an instruction; it is not part of knowing where to drive. Awaiting them
    // made every journey wait on a dozen extra requests, and a slow or failed
    // name tile held up a route that was already computed.
    //
    // The corridor is 55 tiles for a cross-town journey and 50 of those are
    // the blocks at the two ends, which contribute no instruction and so no
    // name worth having, so only the tiles the route itself runs through are
    // fetched.
    ensureNames(area, routeNameTiles(area, res.route)).then(() => {
      if (state.route !== res.route) return;     // a newer journey won
      state.steps = buildSteps(res, area);
      showRoute(res, area);
      draw();
    }).catch(() => { /* an instruction without a street name is still one */ });
  } catch (err) {
    // A tile that is missing and a tile that failed are different facts, and
    // only one of them may be quiet. The store throws on the second; saying
    // "no route" here would be the silent hole all over again.
    hint(null);
    $('nav').classList.add('open');
    $('navdist').textContent = 'Could not load the map';
    $('navtime').textContent = '';
    $('steps').innerHTML = '';
    $('navfoot').innerHTML = `<span class="err">${err.message}</span><br>` +
      'Some routing tiles did not arrive, so the answer would have a hole in ' +
      'it. This is reported rather than shown as "no route".';
  }
}

/**
 * The worker's plain data, shaped like what the page already expected.
 *
 * A `Subgraph` does not cross a thread boundary -- tens of thousands of nodes
 * and edges would cost about what the search does to copy -- so the worker
 * flattens each leg to its own two endpoints and shape, and does the flooding
 * and the diagnosis that needed the graph before it lets go of it.
 */
function fromWorker(m, area) {
  area.classIds = m.classIds || area.classIds;
  return {
    route: m.route || null,
    plan: m.hasPlan ? {} : null,
    stats: m.stats,
    walkStartM: m.walkStartM,
    walkEndM: m.walkEndM,
    corridor: m.corridor || [],
    legs: m.legs || [],
    unreached: m.unreached || [],
    why: m.why || null,
  };
}

function showFailure(res, area, k) {
  $('nav').classList.add('open');
  $('navdist').textContent = 'No route';
  $('navtime').textContent = '';
  $('steps').innerHTML = '';
  const d = { text: res.why || 'No route.' };
  const more = k < 8
    ? '<br><button id="tryk">Try more roads (k = 8)</button>'
    : '';
  $('navfoot').innerHTML =
    `${d.text}<br><b>${res.stats.fineTiles}</b> fine tiles, ` +
    `<b>${res.stats.requests}</b> requests, <b>${res.stats.kilobytes}</b> kB.` +
    more;
  const btn = $('tryk');
  // k > 1 is the largest measured app lever — 22.2 of An Narjis's 24.5 points
  // (E357) — and its limit is Ali's to set, because rescued journeys walk
  // p50 46 m and p90 102 m (E354). So the page offers it and never takes it.
  if (btn) btn.onclick = () => { state.k = 8; go(8); };
}

function showRoute(res, area) {
  state.corridor = res.corridor || [];
  // The diagnostics left the footer, so they live here: whoever is tuning the
  // router still needs them, and a test that asserted on the footer text was
  // asserting on a proxy for them anyway.
  state.stats = res.stats || null;
  const r = res.route;
  $('nav').classList.add('open');
  $('navdist').textContent = fmtM(r.metres);
  $('navtime').textContent = fmtS(r.seconds) + (area.hasSpeeds ? '' : ' (assumed)');
  const ol = $('steps');
  ol.innerHTML = '';
  state.steps.forEach((s, i) => {
    const li = document.createElement('li');
    li.dataset.step = String(i);
    li.innerHTML =
      `<span class="turn${s.kind === 'walk' ? ' walk' : ''}">` +
      `${s.side || (s.kind === 'uturn' ? 'U' : '·')}</span>` +
      `<span class="what">${s.text}` +
      (s.name ? ` <span class="name">onto ${escape_(s.name)}</span>` : '') +
      `</span><span class="d">${fmtM(s.distM)}</span>`;
    // Pointer events rather than mouse, so a tap on a phone does the same
    // thing a hover does on a desktop.
    li.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'touch') setHover(s, li);
    });
    li.addEventListener('pointerdown', () => setHover(s, li));
    ol.appendChild(li);
  });
  // **A touch does not "leave".** Ali: "when clicking the stages on mobile,
  // highlight just as hover happens on desktop." It did highlight -- for one
  // frame. A finger's pointer is destroyed when it lifts, so `pointerleave`
  // fired immediately after the tap and cleared the very highlight the tap
  // had just set. A mouse leaving the list means the pointer is somewhere
  // else and the highlight is over; a finger lifting means nothing of the
  // kind, and the tapped stage stays lit until another is tapped.
  ol.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'touch') setHover(null, null);
  });
  // **Nothing under the list on a successful route.** The plan and route
  // milliseconds, the corridor tile count and the kilobytes are facts about
  // the program rather than about the journey; they belong to whoever is
  // tuning it, and `__alimaps.spans()` and the stats card still have them.
  // The walk at each end is a STAGE now (`withWalks`), so the only thing the
  // footer was still carrying was a number nobody had decided about.
  $('navfoot').innerHTML = '';
  void area;
  sizeDrawer();
}

/**
 * Three rows, measured rather than assumed.
 *
 * Ali: "on the nav drawer, show only 3 rows." A hard pixel height is three
 * rows in one language and two in another -- an Arabic street name wraps, the
 * type size moves with the system, and the drawer then shows two and a half
 * instructions and a sliver. So the height comes from a row that has actually
 * been laid out, and the list keeps whatever it has left to scroll.
 */
function sizeDrawer() {
  const ol = $('steps');
  if (!ol || !ol.firstElementChild) return;
  const rows = [...ol.children].slice(0, 3);
  const h = rows.reduce((a, li) => a + li.getBoundingClientRect().height, 0);
  if (h > 0) ol.style.setProperty('--rows', `${Math.round(h)}px`);
}

function setHover(step, li) {
  if (state.hover === step) return;
  state.hover = step;
  for (const el of document.querySelectorAll('#steps li')) {
    el.classList.toggle('on', el === li);
  }
  drawNav3d(step);
  draw();
}

function escape_(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function areaFor(p) {
  if (!p) return null;
  for (const a of state.areas) {
    const b = a.bounds;
    if (p[0] >= b[0] - 0.02 && p[0] <= b[2] + 0.02
      && p[1] >= b[1] - 0.02 && p[1] <= b[3] + 0.02) return a;
  }
  return null;
}


// ------------------------------------------------------------ the 3d window
//
// A driver's-eye view of whichever instruction the pointer is over.
//
// **Why it earns its place.** Drawn in plan as lines, a route is a claim you
// cannot check: a five-degree kink and a clean junction look identical from
// above. Give the centreline its measured width, pitch the camera onto it, and
// the claim becomes inspectable -- the same argument the corpus review sheets
// make, and the reason a district is judged on pictures rather than on numbers
// alone.
//
// Frame conventions are `nav3d.ts`'s, deliberately: world is local metres east
// and north of an origin; camera space is heading-up, +y where the vehicle
// points, +x to its right. A sign error here would be a sign error there.
//
// **The geometry is welded and smoothed in a worker** (`nav3d.worker.js`), and
// that smoothing is display-only: the corpus cannot draw a curve and nothing
// here changes that. A 6 m ribbon on the horizon shows every 3-degree kink as
// a notch, and a notch that is not in the road is as much of a lie as a
// missing street.

/** Camera height above the road, metres. */
const EYE_M = 5.5;

/** How far ahead it can see, and how far the worker is asked to weld. */
const FAR_M = 420;
const LOD_M = 520;

/** Horizontal field of view. */
const FOV_DEG = 72;

/** How long the camera takes to travel between two instructions. */
const CAM_TWEEN_MS = 850;

const cam = {
  lon: 0, lat: 0, heading: 0,
  yaw: 0,          // look left/right, from dragging
  pitch: 0,        // look up/down, from dragging
  back: 18,        // how far behind the anchor, from pinching
  ready: false,
};
let camTween = null;     // {from, to, start}
let camRaf = 0;

/** Worker-built geometry, in local metres about `geo.origin`. */
const geo = { origin: null, chains: [], id: 0, worker: null, building: false };

function nav3dCanvas() {
  return document.getElementById('nav3d');
}

/** Whatever this area has already decoded, finest first. Fetches nothing. */
function loadedGroups(area) {
  const out = [];
  for (const lv of area.index.levels) {
    if (!lv.tiled) continue;
    for (const [key, lines] of area.tiles) {
      if (key.endsWith(lv.suffix) || (lv.suffix === '' && !key.includes('.'))) {
        out.push(lines);
      }
    }
    if (out.length) return out;
  }
  return area.overview ? [area.overview] : [];
}

function ensureWorker() {
  if (geo.worker) return geo.worker;
  try {
    // The same version the page was stamped with, so a cached worker cannot
    // pair with a newer app.
    const v = (document.querySelector('script[src*="app.js"]') || {}).src || '';
    const q = v.includes('?v=') ? '?v=' + v.split('?v=')[1] : '';
    geo.worker = new Worker(`${ROOT}nav3d.worker.js${q}`, { type: 'module' });
  } catch {
    return null;                       // no worker: the view falls back below
  }
  geo.worker.onmessage = (e) => {
    const m = e.data;
    if (m.type !== 'geometry' || m.id !== geo.id) return;
    for (let i = 0; i < m.offsets.length - 1; i++) {
      geo.chains.push({
        pts: m.pts.subarray(m.offsets[i], m.offsets[i + 1]),
        widthM: m.widths[i],
        oneway: m.oneway[i] !== 0,
      });
    }
    geo.building = !m.done;
    // Streamed, so the view fills as it is welded rather than after a pause.
    paintNav3d();
  };
  return geo.worker;
}

/** Ask the worker for everything within the LOD radius of this anchor. */
/**
 * Rebuild the driver's-eye geometry around a place -- at most one at a time,
 * and never for a place the geometry already covers.
 *
 * Ali: "for some reason there is a huge slowdown when hovering over the
 * navigation segments?" Measured, sweeping a pointer down nine instructions:
 * **ten geometry rebuilds, nine long tasks, worst 119 ms, 740 ms of blocked
 * main thread.** Every row the pointer crossed threw away the welded and
 * smoothed geometry and built it again, including the rows it crossed on the
 * way to the one somebody actually wanted.
 *
 * Two rules, and the first is the one that matters:
 *
 * * **A rebuild the LOD radius already covers is not a rebuild.** The worker
 *   welds everything within `LOD_M` of the anchor, so moving the anchor a
 *   hundred metres inside that disc changes nothing it would produce. Only
 *   the camera moves.
 * * **Coalesce the rest.** A sweep down a list is a sequence of places
 *   nobody is looking at yet; one timer turns it into a single build of the
 *   place the pointer stopped on.
 *
 * The camera is NOT delayed by either -- it starts travelling immediately,
 * which is the part that has to feel instant.
 */
const GEO_SETTLE_MS = 140;

/** Inside this fraction of the LOD radius, the built geometry still serves. */
const GEO_REUSE = 0.35;

let geoTimer = 0;
let geoWanted = null;

function requestGeometry(lon, lat) {
  geoWanted = [lon, lat];
  if (geo.origin && !geo.building) {
    const [ox_, oy_] = geo.origin;
    const k = 111320 * Math.cos(lat * Math.PI / 180);
    if (Math.hypot((lon - ox_) * k, (lat - oy_) * 111132)
        < LOD_M * GEO_REUSE) {
      return;                       // already welded; the camera is enough
    }
  }
  if (geoTimer) return;
  geoTimer = setTimeout(() => {
    geoTimer = 0;
    const want = geoWanted;
    if (want) buildGeometry(want[0], want[1]);
  }, GEO_SETTLE_MS);
}

function buildGeometry(lon, lat) {
  const area = state.areas.find((a) => a.index);
  const w = ensureWorker();
  if (!area || !w) return;
  geo.id++;
  geo.chains = [];
  geo.origin = [lon, lat];
  geo.building = true;
  w.postMessage({
    type: 'build',
    id: geo.id,
    base: area.base,
    suffix: area.index.levels[0].suffix,
    zoom: area.index.zoom,
    tileList: area.index.tiles,
    origin: geo.origin,
    anchor: [lon, lat],
    lodM: LOD_M,
  });
}

const easeIO = (t) => (t < 0.5 ? 4 * t * t * t
  : 1 - Math.pow(-2 * t + 2, 3) / 2);

function shortestTurn(from, to) {
  return ((to - from + 540) % 360) - 180;
}

/**
 * Point the camera at a step, travelling rather than teleporting.
 *
 * Ali: "add tweening for movement when hovering over different navigation
 * stages." Cutting between two junctions a kilometre apart gives no sense of
 * which way the route went; moving between them does, and it costs one eased
 * interpolation.
 */
function drawNav3d(step) {
  const shell = document.getElementById('nav3dwrap');
  const route = state.route;
  // Only while there is a journey, or when an embed asked for street view
  // outright. Ali: "lets hide it when not navigating, effect is confusing."
  const pts = (step && step.pts && step.pts.length >= 2)
    ? step.pts
    : (route && route.line.length >= 2 ? route.line : null);
  const wanted = view3d || EMBED_MODE === 'streetview';
  if (!pts || !wanted || (!route && EMBED_MODE !== 'streetview')) {
    if (shell) shell.classList.remove('open');
    return;
  }
  if (shell) shell.classList.add('open');

  const a = pts[0];
  const b = pts[Math.min(1, pts.length - 1)];
  // `heading` takes two POINTS. Called with four numbers it returns NaN, which
  // propagates into every sine and cosine in the projection and draws a sky
  // over an empty world -- which is exactly what it did.
  const target = { lon: a[0], lat: a[1], heading: bearing(a, b) };

  const label = document.getElementById('nav3dlabel');
  if (label) {
    label.textContent = step
      ? (step.name ? `${step.text} onto ${step.name}` : step.text)
      : 'Start of the journey';
  }

  if (!cam.ready) {
    Object.assign(cam, target);
    cam.ready = true;
    cam.yaw = 0;
    cam.pitch = 0;
    requestGeometry(cam.lon, cam.lat);
    paintNav3d();
    return;
  }
  camTween = {
    from: { lon: cam.lon, lat: cam.lat, heading: cam.heading, yaw: cam.yaw },
    to: { ...target, yaw: 0 },
    start: performance.now(),
  };
  // The worker gets the destination straight away, so the geometry is welded
  // while the camera is still travelling towards it.
  requestGeometry(target.lon, target.lat);
  stepCamera();
}

function stepCamera() {
  cancelAnimationFrame(camRaf);
  const tick = () => {
    if (!camTween) { paintNav3d(); return; }
    const t = Math.min(1, (performance.now() - camTween.start) / CAM_TWEEN_MS);
    const k = easeIO(t);
    const f = camTween.from, g = camTween.to;
    cam.lon = f.lon + (g.lon - f.lon) * k;
    cam.lat = f.lat + (g.lat - f.lat) * k;
    cam.heading = f.heading + shortestTurn(f.heading, g.heading) * k;
    cam.yaw = f.yaw + (g.yaw - f.yaw) * k;
    paintNav3d();
    if (t >= 1) { camTween = null; return; }
    camRaf = requestAnimationFrame(tick);
  };
  camRaf = requestAnimationFrame(tick);
}

/** Deterministic stars, so the sky is the same one every time. */
const STARS = (() => {
  // A tiny LCG rather than Math.random: a sky that reshuffles on every repaint
  // twinkles in a way no sky does.
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const out = [];
  // Enough of them that a 72-degree window still has a sky in it: only about
  // a fifth of the horizon is visible at once, and half the elevation range
  // is above the top edge at any moment -- which is the point.
  for (let i = 0; i < 1600; i++) {
    out.push({
      az: rnd() * 360,                              // around the horizon
      // Uniform over the upper hemisphere by solid angle, so they thin out
      // towards the zenith the way a real sky does rather than piling up.
      el: Math.asin(rnd()) * 180 / Math.PI,         // 0 horizon .. 90 zenith
      m: rnd(),                                     // brightness
    });
  }
  return out;
})();

function paintNav3d() {
  const cv3 = nav3dCanvas();
  if (!cv3 || !cam.ready) return;
  const shell = document.getElementById('nav3dwrap');
  if (shell && !shell.classList.contains('open')) return;

  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = cv3.clientWidth || 300;
  const h = cv3.clientHeight || 170;
  if (cv3.width !== Math.floor(w * dpr) || cv3.height !== Math.floor(h * dpr)) {
    cv3.width = Math.floor(w * dpr);
    cv3.height = Math.floor(h * dpr);
  }
  const g = cv3.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  const view = cam.heading + cam.yaw;
  // **Plus, not minus.** To bring a heading onto +y the rotation is by the
  // heading itself; negating it puts everything ahead of the camera behind
  // it. With the minus, a point 100 m straight ahead projected to y = -100,
  // so the view was of the road already driven -- "the 3d navigation seems to
  // be not in the direction of the car".
  const rad = view * Math.PI / 180;
  const cosH = Math.cos(rad), sinH = Math.sin(rad);
  const kx = 111320 * Math.cos(cam.lat * Math.PI / 180);
  const f = (w / 2) / Math.tan((FOV_DEG * Math.PI / 180) / 2);
  const horizon = h * 0.42 + cam.pitch * (h / 90);

  // Local metres about the worker's origin, relative to the camera.
  const ox = geo.origin ? (cam.lon - geo.origin[0]) * kx : 0;
  const oy = geo.origin ? (cam.lat - geo.origin[1]) * 111132 : 0;
  const toCam = (mx, my) => {
    const e = mx - ox, n = my - oy;
    const x = e * cosH - n * sinH;
    const y = e * sinH + n * cosH;
    return [x, y + cam.back];
  };
  const toCamLL = (lon, lat) =>
    toCam((lon - (geo.origin ? geo.origin[0] : cam.lon)) * kx + (geo.origin ? 0 : 0),
          (lat - (geo.origin ? geo.origin[1] : cam.lat)) * 111132);
  const project = (x, y) => {
    if (y < 1.2) return null;
    return [w / 2 + (f * x) / y, horizon + (f * EYE_M) / y];
  };

  // --- sky -----------------------------------------------------------------
  g.clearRect(0, 0, w, h);
  const sky = g.createLinearGradient(0, 0, 0, Math.max(1, horizon));
  sky.addColorStop(0, T.sky0);
  sky.addColorStop(1, T.sky1);
  g.fillStyle = sky;
  g.fillRect(0, 0, w, Math.max(0, horizon));

  // Stars as DIRECTIONS, projected the same way the ground is.
  //
  // The first version mapped altitude onto the visible band -- `y = horizon *
  // (1 - alt)` -- so every star was always on screen and the sky slid about
  // like a backdrop on rollers. Ali: "no star is ever out of sight vertically.
  // this must be true to give depth effect." A gnomonic projection fixes it:
  // `tan` of the elevation, so a star overhead is far above the top edge and
  // pitching the view genuinely moves the sky past you.
  g.save();
  g.beginPath();
  g.rect(0, 0, w, Math.max(0, horizon));
  g.clip();
  for (const st of (T.stars ? STARS : [])) {
    const relAz = ((st.az - view + 540) % 360) - 180;
    if (Math.abs(relAz) > 80) continue;            // behind, or nearly so
    const x = w / 2 + f * Math.tan(relAz * Math.PI / 180);
    if (x < -8 || x > w + 8) continue;
    const y = horizon - f * Math.tan(st.el * Math.PI / 180);
    if (y < -8 || y > horizon) continue;
    const r = 0.4 + st.m * 0.9;
    g.globalAlpha = 0.25 + st.m * 0.65;
    g.fillStyle = st.m > 0.93 ? T.starBright : T.star;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  g.restore();

  // --- ground --------------------------------------------------------------
  g.fillStyle = T.ground;
  g.fillRect(0, Math.max(0, horizon), w, h - Math.max(0, horizon));
  g.strokeStyle = T.horizon;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, horizon);
  g.lineTo(w, horizon);
  g.stroke();

  // --- roads ---------------------------------------------------------------
  //
  // **One contiguous ribbon per welded chain, not a quad per segment.** Ali:
  // "the segments should not be vertex shader on the borders, it looks like
  // rectangles/tiles forming a pathway. we should have a contiguous path with
  // outer border." Exactly so -- stroking every quad draws the cross-seams
  // between them, and a road becomes a row of paving slabs.
  //
  // So each chain is offset to a left and a right edge, filled once as a
  // single polygon, and stroked only along those two outer edges. The joins
  // are mitred, with a limit: at a sharp bend an unlimited mitre shoots off to
  // infinity and puts a spike through the neighbouring block.
  const ribbons = [];
  const NEAR = 1.5;
  const addRibbon = (cpts, width, ow) => {
    // **Clip at the near plane, do not drop.** The first version discarded any
    // vertex behind the camera and then discarded the whole ribbon if any
    // vertex failed to project -- so turning the view made roads vanish and
    // reappear whole. Ali: "the culling algorithm makes roads flicker when
    // rotating here and there." Interpolating the crossing keeps the ribbon
    // continuous right up to the edge of vision, which is what a road does.
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        let near = Infinity;
        for (const q of run) near = Math.min(near, q[1]);
        ribbons.push({ pts: run, w: width, ow, d: near });
      }
      run = [];
    };
    const cross = (a, b) => {
      // Where the segment a-b crosses y = NEAR.
      const t = (NEAR - a[1]) / (b[1] - a[1]);
      return [a[0] + (b[0] - a[0]) * t, NEAR];
    };
    for (let i = 0; i < cpts.length; i++) {
      const cur = cpts[i], prev = cpts[i - 1];
      const inNow = cur[1] >= NEAR;
      const inPrev = prev ? prev[1] >= NEAR : inNow;
      if (prev && inNow !== inPrev) {
        const at = cross(inPrev ? prev : cur, inPrev ? cur : prev);
        if (inPrev) { run.push(at); flush(); } else { run = [at]; }
      }
      if (inNow) run.push(cur);
      else if (!prev || inPrev) { /* already flushed */ }
    }
    flush();
  };

  if (geo.chains.length) {
    for (const c of geo.chains) {
      const p2 = c.pts;
      const cpts = [];
      for (let i = 0; i + 1 < p2.length; i += 2) {
        cpts.push(toCam(p2[i], p2[i + 1]));
      }
      addRibbon(cpts, c.widthM || 6, c.oneway);
    }
  } else {
    for (const area of state.areas) {
      if (!area.index) continue;
      for (const group of loadedGroups(area)) {
        for (const l of group) {
          const p2 = l.pts;
          const cpts = [];
          for (let i = 0; i + 1 < p2.length; i += 2) {
            cpts.push(toCamLL(p2[i], p2[i + 1]));
          }
          addRibbon(cpts, l.widthM || 6, l.oneway);
        }
      }
    }
  }
  ribbons.sort((x, y) => y.d - x.d);

  /** Left and right edges of a centreline, mitred at the joins. */
  const edges = (pts, half) => {
    const left = [], right = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[i - 1], cur = pts[i], next = pts[i + 1];
      let nx = 0, ny = 0;
      const norm = (p1, p2) => {
        const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
        const len = Math.hypot(dx, dy) || 1;
        return [-dy / len, dx / len];
      };
      if (prev && next) {
        const n1 = norm(prev, cur), n2 = norm(cur, next);
        nx = n1[0] + n2[0];
        ny = n1[1] + n2[1];
        const len = Math.hypot(nx, ny) || 1;
        nx /= len; ny /= len;
        // Mitre length grows as 1/cos(theta/2); cap it so a hairpin does not
        // throw a spike across the view.
        const cosHalf = Math.max(0.35, nx * n1[0] + ny * n1[1]);
        nx /= cosHalf; ny /= cosHalf;
      } else {
        const n = prev ? norm(prev, cur) : norm(cur, next);
        nx = n[0]; ny = n[1];
      }
      left.push([cur[0] + nx * half, cur[1] + ny * half]);
      right.push([cur[0] - nx * half, cur[1] - ny * half]);
    }
    return [left, right];
  };

  for (const r of ribbons) {
    const [left, right] = edges(r.pts, r.w / 2);
    // Every point is at or beyond the near plane after clipping, but the
    // mitre offset can push one just behind it, so the projection is clamped
    // rather than allowed to fail and take the ribbon with it.
    const L = left.map((q) => project(q[0], Math.max(q[1], NEAR)));
    const R = right.map((q) => project(q[0], Math.max(q[1], NEAR)));
    if (L.some((q) => !q) || R.some((q) => !q)) continue;

    g.beginPath();
    g.moveTo(L[0][0], L[0][1]);
    for (let i = 1; i < L.length; i++) g.lineTo(L[i][0], L[i][1]);
    for (let i = R.length - 1; i >= 0; i--) g.lineTo(R[i][0], R[i][1]);
    g.closePath();
    g.fillStyle = T.carriageway;
    g.fill();

    // Only the two outer edges. No cap across the ends either: a chain that
    // runs out of the view has not ended, and drawing a line across it says
    // it has.
    g.strokeStyle = r.ow ? T.kerbOneWay : T.kerbTwoWay;
    g.globalAlpha = Math.max(0.12, 1 - r.d / FAR_M);
    g.lineWidth = 1;
    g.lineJoin = 'round';
    for (const side of [L, R]) {
      g.beginPath();
      g.moveTo(side[0][0], side[0][1]);
      for (let i = 1; i < side.length; i++) g.lineTo(side[i][0], side[i][1]);
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  // --- the route, the segment under the pointer, and where it goes next ----
  //
  // Ali: "show the whole navigation path and the highlighted segment. show
  // arrows parallel but not in line with highlighted segment. show in end of
  // segment where off next, right turn? left? straight?"
  //
  // So three things rather than one. The **whole route** dim, because an
  // instruction with no context is a road with no journey on it. The
  // **highlighted stretch** bright on top. And the arrows sit BESIDE the
  // centreline rather than along it, because a chevron drawn on the middle of
  // the carriageway hides the very geometry the window exists to show.
  /**
   * The route as a RIBBON on the road, not a line above it.
   *
   * Ali: "the navigation yellow path on the 3d view should not be so thin. it
   * should be a pathway as well, a bit thinner than a normal road." Quite
   * right: a hairline over a carriageway reads as an annotation, and what is
   * wanted is the lane you would actually be in. So it is laid out with the
   * same offset-and-mitre the roads use, at `ROUTE_W_M` -- narrower than the
   * carriageway it sits on, so the road is still visible either side of it.
   */
  const ROUTE_W_M = 4.2;
  const drawPath = (pts, fill, edge, widthM, alpha) => {
    if (!pts || pts.length < 2) return;
    // Camera space, split where it crosses behind the near plane.
    let run = [];
    const runs = [];
    for (const [lon, lat] of pts) {
      const c = toCamLL(lon, lat);
      if (c[1] < NEAR || c[1] > FAR_M * 1.5) {
        if (run.length >= 2) runs.push(run);
        run = [];
      } else {
        run.push(c);
      }
    }
    if (run.length >= 2) runs.push(run);

    g.save();
    g.globalAlpha = alpha;
    g.lineJoin = 'round';
    for (const r of runs) {
      const [left, right] = edges(r, widthM / 2);
      const L = left.map((q) => project(q[0], Math.max(q[1], NEAR)));
      const R = right.map((q) => project(q[0], Math.max(q[1], NEAR)));
      if (L.some((q) => !q) || R.some((q) => !q)) continue;
      g.beginPath();
      g.moveTo(L[0][0], L[0][1]);
      for (let i = 1; i < L.length; i++) g.lineTo(L[i][0], L[i][1]);
      for (let i = R.length - 1; i >= 0; i--) g.lineTo(R[i][0], R[i][1]);
      g.closePath();
      g.fillStyle = fill;
      g.fill();
      if (edge) {
        g.strokeStyle = edge;
        g.lineWidth = 1.2;
        for (const side of [L, R]) {
          g.beginPath();
          g.moveTo(side[0][0], side[0][1]);
          for (let i = 1; i < side.length; i++) g.lineTo(side[i][0], side[i][1]);
          g.stroke();
        }
      }
    }
    g.restore();
  };

  const route = state.route;
  const hot = state.hover && state.hover.pts;

  // The whole journey first, underneath.
  if (route && route.line.length >= 2) {
    drawPath(route.line, T.routeDim, null, ROUTE_W_M * 0.85, 0.55);
  }
  // Then the stretch this instruction is about.
  drawPath(hot || (route && route.line), T.route, T.routeEdge, ROUTE_W_M, 1);

  if (hot && hot.length >= 2) {
    // Arrows offset to the side, at a fixed distance from the centreline, so
    // they read as direction without covering the road.
    const cam2 = hot.map(([lon, lat]) => toCamLL(lon, lat));
    const OFFSET_M = 5.5;
    let run = 0;
    g.fillStyle = T.route;
    for (let i = 0; i + 1 < cam2.length; i++) {
      const [x1, y1] = cam2[i], [x2, y2] = cam2[i + 1];
      const d = Math.hypot(x2 - x1, y2 - y1);
      if (d < 1e-3) continue;
      run += d;
      if (run < 34) continue;
      run = 0;
      const ux = (x2 - x1) / d, uy = (y2 - y1) / d;
      const px = -uy * OFFSET_M, py = ux * OFFSET_M;   // to the right
      const tip = project(x2 + px, y2 + py);
      const l1 = project(x2 - ux * 6.5 + px + (-uy * 2.6),
                         y2 - uy * 6.5 + py + (ux * 2.6));
      const l2 = project(x2 - ux * 6.5 + px - (-uy * 2.6),
                         y2 - uy * 6.5 + py - (ux * 2.6));
      if (!tip || !l1 || !l2) continue;
      g.beginPath();
      g.moveTo(tip[0], tip[1]);
      g.lineTo(l1[0], l1[1]);
      g.lineTo(l2[0], l2[1]);
      g.closePath();
      g.fill();
    }

    // What happens at the end of this stretch: the NEXT instruction, drawn
    // where it happens rather than only written in the list.
    const idx = state.steps.indexOf(state.hover);
    const next = idx >= 0 ? state.steps[idx + 1] : null;
    const endC = cam2[cam2.length - 1];
    const endQ = project(endC[0], endC[1]);
    if (endQ && endQ[1] > 0 && endQ[1] < h) {
      const word = next
        ? (next.kind === 'uturn' ? 'U-turn'
          : /left/i.test(next.text) ? 'Left'
          : /right/i.test(next.text) ? 'Right'
          : 'Straight on')
        : 'Arrive';
      const glyph = next
        ? (next.kind === 'uturn' ? '↶'
          : /left/i.test(next.text) ? '←'
          : /right/i.test(next.text) ? '→'
          : '↑')
        : '◉';
      const label = next && next.name ? `${word} · ${next.name}` : word;
      g.save();
      g.font = '600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
      const tw = g.measureText(label).width + 26;
      const bx = Math.max(4, Math.min(w - tw - 4, endQ[0] - tw / 2));
      const by = Math.max(4, Math.min(h - 40, endQ[1] - 34));
      g.fillStyle = 'rgba(13,15,19,.86)';
      g.strokeStyle = '#ffd166';
      g.lineWidth = 1;
      g.beginPath();
      g.roundRect(bx, by, tw, 22, 6);
      g.fill();
      g.stroke();
      g.fillStyle = '#ffd166';
      g.fillText(glyph, bx + 7, by + 16);
      g.fillStyle = '#e9edf3';
      g.fillText(label, bx + 22, by + 16);
      // A stalk down to the place it happens, so the label is anchored.
      g.strokeStyle = 'rgba(255,209,102,.6)';
      g.beginPath();
      g.moveTo(endQ[0], by + 22);
      g.lineTo(endQ[0], endQ[1]);
      g.stroke();
      g.restore();
    }
  }

  if (geo.building) {
    g.fillStyle = 'rgba(150,160,176,.65)';
    g.font = '10px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
    g.fillText('welding…', 8, h - 8);
  }
}

/**
 * Street view wherever the mouse is, when there is no journey to show.
 *
 * Ali: "as long as there is no navigation, can we show the mouse cursor
 * position street view ... or wait this needs high fidelity data, only do this
 * if we have that (meaning we need to be on right zoom level)."
 *
 * The second thought is the important one. The window draws the geometry the
 * map has loaded, and at a city zoom that is the overview level -- roads over
 * 100 m with their bends simplified away at 14 m. A driver's-eye view built
 * from that is a confident picture of a road nobody could drive, which is
 * worse than no picture. So it only opens once the FINE level is what the map
 * is showing, and it closes again on the way out.
 */
const SV_MAX_MPP = 2.0;          // the fine level's own threshold
const SV_MIN_MOVE_M = 70;        // before the worker is asked again
const SV_SNAP_M = 45;            // how far the cursor may be from a road

let svLast = null;
let svTimer = 0;

/** Is the map showing geometry good enough to stand on? */
function streetViewReady() {
  if (state.route || EMBED_MODE === 'streetview') return false;
  if (mpp() > SV_MAX_MPP) return false;
  const area = state.areas.find((a) => a.index);
  return !!area && shownLevel === area.index.levels[0].name;
}

/** The nearest road to a point, with the direction it runs. */
function roadUnder(lon, lat, withinM) {
  let best = null, bestD = withinM;
  for (const area of state.areas) {
    if (!area.index) continue;
    for (const group of loadedGroups(area)) {
      for (const l of group) {
        const p2 = l.pts;
        for (let i = 0; i + 3 < p2.length; i += 2) {
          const a = [p2[i], p2[i + 1]], b = [p2[i + 2], p2[i + 3]];
          const d = pointToSeg(lon, lat, a, b);
          if (d < bestD) { bestD = d; best = { a, b, oneway: l.oneway }; }
        }
      }
    }
  }
  if (!best) return null;
  // Stand on the road rather than beside it, and face the way it runs. A
  // one-way is only drivable one way, so that is the way to look.
  const k = 111320 * Math.cos(best.a[1] * Math.PI / 180);
  const bx = (best.b[0] - best.a[0]) * k, by = (best.b[1] - best.a[1]) * 111132;
  const px = (lon - best.a[0]) * k, py = (lat - best.a[1]) * 111132;
  const d2 = bx * bx + by * by;
  const t = d2 <= 1e-9 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / d2));
  return {
    point: [best.a[0] + (best.b[0] - best.a[0]) * t,
            best.a[1] + (best.b[1] - best.a[1]) * t],
    heading: bearing(best.a, best.b),
  };
}

function streetViewAt(lon, lat) {
  const shell = document.getElementById('nav3dwrap');
  if (!streetViewReady()) {
    if (shell && !state.route) shell.classList.remove('open');
    svLast = null;
    return;
  }
  const hit = roadUnder(lon, lat, SV_SNAP_M * Math.max(1, mpp()));
  if (!hit) { svLast = null; return; }

  if (shell) shell.classList.add('open');
  const label = document.getElementById('nav3dlabel');
  if (label) label.textContent = 'Street view · under the cursor';

  const moved = !svLast
    || metresBetween(svLast, hit.point) > SV_MIN_MOVE_M
    || !geo.origin;
  if (!cam.ready) {
    Object.assign(cam, { lon: hit.point[0], lat: hit.point[1],
                         heading: hit.heading, yaw: 0, pitch: 0 });
    cam.ready = true;
  } else {
    // The camera follows rather than jumps, which is the same tween the
    // instruction list uses and for the same reason.
    camTween = {
      from: { lon: cam.lon, lat: cam.lat, heading: cam.heading, yaw: cam.yaw },
      to: { lon: hit.point[0], lat: hit.point[1], heading: hit.heading,
            yaw: 0 },
      start: performance.now(),
    };
    stepCamera();
  }
  if (moved) {
    svLast = hit.point;
    requestGeometry(hit.point[0], hit.point[1]);
  }
  paintNav3d();
}

function metresBetween(a, b) {
  const k = 111320 * Math.cos(a[1] * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * k, (b[1] - a[1]) * 111132);
}

// ------------------------------------------------- looking around in 3d
//
// Ali: "drag and rotate on 3d view should look around, pinch zoom should work
// both on 2d and 3d." Dragging turns the head; pinching moves the camera back
// and forward along the road rather than changing a focal length, because a
// driver's view zooms by moving.

function bindNav3dGestures() {
  const cv3 = nav3dCanvas();
  if (!cv3 || cv3.dataset.bound) return;
  cv3.dataset.bound = '1';
  const live = new Map();
  let drag = null, pinch = null;

  const begin = () => {
    drag = null;
    pinch = null;
    if (live.size === 1) {
      const [a] = live.values();
      drag = { x: a.clientX, y: a.clientY, yaw: cam.yaw, pitch: cam.pitch };
    } else if (live.size >= 2) {
      const [a, b] = [...live.values()];
      pinch = {
        d: Math.max(1, Math.hypot(a.clientX - b.clientX,
                                  a.clientY - b.clientY)),
        back: cam.back,
      };
    }
  };

  cv3.addEventListener('pointerdown', (e) => {
    // Best-effort, for the same reason the map's is: an exception here used to
    // abort before the pointer was recorded, so a second finger never joined.
    try { cv3.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
    live.set(e.pointerId, e);
    begin();
    // A drag is a deliberate look; it ends any travel still in flight rather
    // than fighting it.
    camTween = null;
  });
  cv3.addEventListener('pointermove', (e) => {
    if (!live.has(e.pointerId)) return;
    live.set(e.pointerId, e);
    if (live.size >= 2 && pinch) {
      const [a, b] = [...live.values()];
      const d = Math.max(1, Math.hypot(a.clientX - b.clientX,
                                       a.clientY - b.clientY));
      cam.back = Math.max(-40, Math.min(220, pinch.back * (pinch.d / d)));
      paintNav3d();
    } else if (live.size === 1 && drag) {
      cam.yaw = drag.yaw + (e.clientX - drag.x) * 0.25;
      cam.pitch = Math.max(-38, Math.min(38,
        drag.pitch + (e.clientY - drag.y) * 0.18));
      paintNav3d();
    }
  });
  const lift = (e) => { live.delete(e.pointerId); begin(); };
  cv3.addEventListener('pointerup', lift);
  cv3.addEventListener('pointercancel', lift);
  cv3.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.back = Math.max(-40, Math.min(220,
      cam.back * Math.exp(e.deltaY * 0.0012)));
    paintNav3d();
  }, { passive: false });
  cv3.addEventListener('dblclick', () => {
    cam.yaw = 0;
    cam.pitch = 0;
    cam.back = 18;
    paintNav3d();
  });
}

/**
 * Fetch the street names for a set of fine tiles, once each.
 *
 * Global ids, tiled strings: a name repeats in every tile its road crosses,
 * which costs a few bytes and saves the client ever holding a city's worth of
 * them. Ali: "they are not needed unless 1. zoomed in or 2. navigating, and
 * not city wide."
 */
/** The name tiles a route's own geometry passes through. */
function routeNameTiles(area, route) {
  const ix = area.store.index;
  const z = (ix && ix.namesZoom) || (ix && ix.levels.fine.zoom) || 14;
  const seen = new Map();
  for (const [lon, lat] of route.line) {
    const [x, y] = tileOf(lon, lat, z);
    seen.set(`${x}/${y}`, [x, y]);
  }
  return [...seen.values()];
}

async function ensureNames(area, keys) {
  const ix = area.store.index;
  if (!ix || !ix.names) return;
  const jobs = [];
  for (const [x, y] of keys) {
    const k = `${x}/${y}`;
    if (area.namesPending.has(k)) continue;
    area.namesPending.add(k);
    const url = `${area.base}/route/`
      + ix.names.replace('{x}', String(x)).replace('{y}', String(y));
    jobs.push(fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((obj) => {
        if (!obj) return;
        for (const id of Object.keys(obj)) area.names.set(+id, obj[id]);
      })
      .catch(() => {}));
  }
  await Promise.all(jobs);
}

/**
 * Hovering the drawn route itself picks the step it belongs to.
 *
 * Ali: "if hovering over the path itself, will show that part." The hit test
 * is against the step polylines rather than the route line, because the answer
 * wanted is which INSTRUCTION this is, not which metre.
 */
function stepAt(lon, lat, withinM) {
  let best = null, bestD = withinM;
  for (const st of state.steps) {
    if (!st.pts) continue;
    for (let i = 0; i + 1 < st.pts.length; i++) {
      const d = pointToSeg(lon, lat, st.pts[i], st.pts[i + 1]);
      if (d < bestD) { bestD = d; best = st; }
    }
  }
  return best;
}

function pointToSeg(lon, lat, a, b) {
  const k = 111320 * Math.cos(a[1] * Math.PI / 180);
  const bx = (b[0] - a[0]) * k, by = (b[1] - a[1]) * 111132;
  const px = (lon - a[0]) * k, py = (lat - a[1]) * 111132;
  const d2 = bx * bx + by * by;
  const t = d2 <= 1e-9 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / d2));
  return Math.hypot(px - t * bx, py - t * by);
}

// ------------------------------------------------------------ instructions
//
// **A manoeuvre is not a road, and a U-turn is not a turn** — E189 learned
// both at cost. A turn fillet between two roads offered the app two joints and
// it announced the same corner twice, 35 m apart. And a U-turn between two
// carriageways 4 degrees apart measures as "going straight on", so a 147 m
// detour over a 36 m straight line got no instruction at all. So a manoeuvre
// edge is folded into the junction it belongs to, and a U-turn edge IS the
// instruction.

function bearing(a, b) {
  const k = 111320 * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180);
  return (Math.atan2((b[0] - a[0]) * k, (b[1] - a[1]) * 111132)
    * 180 / Math.PI + 360) % 360;
}

function turnWord(delta) {
  const d = ((delta + 540) % 360) - 180;
  const a = Math.abs(d);
  if (a < 20) return { word: 'Continue', side: null };
  if (a < 55) return { word: d > 0 ? 'Bear right' : 'Bear left', side: d > 0 ? '↱' : '↰' };
  if (a < 135) return { word: d > 0 ? 'Turn right' : 'Turn left', side: d > 0 ? '→' : '←' };
  return { word: d > 0 ? 'Sharp right' : 'Sharp left', side: d > 0 ? '⇒' : '⇐' };
}

/**
 * The polyline one leg follows, in drawing order.
 *
 * `edgePath` gives it from the edge's own `from`; a leg driven the other way
 * has to be reversed or the highlight zigzags back on itself.
 */
function legPoints(res, leg) {
  // The worker already put the shape in driving order and handed over both
  // endpoints, so there is nothing left to reverse here.
  return [leg.a, ...leg.shape, leg.b];
}

function buildSteps(res, area) {
  // Told by the pack, never derived here: `corpus_mappack.py` falls back to
  // a different `_OTHER` when it cannot import the pipeline's class list, so
  // the manoeuvre and U-turn ids shift by one between builds.
  const MAN = area.classIds.manoeuvre ?? 15;
  const UT = area.classIds.uturn ?? 16;
  const out = [];
  let run = null;
  let pending = null;
  const names = area.names;

  for (const leg of res.legs) {
    const e = leg;
    const a = leg.a, b = leg.b;
    if (!a || !b) continue;
    const shape = leg.shape;
    const first = shape.length ? shape[0] : b;
    const last = shape.length ? shape[shape.length - 1] : a;
    const inB = bearing(a, first);
    const outB = bearing(last, b);

    if (e.classId === UT) {
      if (run) { out.push(run); run = null; }
      out.push({ kind: 'uturn', text: 'Make a U-turn', side: 'U',
                 distM: e.lengthM, name: null, pts: legPoints(res, leg) });
      pending = null;
      continue;
    }
    if (e.classId === MAN) {
      // The fillet carries the geometry of the corner; the corner is
      // announced by the road that follows it, never by the fillet.
      if (pending === null) pending = run ? run.outBearing : inB;
      if (run) { run.distM += e.lengthM; run.pts.push(...legPoints(res, leg)); }
      continue;
    }
    if (run && run.nameId === e.nameId && pending === null
        && e.nameId !== 0xFFFF) {
      run.distM += e.lengthM;
      run.outBearing = outB;
      run.pts.push(...legPoints(res, leg));
      continue;
    }
    if (run && run.nameId === e.nameId && pending === null) {
      // Unnamed road: fall back to geometry, so a gentle continuation is not
      // announced as a turn on a corpus with no names at all.
      const t = turnWord(inB - run.outBearing);
      if (!t.side) {
        run.distM += e.lengthM;
        run.outBearing = outB;
        run.pts.push(...legPoints(res, leg));
        continue;
      }
    }
    if (run) out.push(run);
    const fromB = pending !== null ? pending : run ? run.outBearing : null;
    const t = fromB === null ? { word: 'Head off', side: null }
      : turnWord(inB - fromB);
    run = { kind: 'road', text: t.word, side: t.side, nameId: e.nameId,
            name: e.nameId !== 0xFFFF ? names.get(e.nameId) || null : null,
            distM: e.lengthM, outBearing: outB, pts: legPoints(res, leg) };
    pending = null;
  }
  if (run) out.push(run);
  if (out.length) out[out.length - 1].text += ' to arrive';
  return withWalks(out, res);
}

/** Below this the walk is snap noise rather than a walk, and saying so is worse. */
const WALK_MIN_M = 20;

/**
 * The walk at each end, said out loud.
 *
 * Ali: "if the navigation says walk, say so explicitly in the nav stage
 * 'walk 500m'."
 *
 * The distance was already measured and already reported -- in small grey
 * type under the step list, which is where a number goes when nobody has
 * decided whether it matters. It matters: E354 measured rescued journeys
 * walking p50 46 m and p90 102 m, and past some distance "there is a route"
 * is the worse answer. A journey that begins with four hundred metres on foot
 * is not a driving instruction with a footnote; the walk is the first stage
 * of it, and the list is where the stages live.
 *
 * The geometry is the tapped point to the point the router snapped to, which
 * is a straight line and is drawn as one. It is not a walking route and does
 * not claim to be -- nothing here routes a pedestrian.
 */
function withWalks(steps, res) {
  const line = res.route && res.route.line;
  if (!line || !line.length) return steps;
  const out = steps.slice();
  if (res.walkEndM != null && res.walkEndM >= WALK_MIN_M && state.to) {
    out.push({ kind: 'walk', text: 'Walk to the destination', side: '⤳',
               distM: res.walkEndM, name: null,
               pts: [line[line.length - 1], state.to] });
  }
  if (res.walkStartM != null && res.walkStartM >= WALK_MIN_M && state.from) {
    out.unshift({ kind: 'walk', text: 'Walk to the road', side: '⤳',
                  distM: res.walkStartM, name: null,
                  pts: [state.from, line[0]] });
  }
  return out;
}

// --------------------------------------------------------- unreachable road
//
// "A map that quietly hides road it cannot route on is lying to the driver."
// The subgraph the route came from is already in memory, so the component
// containing the journey is one flood fill away, and everything outside it is
// road we drew and could not use.

function markUnreached(res) {
  // The flood happens in the worker, which still had the subgraph. This is
  // only where the answer is put.
  state.unreached = res.unreached || [];
}

// ------------------------------------------------------------------ loading

async function loadFlavour(id) {
  const all = await fetch(`${DATA}d/flavors.json`).then(r => r.json());
  const f = all.flavors.find(x => x.id === id) || all.flavors[0];
  state.flavour = f;
  state.areas = [];
  state.route = null;
  state.unreached = [];
  state.bounds = null;

  const sel = $('flavor');
  if (!sel.options.length) {
    for (const x of all.flavors) {
      const o = document.createElement('option');
      o.value = x.id;
      o.textContent = x.title;
      sel.appendChild(o);
    }
  }
  sel.value = f.id;

  // The provenance badge is not decoration. The OSM flavour is a tech demo
  // and must never be mistaken for the corpus — on screen or in a screenshot
  // of the screen — so it is shown in the embed too.
  const badge = $('badge');
  badge.hidden = false;
  badge.className = 'badge ' + f.provenance;
  badge.textContent = f.provenance === 'imported'
    ? 'TECH DEMO · OpenStreetMap, not the Ali Maps corpus'
    : 'Detected from imagery · no imported network';

  $('ptitle').textContent = f.title;
  $('sub').textContent = f.note;

  // The credit follows the flavour. An earlier build printed "Roads detected
  // from satellite imagery. No imported road network." over the OSM demo,
  // which is the precise confusion the badge exists to prevent — and the
  // credit is the line that survives into a screenshot.
  const ours = document.querySelector('#credit .ours');
  // ODbL attribution is required wherever the data is shown, so on the OSM
  // flavour this line is marked as one the embed may not hide.
  ours.classList.toggle('required', f.provenance === 'imported');
  ours.innerHTML = f.provenance === 'imported'
    ? 'Road data &copy; <a href="https://www.openstreetmap.org/copyright" '
      + 'target="_blank" rel="noopener">OpenStreetMap</a> contributors, ODbL.'
      + '<br>Segmented into the Ali Maps model. Not the Ali Maps corpus.'
    : 'Roads detected from satellite imagery.<br>No imported road network.';

  for (const a of f.areas) {
    const base = `${DATA}d/${f.id}/${a.dir}`;
    const area = {
      ...a, base, tiles: new Map(), pending: new Set(), overview: undefined,
      classes: [], classIds: {}, hasArterial: false,
      hasSpeeds: f.id === 'osm',
      // id -> street name, filled a tile at a time.
      names: new Map(), namesPending: new Set(),
      // 256 decoded routing tiles. A cross-town corridor is about 55, so
      // this holds several journeys without holding the city.
      store: new TileStore({
        baseUrl: `${base}/route`,
        maxTiles: 256,
        // Every arrival is shown landing on the map. See `noteTile`.
        onTile: (level, x, y, bytes) => {
          // **Only the fine level.** Ali: "when navigating on very zoomed out,
          // the whole riyadh tile will blip." The coarse planning level is
          // seven or eight tiles for the entire city, so blipping one lights
          // up a third of Riyadh to report a 300 kB fetch. The fine tiles are
          // the ones that correspond to somewhere.
          if (level !== 'fine') return;
          // Resolved at call time: the store is built inside the object
          // literal that `area` is being assigned from, so it cannot close
          // over `area` itself.
          const a = state.areas.find((q) => q.base === base);
          const z = a && a.store.index
            && a.store.index.levels[level]
            && a.store.index.levels[level].zoom;
          if (typeof z === 'number') noteTile(level, x, y, bytes, z);
        },
      }),
    };
    state.areas.push(area);
    area.index = await fetch(`${base}/index.json`).then(r => r.json());
    grow(area.bounds);
    // The routing index and the names table, fetched now so a tap routes
    // without a cold start. Both are small; the tiles are not and wait.
    area.store.load().then((ix) => {
      area.classes = ix.classes || [];
      area.classIds = ix.classIds || {};
      area.hasArterial = (ix.levels.coarse?.tiles?.length || 0) > 0;
      // Street names are NOT fetched here. They are tiled, and they are only
      // wanted once there is a route to describe or a zoom close enough to
      // label -- not city-wide, before the map has drawn anything.
    }).catch(() => {});
  }

  LAT0 = state.bounds ? (state.bounds[1] + state.bounds[3]) / 2 : 24.71;
  KX = Math.cos(LAT0 * Math.PI / 180);

  // **Open on ONE area, not on all of them.**
  //
  // The corpus is three districts a long way apart, so the bounding box of
  // all three is 43 m/px of mostly desert -- and a tap in it lands two to
  // four kilometres from the nearest road. Ali: "clicking anywhere doesnt
  // succeed in a navigation anymore." It never did on that view; the view was
  // the problem. Fitting the first area instead opens on road.
  fillAreaPicker(f);
  const want = Q.get('area');
  const area = f.areas.find((a) => a.dir === want) || f.areas[0];
  if (area && !Q.get('lat') && !Q.get('from')) state.bounds = [...area.bounds];
  resize();
  refresh();
  stats(f);
}

/** A district chooser, for a flavour that has more than one. */
function fillAreaPicker(f) {
  const sel = $('area');
  if (!sel) return;
  sel.innerHTML = '';
  sel.hidden = f.areas.length < 2;
  for (const a of f.areas) {
    const o = document.createElement('option');
    o.value = a.dir;
    o.textContent = a.title;
    sel.appendChild(o);
  }
  const want = Q.get('area');
  sel.value = (f.areas.find((a) => a.dir === want) || f.areas[0]).dir;
  sel.onchange = () => {
    const a = f.areas.find((x) => x.dir === sel.value);
    if (!a) return;
    fit(a.bounds);
    refresh();
  };
}

function grow(b) {
  if (!state.bounds) state.bounds = [...b];
  else {
    state.bounds[0] = Math.min(state.bounds[0], b[0]);
    state.bounds[1] = Math.min(state.bounds[1], b[1]);
    state.bounds[2] = Math.max(state.bounds[2], b[2]);
    state.bounds[3] = Math.max(state.bounds[3], b[3]);
  }
}

function stats(f) {
  const km = f.areas.reduce((s, a) => s + (a.route?.km || 0), 0);
  const nodes = f.areas.reduce((s, a) => s + (a.route?.nodes || 0), 0);
  $('stats').innerHTML = [
    [`${km.toLocaleString(undefined, { maximumFractionDigits: 0 })} km`, 'road routable'],
    [`${nodes.toLocaleString()}`, 'junctions'],
    [`${f.areas.length}`, f.areas.length > 1 ? 'districts' : 'city'],
    [f.provenance === 'imported' ? 'imported' : 'detected', 'provenance'],
    ['in development', 'status'],
    // **What this machine can actually do, measured on this machine.** A
    // trackpad rotation reaches a web page through one event and it exists on
    // macOS alone, so "two fingers orbiting" either works here or cannot be
    // made to -- and that is a fact about the browser, not about the map.
    // Saying so in the panel beats asking somebody to open a console.
    [('ongesturestart' in window) ? 'yes' : 'no', 'trackpad rotate'],
  ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');
}

// ----------------------------------------------------------------- controls

// The info box, behind its icon. localStorage can throw or come back empty in
// a private window, so the page has to render correctly without it.
const panel = document.getElementById('panel');
const info = document.getElementById('info');
function setPanel(open) {
  panel.classList.toggle('open', open);
  info.setAttribute('aria-expanded', String(open));
  info.style.display = open ? 'none' : '';
  try { localStorage.setItem('alimap.panel', open ? '1' : '0'); } catch (e) {}
}
let wantPanel = false;
try { wantPanel = localStorage.getItem('alimap.panel') === '1'; } catch (e) {}
setPanel(wantPanel);
info.onclick = () => setPanel(true);
document.getElementById('panelclose').onclick = () => setPanel(false);

$('fit').onclick = () => { fit(); refresh(); };

/**
 * System, then light, then dark, and round again.
 *
 * **Three states, not two.** A two-way toggle cannot express "whatever this
 * phone is doing", which is what most people want and what the app does on a
 * first visit -- and once you have pressed such a toggle once there is no way
 * back to it. The button says which state it is IN, not what it would do,
 * because a button labelled with its own consequence is a button you have to
 * press to find out where you are.
 */
const THEME_ORDER = ['system', 'light', 'dark'];

function systemTheme() {
  try {
    return matchMedia('(prefers-color-scheme: light)').matches
      ? 'light' : 'dark';
  } catch (e) {
    return 'dark';
  }
}

function setThemeChoice(choice) {
  themeChoice = THEME_ORDER.includes(choice) ? choice : 'system';
  try {
    if (themeChoice === 'system') localStorage.removeItem('alimap.theme');
    else localStorage.setItem('alimap.theme', themeChoice);
  } catch (e) { /* a private window still gets a theme, just not a memory */ }
  applyTheme(themeChoice === 'system' ? systemTheme() : themeChoice);
}

applyTheme(themeName);
const tb = $('theme');
if (tb) {
  tb.onclick = () => setThemeChoice(
    THEME_ORDER[(THEME_ORDER.indexOf(themeChoice) + 1) % THEME_ORDER.length]);
}
try {
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
    if (themeChoice === 'system') applyTheme(e.matches ? 'light' : 'dark');
  });
} catch (e) { /* older browsers simply keep what they were given */ }

/**
 * The drawer handle: drag it to resize, tap it to close.
 *
 * Ali: "i cant drag the handle, and if i click fhe handle it should close.
 * Remove the X button."
 *
 * Two behaviours on one control, and the split is by distance rather than by
 * time, because a slow deliberate drag is still a drag and a fast tap on a
 * phone is easy to hold for 300 ms by accident. Under `GRIP_TAP_PX` of travel
 * it is a tap and the drawer closes -- the handle IS the close button now, so
 * the cross is gone and there is one place to press rather than two. Past it,
 * up makes the list tall and down makes it short, and a second drag down from
 * short closes it, which is what a drawer does everywhere else.
 *
 * Pointer events, not touch: the same code then works for a mouse on the
 * desktop layout, where the handle is hidden but the behaviour costs nothing.
 */
const GRIP_TAP_PX = 8;

const grip = $('navgrip');
if (grip) {
  let from = null;
  grip.addEventListener('pointerdown', (e) => {
    from = { y: e.clientY, tall: $('nav').classList.contains('tall') };
    // Wrapped, because a pointer that has already been captured elsewhere --
    // a second finger, a cancelled gesture -- throws here, and an exception
    // in `pointerdown` leaves the drag half-started and the handle dead.
    try { grip.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!from) return;
    const dy = e.clientY - from.y;
    if (Math.abs(dy) < GRIP_TAP_PX) return;
    $('nav').classList.toggle('tall', dy < 0);
    from.moved = true;
  });
  const done = (e) => {
    if (!from) return;
    const dy = e.clientY - from.y;
    const drawer = $('nav');
    if (!from.moved && Math.abs(dy) < GRIP_TAP_PX) {
      clearRoute();
    } else if (dy > GRIP_TAP_PX && !from.tall) {
      clearRoute();                   // already short, pulled down again
    }
    from = null;
    void drawer;
  };
  grip.addEventListener('pointerup', done);
  grip.addEventListener('pointercancel', () => { from = null; });
}
/** Put the map back to having no journey on it. */
function clearRoute() {
  state.route = null;
  state.from = state.to = null;
  state.unreached = [];
  state.steps = [];
  setHover(null, null);
  $('nav').classList.remove('open', 'tall');
  document.getElementById('nav3dwrap').classList.remove('open');
  if (view3d) setView3d(false);
  draw();
}

// On a phone the 3d view is not an inset. Ali: "for mobile, the 3d should be
// either-or, not in-screen." A 300x170 window on a 390-wide screen is too
// small to read and takes the space the map needs, so it takes the screen or
// it is not there.
/**
 * 2D or 3D, as a two-position radio in the drawer's own header.
 *
 * Ali: "have a 3D radio switcher in its top right." A radio rather than a
 * toggle because both states are named and visible at once -- the control
 * says which view you are in, where a toggle says which one you would get by
 * pressing it and leaves you to work out where you are. It sits where the
 * cross used to, which is the corner of the header nothing else wants.
 *
 * On a desktop it opens and closes the inset window; on a phone the 3d view
 * takes the whole screen (Ali: "for mobile, the 3d should be either-or, not
 * in-screen"), so the floating button is what brings the map back and it is
 * only there while the 3d view is up.
 */
let view3d = false;

function setView3d(on) {
  view3d = !!on;
  document.body.classList.toggle('threed', view3d);
  for (const btn of document.querySelectorAll('#viewmode button')) {
    const want = btn.dataset.mode === (view3d ? '3d' : '2d');
    btn.setAttribute('aria-checked', String(want));
  }
  const t = document.getElementById('toggle3d');
  if (t) t.setAttribute('aria-pressed', String(view3d));
  drawNav3d(state.hover);
  draw();
}

for (const btn of document.querySelectorAll('#viewmode button')) {
  btn.onclick = () => setView3d(btn.dataset.mode === '3d');
}

const t3 = document.getElementById('toggle3d');
if (t3) t3.onclick = () => setView3d(!view3d);
$('flavor').onchange = (e) => {
  const u = new URL(location.href);
  u.searchParams.set('f', e.target.value);
  location.href = u.toString();
};
$('locate').onclick = () => {
  if (!navigator.geolocation) return hint('This browser has no location.');
  hint('Finding you…');
  navigator.geolocation.getCurrentPosition((p) => {
    state.me = [p.coords.longitude, p.coords.latitude];
    state.from = state.me;
    state.to = null;
    const w = cv.width / DPR, h = cv.height / DPR;
    scale = (h / 900) * 111132;
    ox = w / 2 - state.me[0] * KX * scale;
    oy = h / 2 + state.me[1] * scale;
    hint('Now tap where you are going.');
    refresh();
  }, () => hint('Could not get your location.'), { enableHighAccuracy: true });
};

bindNav3dGestures();
addEventListener('resize', resize);

// A hidden tab gets no animation frames at all, so a map that only ever
// paints inside one comes back to the foreground showing whatever it had
// when it was hidden -- or nothing, if it was hidden before its first tile
// landed. Ask for a frame on the way back in.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) draw();
});

// A diagnostic handle, deliberately shipped. The scene buffer's cost is the
// number this page is judged on and it is invisible from outside; the e2e
// suite asserts against these, and a figure a test can read is a figure that
// cannot quietly regress.
window.__alimaps = {
  state, rasterStats, tiles: rt,
  view: () => ({ mpp: mpp(), ox, oy, scale }),
  level: () => state.areas.map(a => a.index && levelFor(a).name),
  // Rasterise everything the view is waiting on, synchronously. Tests need a
  // frame they can assert against; the app itself never does this.
  render: () => {
    const t0 = performance.now();
    let paths = 0;
    // Draw, then finish everything the frame asked for, then draw again --
    // repeated, because finishing a tile can reveal the next one the blend
    // wants. Bounded, so a test cannot hang on a level that never settles.
    for (let i = 0; i < 60; i++) {
      draw();
      paint();
      const todo = [...rt.values()].filter(
        (x) => (!x.done || x.back) && x.used > performance.now() - 3000);
      if (!todo.length) break;
      for (const rec of todo) {
        while (!stepTile(rec, 1000)) { /* one tile, no budget */ }
        paths += rec.paths;
      }
    }
    paint();
    return { ms: Math.round(performance.now() - t0), paths };
  },
  /** Which octave each level is showing, and how many tiles it holds. */
  octaves: () => {
    const out = {};
    for (const [name, g] of gen) out[name] = g.oct;
    return out;
  },
  /** Per level: the octave on screen, how many of its tiles this frame drew,
   *  and how many it would take to cover the view. */
  gens: () => {
    const out = {};
    for (const [name, g] of gen) {
      out[name] = { oct: g.oct, drawn: g.drawn || 0, need: g.need || 0 };
    }
    return out;
  },
  heading: () => heading * 180 / Math.PI,
  /** Put the view at a slippy zoom, keeping the centre. For measuring. */
  setZoom: (z) => {
    const w = cv.width / DPR, h = cv.height / DPR;
    const lat = latAt(h / 2), lon = lonAt(w / 2);
    const m = 156543.03392 * Math.cos(LAT0 * Math.PI / 180) / Math.pow(2, z);
    scale = 111132 / m;
    ox = w / 2 - lon * KX * scale;
    oy = h / 2 + lat * scale;
    zoomIntent.at = 0;              // treat it as settled, not mid-gesture
    draw();
  },
  /**
   * The two stroke widths a road of `W` screen pixels is drawn with.
   *
   * Exposed because "a road never flips between solid and hollow" is a claim
   * about this function and nothing else, and a test that samples pixels
   * across a zoom sweep is measuring the claim through a rasteriser, a level
   * ladder and a palette.
   */
  roadWidths: (W) => {
    const kerb = Math.max(1.1, Math.min(4, W * 0.09));
    const inner = W - 2 * kerb;
    return { casing: Math.max(THIN_PX, W), fill: Math.max(0, inner) };
  },
  /**
   * What this machine's pointing devices actually deliver.
   *
   * `gesture` is the only way a trackpad ROTATION reaches a web page, and it
   * exists on macOS alone. If it reads false here, no amount of code makes
   * two fingers orbiting on this trackpad turn the map -- the browser is not
   * being told either.
   */
  inputs: () => ({
    gestureEvents: 'ongesturestart' in window,
    touchPoints: navigator.maxTouchPoints,
    platform: navigator.platform,
    seen: { ...inputSeen },
  }),
  setHeading: (deg) => { heading = deg * Math.PI / 180; invalidate(); draw(); },
  faceNorth,
  theme: () => ({ choice: themeChoice, showing: themeName }),
  blend: () => {
    const a = state.areas.find((x) => x.index);
    if (!a) return null;
    const b = levelBlend(a);
    const st = settleBlend(b);
    // Both: the raw zoom blend and what the map has settled on. A test for
    // "stop zooming and the finer level comes all the way in" needs to see
    // the second move while the first does not.
    return { a: b.a.name, b: b.b && b.b.name, t: b.t,
             settled: { a: st.a.name, b: st.b && st.b.name, t: st.t } };
  },
  shown: () => shownLevel,
  blips,
  geo, cam,
  spans: spanSummary,
  /**
   * Fine-tune the rasterising cadence without a rebuild.
   *
   * Ali: "we need to be able to finetune the tile rendering cadence so we
   * dont overload the CPU neither do we render too sluggishly."
   *
   *   __alimaps.tune({ sliceMs: 10, sliceGestureMs: 5, predictS: 0.8 })
   *   __alimaps.tune()            // read the current values back
   */
  tune: (o) => {
    if (o && o.sliceMs) SLICE_MS = Math.max(1, Math.min(40, o.sliceMs));
    if (o && o.sliceGestureMs) {
      SLICE_GESTURE_MS = Math.max(0, Math.min(20, o.sliceGestureMs));
    }
    if (o && o.overrunMs) OVERRUN_MS = Math.max(4, Math.min(80, o.overrunMs));
    if (o && o.predictS !== undefined) {
      PREDICT_S = Math.max(0, Math.min(3, o.predictS));
    }
    if (o && o.thinPx) THIN_PX = Math.max(0.2, Math.min(4, o.thinPx));
    // `thinTwoWay`/`thinOneWay` were read and written here and DECLARED
    // NOWHERE, so `__alimaps.tune()` threw a ReferenceError on every call --
    // the tuning hook, unusable, since whichever edit removed the constants
    // left their uses behind. There is one colour per road class now and
    // nothing to override.
    if (o) invalidate();
    return { sliceMs: SLICE_MS, sliceGestureMs: SLICE_GESTURE_MS,
             overrunMs: OVERRUN_MS, predictS: PREDICT_S, thinPx: THIN_PX,
             zoomVel: +zoomIntent.vel.toFixed(2) };
  },
  slow: (ms = 12) => spanLog.filter((x) => x.ms >= ms)
    .map((x) => `${x.name} ${x.ms.toFixed(1)}ms`),
  memory: () => ({
    sceneMB: +(sceneBytes() / 1e6).toFixed(1),
    buffers: rt.size,
    decodedTiles: state.areas.reduce((n, a) => n + a.tiles.size, 0),
    routingTiles: state.areas.reduce(
      (n, a) => n + (a.store.stats().cached || 0), 0),
    cancelled: rasterStats.cancelled,
    evicted: rasterStats.evicted,
  }),
  /** Levels with at least one finished tile on screen. */
  ready: () => [...new Set([...rt.values()].filter((x) => x.done)
    .map((x) => x.lv))],
  /** Is every tile the view is waiting on finished? */
  settled: () => ![...rt.values()].some((x) => !x.done
    && x.used > performance.now() - 1500),
};

// ---------------------------------------------------------------------- go
await loadFlavour(Q.get('f') || 'corpus');

// An embed can carry a route, so a page can link to the journey it is writing
// about rather than to a map somebody has to drive themselves.
const qFrom = (Q.get('from') || '').split(',').map(Number);
const qTo = (Q.get('to') || '').split(',').map(Number);
if (qFrom.length === 2 && qFrom.every(Number.isFinite)
  && qTo.length === 2 && qTo.every(Number.isFinite)) {
  state.from = [qFrom[1], qFrom[0]];     // lat,lon in the URL; lon,lat inside
  state.to = [qTo[1], qTo[0]];
  await go();
  if (state.route && !Q.get('lat')) {
    const line = state.route.line;
    let b = [line[0][0], line[0][1], line[0][0], line[0][1]];
    for (const [lo, la] of line) {
      b = [Math.min(b[0], lo), Math.min(b[1], la),
           Math.max(b[2], lo), Math.max(b[3], la)];
    }
    fit(b);
    refresh();
  }
} else if (INTENT) {
  await applyEmbedIntent(INTENT);
} else if (!EMBED) {
  hint('Tap the map to set a start, then a destination.');
}

/**
 * Do what the embed URL asked for.
 *
 * Anything we cannot do is SAID, in the page, rather than quietly dropped --
 * a satellite request that silently returns a road map is the caller being
 * told something untrue about what they are looking at.
 */
async function applyEmbedIntent(intent) {
  for (const w of intent.warnings) hint(w);

  const area = state.areas[0];
  const lat0 = area ? (area.bounds[1] + area.bounds[3]) / 2 : LAT0;
  const applyView = (lon, lat) => {
    const wpx = cv.width / DPR, hpx = cv.height / DPR;
    if (intent.zoom !== undefined) {
      scale = 111132 / zoomToMpp(intent.zoom, lat);
    }
    ox = wpx / 2 - lon * KX * scale;
    oy = hpx / 2 + lat * scale;
  };

  if (intent.mode === 'directions') {
    const from = intent.from
      || (intent.fromText ? await findPlace(intent.fromText) : null);
    const to = intent.to
      || (intent.toText ? await findPlace(intent.toText) : null);
    if (!from || !to) {
      hint('directions needs an origin and a destination as lat,lon'
        + (state.flavour && state.flavour.imported ? ' or a street name.' : '.'));
      return;
    }
    state.from = from;
    state.to = to;
    await go();
    if (state.route && !intent.centre) {
      const line = state.route.line;
      let b = [line[0][0], line[0][1], line[0][0], line[0][1]];
      for (const [lo, la] of line) {
        b = [Math.min(b[0], lo), Math.min(b[1], la),
             Math.max(b[2], lo), Math.max(b[3], la)];
      }
      fit(b);
    }
    refresh();
    return;
  }

  if (intent.mode === 'streetview') {
    // Google's street view is photography. Ours is the road model drawn from
    // the driver's seat -- the same question asked of the geometry we have
    // rather than of a camera we do not.
    const p = intent.location || intent.centre;
    if (!p) { hint('streetview needs location=lat,lon'); return; }
    state.from = p;
    cam.ready = false;
    document.body.classList.add('threed', 'sv');
    drawNav3d({ text: 'Street view', pts: [p, [p[0] + 1e-4, p[1] + 1e-4]] });
    if (intent.heading !== undefined) {
      cam.heading = intent.heading;
      camTween = null;
    }
    if (intent.pitch !== undefined) cam.pitch = intent.pitch;
    applyView(p[0], p[1]);
    refresh();
    paintNav3d();
    return;
  }

  // view / place / search
  let p = intent.point || intent.centre;
  if (!p && intent.text) p = await findPlace(intent.text);
  if (p) {
    if (intent.mode !== 'view') {
      state.from = p;                       // a pin on the place
      state.to = null;
    }
    applyView(p[0], p[1]);
  } else if (intent.text) {
    hint(`Nothing here is called "${intent.text}".`);
  }
  refresh();
}

/**
 * A street by name, for `q=` / `origin=` / `destination=`.
 *
 * **Only where street names exist**, which is the OSM flavour. The corpus has
 * an empty names table on purpose and searching it will always return nothing,
 * which is the honest answer rather than a missing feature.
 */
async function findPlace(text) {
  const area = state.areas[0];
  // `imported` is a convenience on the Dart side; here the manifest field is
  // `provenance`. Checking the wrong one made every name search answer
  // "nothing here is called that", which is the corpus's true answer and the
  // OSM flavour's false one.
  if (!area || !state.flavour || state.flavour.provenance !== 'imported') {
    return null;
  }
  const want = String(text).trim().toLowerCase();
  if (!want) return null;
  try {
    const idx = await fetch(`${area.base}/route/places.json`)
      .then((r) => (r.ok ? r.json() : null));
    if (!idx) return null;
    let hit = idx.find((e) => e[0].toLowerCase() === want);
    if (!hit) hit = idx.find((e) => e[0].toLowerCase().includes(want));
    return hit ? [hit[1], hit[2]] : null;
  } catch {
    return null;
  }
}
