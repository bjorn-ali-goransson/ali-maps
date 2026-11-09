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
import { LayerSet } from './layers.js';
import { route as planAndRoute, Subgraph } from './engine/router.js';
import { tileOf, metres } from './engine/tiles.js';
import { zoomForMpp, levelForMpp } from './viewmath.js';

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
/**
 * The data ORIGIN, which never carries a version in it. `versions.json`
 * lives here and nowhere else, so finding out which releases exist costs
 * one fetch and needs nothing to have been chosen first.
 */
const DATA_ROOT = (window.ALIMAPS_DATA || Q.get('data') || ROOT)
  .replace(/\/?$/, '/');
/**
 * Where THIS page's tiles come from: the origin plus the selected
 * release's own base.
 *
 * Ali: "let's version them so that we have version one, which is the
 * currently published version of only two districts, and version two will
 * be the one that you just generated, and so on, so that people can switch
 * versions seamlessly, and it will automatically choose the latest version
 * when loading the page."
 *
 * It is a `let` because `chooseVersion()` sets it once, before anything
 * fetches a tile, and every closure below reads the binding rather than a
 * captured value. The LATEST release is published at the origin itself
 * (base ''), so a client that never learns about versions at all still
 * gets the current map -- which is what makes this additive.
 */
let DATA = DATA_ROOT;
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
// * ***AN EMBED HAS NO LAYER SELECTION AT ALL.*** Ali, 2026-10-10: "Can you
//   disable the layer selection in the embed api? I don't want to enable any
//   satellite imagery, nor open street map, nor any other version than the
//   latest tile version." So `f=` and `v=` are READ AND REFUSED here: an
//   embedded map is always the corpus and always the newest release. The
//   reason is not tidiness -- a page that embeds us and quietly shows
//   OpenStreetMap is the exact confusion the provenance badge was built for,
//   and a pinned old release is a map going stale on somebody else's site
//   with nobody to notice. Refused LOUDLY, like the rest of this list.
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

/**
 * What an embed asked for and is not getting, said out loud.
 *
 * Filled while the URL is read and shown once the page has loaded, because
 * the answer to "why am I looking at the corpus when I asked for OSM" has to
 * be ON the map rather than in a changelog.
 */
const embedRefusals = [];

/** The flavour, which in an embed is not negotiable. */
function wantedFlavour() {
  const asked = Q.get('f');
  if (!EMBED) return asked || 'corpus';
  if (asked && asked !== 'corpus') {
    embedRefusals.push(
      'An embedded Ali Maps is always the detected corpus: the OpenStreetMap '
      + 'demo is not embeddable, because a map on somebody else\'s page that '
      + 'quietly shows imported data is the confusion this project exists to '
      + 'avoid.');
  }
  return 'corpus';
}

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

/**
 * Markers from the query string, which is the whole of the marker API.
 *
 * Ali, 2026-10-10: *"If you can enable a rudimentary API through the query
 * string, in order to place a marker on the map with a description along
 * with directions when you click on it which will open Google Maps then that
 * would be excellent."*
 *
 *     ?marker=24.8894,46.6293
 *     ?marker=24.8894,46.6293|Depot 3|Gate B, open 06:00-18:00
 *     ?marker=...|A|...&marker=...|B|...        as many as you like
 *     ?marker=24.8894,46.6293&title=Depot+3&desc=Gate+B
 *
 * **One parameter per marker, with `|` between its three fields**, because
 * the position is already `lat,lon` and a description with a comma in it is
 * the ordinary case rather than the exotic one. `title=` and `desc=` name
 * the FIRST marker, so the single-pin case reads like Google's.
 *
 * ***AND THE DIRECTIONS LINK GOES TO GOOGLE MAPS ON PURPOSE.*** Ali asked
 * for it, and it is the same thing the labelling tool's menu does: a link
 * for a person to follow, carrying nothing back. No Google geometry enters
 * the corpus, is scored against, corrects anything or reaches a model
 * (CLAUDE.md's own wording for the OSM exception).
 */
function parseMarkers() {
  const out = [];
  for (const raw of Q.getAll('marker')) {
    const bits = String(raw).split('|');
    const p = parseLatLon(bits[0]);
    if (!p) continue;
    out.push({
      lon: p[0], lat: p[1],
      title: (bits[1] || '').trim(),
      desc: bits.slice(2).join(' | ').trim(),
    });
  }
  if (out.length) {
    if (!out[0].title && Q.get('title')) out[0].title = Q.get('title').trim();
    if (!out[0].desc && Q.get('desc')) out[0].desc = Q.get('desc').trim();
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
  // Pins somebody else put on this map, from `?marker=`.
  markers: [],
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

/**
 * The view may not leave the ground we have, and it had no bound at all.
 *
 * Ali, 2026-10-09, with the diagnostics panel open on a blank map: *"It
 * happens quite often that the whole screen, in terms of tiles, becomes
 * blank. The Chrome is rendering, but the tiles simply don't show up."* The
 * panel read `#1.57/-358.46676/160.40897/348` -- **a latitude that is not a
 * latitude**, a longitude that is not Riyadh, and 47,880 m/px. Nothing was
 * failing to load; the view had escaped to a place where no data exists, and
 * the hash meant a reload kept it there.
 *
 * `scale` is assigned in nine places and not one of them bounded it. The
 * pinch is `pinch.scale * (d / pinch.d)`, so **one centred pinch measures
 * 4.34 m/px to 216.92 -- fifty times in one gesture** -- and it compounds
 * across gestures until the whole corpus is a pixel. `place()` then holds the
 * point between the fingers still, which at a tiny scale is a huge number of
 * degrees from the middle of the screen, so the zoom runaway drags the
 * position with it.
 *
 * One clamp, called from `paintFrame`, so there is ONE owner rather than a
 * bound repeated at nine assignments that would drift apart:
 *
 *   - **scale**, to `MPP_MAX` and `MPP_MIN`;
 *   - **the latitude and longitude**, to the planet, because past 85 degrees
 *     the projection stops meaning anything and -358 is not a latitude;
 *   - **and non-finite anything**, because `setZoom()` with no argument put
 *     the view to NaN once and blanked the map for real (E978) -- and
 *     `JSON.stringify` prints NaN as `null`, which disguised it.
 *
 * ***WHAT IS DELIBERATELY NOT BOUNDED IS THE MAP'S OWN EXTENT***, which is
 * `homeHint`'s job and Ali's own design -- see there.
 *
 * `dataBox` is the UNION of every area in the flavour and not
 * `state.bounds`, which opens on ONE area deliberately: a bound taken from
 * that would refuse a pan to the next district.
 */
// **Country level has to be REACHABLE**, which is what sets this. Ali asked
// for a way back that says "back to Saudi Arabia" when you are out that far,
// and at 2,000 m/px a 420 px phone spans 840 km -- not a country. At 4,000 a
// phone spans 1,680 km and a desktop 5,120, so the label can be earned.
const MPP_MAX = 4000;
const MPP_MIN = 0.05;        // five centimetres a pixel is nobody's zoom

/** The union of every area's bounds, or null before any index has landed. */
function dataBox() {
  let b = null;
  for (const a of state.areas || []) {
    if (!a.bounds) continue;
    if (!b) b = [...a.bounds];
    else {
      b[0] = Math.min(b[0], a.bounds[0]); b[1] = Math.min(b[1], a.bounds[1]);
      b[2] = Math.max(b[2], a.bounds[2]); b[3] = Math.max(b[3], a.bounds[3]);
    }
  }
  return b;
}

/** Has the first fit decided where this page opens? */
let hashApplied = false;

function clampView() {
  const w = cv.width / DPR, h = cv.height / DPR;
  if (!(w > 0) || !(h > 0)) return;
  const b = dataBox();
  // Remember the middle of the screen BEFORE touching the scale, so a clamped
  // zoom is a zoom about the centre rather than a jump. The centre of rotation
  // is the centre of the screen, so this is the same point at any heading.
  const lon0 = (w / 2 - ox) / (KX * scale);
  const lat0 = (oy - h / 2) / scale;
  let lon = lon0, lat = lat0, sc = scale;
  if (!Number.isFinite(sc) || sc <= 0) sc = 111132 / MPP_MAX;
  sc = Math.min(Math.max(sc, 111132 / MPP_MAX), 111132 / MPP_MIN);
  if (!Number.isFinite(lon)) lon = b ? (b[0] + b[2]) / 2 : 0;
  if (!Number.isFinite(lat)) lat = b ? (b[1] + b[3]) / 2 : 0;
  // **The world, and NOT the map's own bounds.** A first version clamped the
  // centre into the data and measured well -- an escaped fragment landed on
  // the map at 14.03% of the glass lit against 0.19% -- and Ali asked for the
  // other design in the same breath: *"When we go outside the map bounds, we
  // should have a sticky button that moves with an arrow that points to
  // Riyadh that says go back to Riyadh."* **A wall and a way back are two
  // answers to one defect and the way back is Ali's**, so what is bounded
  // here is the PLANET -- past 85 degrees the projection stops meaning
  // anything and the latitude Ali's blank map was stuck on was -358 -- and
  // `homeHint` is what gets you back from the rest.
  lat = Math.min(Math.max(lat, -85), 85);
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  // ***COMPARED IN PIXELS, NOT IN DEGREES, BECAUSE THE ROUND TRIP IS NOT
  // EXACT.*** `lon0` comes out of `ox` and `ox` is then computed back from
  // `lon`, and in floating point those two do not always agree in the last
  // bit -- so `lon !== lon0` could be true on a view nobody had touched, the
  // clamp would "move" the map by a millionth of a degree and ANNOUNCE it,
  // and the announcement re-armed the readout. Measured after E1064's scale
  // bar refused to fade: two of these in the three seconds after a pan, from
  // `paintFrame` -> `clampView` -> `showWhere`. E1061d's "it cannot loop" is
  // true of the arithmetic and was not true of the floats.
  const nox = w / 2 - lon * KX * sc;
  const noy = h / 2 + lat * sc;
  if (sc === scale && Math.abs(nox - ox) < 0.01 && Math.abs(noy - oy) < 0.01) {
    return;
  }
  scale = sc;
  ox = nox;
  oy = noy;
  // **And say so.** The readout and the fragment are written by `showWhere`
  // on a gesture and on a level change, neither of which a clamp is -- so a
  // clamped view kept the number it was ASKED for: the panel read "z 2.6 -
  // 23.4 km/px" over a view the clamp had already pulled to 4,000, and a
  // reload restored the fragment the clamp had just refused. **A diagnostics
  // panel that disagrees with the view is how this defect stayed invisible
  // in the first place**, so the correction announces itself.
  //
  // It cannot loop: this runs only when something MOVED, and having moved it
  // the next frame finds nothing to move.
  //
  // ***AND NOT BEFORE THE PAGE HAS BEEN FRAMED, WHICH BROKE THE LIVE MAP FOR
  // FOUR HOURS.*** A frame can paint before any data has landed -- on the
  // published origin the flavour manifest is a cross-origin fetch -- and the
  // view it paints is the one nobody has asked for yet. The clamp rescued
  // that non-view to the far cap and ANNOUNCED it, which writes the
  // fragment; `fit` then found a hash, and a hash beats a fit, so the map
  // opened at 4,000 m/px over the Southern Ocean and stayed there. Locally
  // the data is instant and `fit` always won the race, so nothing caught it.
  // Reproduced by delaying `**/d/**` by 1.2 s, which lands on the live
  // site's own fragment to the digit: `#5.15/-75.00000/165.11909`.
  //
  // **A clamp announces a view. Before the first fit there is no view to
  // announce** -- and `fit` is what sets this flag, in both of its branches.
  if (hashApplied) showWhere();
}

function fit(b = state.bounds) {
  if (!b) return;
  const w = cv.width / DPR, h = cv.height / DPR;
  // **A hash beats a fit and loses to an explicit query.** It is what the
  // address bar is showing, so reloading the page has to land where the page
  // said it was -- but `?lat=&lon=` is somebody deliberately asking for a
  // place, and an embed's URL must not be overridden by a leftover fragment.
  //
  // **Once, and only on the first fit.** `resize` calls `fit` before the view
  // has been sized, and a phone calls `resize` every time the URL bar
  // collapses -- so this re-read the hash under somebody's hands and, because
  // the hash carries no bearing until the map is turned, SNAPPED A TURNED MAP
  // BACK TO NORTH. Found as a test that read a heading of 0 for a rotation
  // that had genuinely happened, and reproduced by waiting 300 ms instead of
  // a second before turning.
  if (!hashApplied && !Q.get('lat') && !Q.get('from') && applyHash()) {
    hashApplied = true;
    draw();
    showWhere();
    return;
  }
  hashApplied = true;
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

// **There were TWO level-choosers and they disagreed.** This one knew three
// rungs -- fine, a level literally named `mid`, and anything untiled -- and
// the ladder has had five since the declutter landed, so at `coarse` and
// `wide` it answered `mid` and at the overview it answered by a `tiled` flag
// rather than by the zoom. `levelBlend` knew all five. Nothing reconciled
// them; they were simply called from different places.
//
// It is gone, and `levelFor` below is the only answer to "which level is this
// zoom for" in the file.

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

// **THE LEVEL CROSS-FADE IS GONE, AND THESE WERE ITS REMAINS.**
//
// `KEEP_SCENES`, `BLEND_HALF` and `FADE_MS` belonged to the blend between
// two DETAIL LEVELS, which was deleted on 2026-09-28 at Ali's own
// instruction -- "If you can't fix this, then you need to simplify the
// logic and remove features until you can" -- after three fixes for the
// z15.3 flicker had been measured and refused. That commit's own message
// says `BLEND_HALF` went with it. It did not: the three constants and a
// `let fade` stayed behind, read by nothing, for ten days.
//
// A guard with nothing left to guard is a defect waiting for the first
// case that trips it, and a constant with nothing left to tune is a lie
// about what the renderer does. What survives, and is still wired, is
// `LEVEL_FADE_MS` (a new octave dissolving over the one it replaces) and
// `TILE_FADE_MS` (one streamed tile arriving on a layer already on
// screen). The ladder STEPS between levels and does not dissolve, which
// is the cost that removal was accepted at.

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
  return zoomForMpp(mpp(), LAT0);
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
  // **A pan is not a zoom, and this is called by both.** Ali: "when I pan
  // just a few pixels, it seems like the detail level is changing somewhat."
  // It was: `gestureFrame` calls this on every gesture frame, so panning
  // refreshed the idle clock, the settle saw a view that had not been still
  // for 600 ms, and the blend was pulled back off the finer level -- the
  // detail fading out under a finger that was only sliding sideways, and
  // fading back in six hundred milliseconds after it stopped.
  //
  // Nothing here has anything to say about a scale that has not changed --
  // and the FIRST call has no previous scale to compare against, so it
  // records one without claiming a zoom happened. Without that, the first pan
  // of a session counted as a zoom and pulled the detail off once.
  if (!zoomIntent.scale) { zoomIntent.scale = scale; return; }
  if (scale === zoomIntent.scale) return;
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
 * The ONE level this zoom is for. No blend, no `t`, no second level.
 *
 * **Ali, twice: "If you cannot reproduce it nor fix it, then you need to
 * refactor the engine and simplify" and then "If you can't fix this, then you
 * need to simplify the logic and remove features until you can."** This is
 * that, and the feature removed is the level CROSS-BLEND.
 *
 * It returned two levels and a fraction between them, and `settleBlend` then
 * dragged that fraction to the finer level whenever the zoom went quiet --
 * which is a second opinion about which level the zoom is for, disagreeing
 * with this one. At z15.35, just past `SWITCH_MPP[0]`, the ladder said `mid`
 * and the settle said `fine`, so a pause showed one and a nudge showed the
 * other: **14% of the map's ink, alternating once per notch**, which is
 * exactly what Ali reported at z15.3 and nothing at all at z15.5 where the
 * fraction is already 0.
 *
 * Three fixes for it were measured and refused -- settle to the nearest end
 * (four times worse), keep the coarser level underneath (no change), turn off
 * every fade (no change) -- and a fourth measurement said the premise was
 * wrong too: a coarser level is supposed to be a SUBSET of a finer one, and
 * `fine` alone carries 14% LESS ink than `mid` plus a sixth of `fine`, which
 * it cannot if that is true.
 *
 * So the blend is gone rather than mended. One threshold, one level, one
 * answer that does not depend on how long the hand has been still. What it
 * costs is that the ladder now steps instead of dissolving -- and it already
 * steps, because the declutter changes the road set at each rung and no
 * amount of alpha hides that.
 */
function levelFor(area, atScale) {
  // E975: the ladder arithmetic moved to `viewmath.mjs` so the CLI that
  // reports what WILL be rendered shares it rather than restating it
  // (E549, E736). The call sites and the behaviour are unchanged.
  return levelForMpp(area.index, atScale ? 111132 / atScale : mpp());
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
/**
 * Tile side in CSS pixels at the reference scale.
 *
 * **`?tile=N` overrides it, and that is how the seams are tested.** Set it
 * large enough that one tile covers the viewport and the same view renders
 * with no boundaries at all; diff that against the normal tiling and any
 * difference IS the seam error, with no instrument in between guessing at it.
 */
const TILE_CSS = Math.max(64, Math.min(4096,
  parseInt(Q.get('tile'), 10) || 384));

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
let LEVEL_FADE_MS = 420;

/** How many octaves up to look for a stand-in before giving up. */
const FALLBACK_OCTAVES = 4;

/** Canvas the cache may hold. A tile is TILE_CSS^2 x DPR^2 x 4 bytes. */
const RT_MAX_BYTES = 110e6;

const rt = new Map();               // key -> {canvas, ctx, done, t0, bytes, ...}
let rtBytes = 0;

/**
 * What is allowed on screen, and when.
 *
 * **The decision-making lives in `layers.js` and is pure**: no canvas, no
 * DOM, no clock of its own. This file supplies the geometry and does the
 * drawing. `site/layers.test.mjs` covers the scenarios -- Ali: "We should
 * also strive to cover the different scenarios in unit tests" -- and every
 * one of them is a bug that shipped.
 */
/**
 * `?fade=0` turns every fade in the painter off at once.
 *
 * Ali: *"Can we disable all fading and see what happens"*. There are four of
 * them and they are in four places, which is itself part of the answer: a
 * layer dissolving over the one it replaces, a streamed tile fading in on its
 * own, the cross-blend between two detail LEVELS, and the settle that runs
 * that blend to a stop when the zoom goes quiet. Anything still moving with
 * all four off is not a fade, and anything that stops is.
 *
 * It is a diagnostic, not a mode: a map that snaps between levels is not what
 * anybody asked to ship.
 */
const NO_FADE = Q.get('fade') === '0';

const layers = new LayerSet({
  fadeMs: NO_FADE ? 0 : LEVEL_FADE_MS,
  tileFadeMs: NO_FADE ? 0 : TILE_FADE_MS,
});

const octFor = (s) => Math.ceil(Math.log2(s));
const rtKey = (lv, oct, ix, iy) => `${lv}|${oct}|${ix}|${iy}`;


/** The tiles of `oct` the view needs, as integer indices. */
function tileRange(oct) {
  const v = viewBox();
  const k = Math.pow(2, oct) / (scale * TILE_CSS);
  return {
    ix0: Math.floor((v.x0 - ox) * k), ix1: Math.floor((v.x1 - ox) * k),
    iy0: Math.floor((v.y0 - oy) * k), iy1: Math.floor((v.y1 - oy) * k),
  };
}

/**
 * Is this tile's north-up box anywhere the rotated viewport can see?
 *
 * **The cull was the screen RECTANGLE, and a turned map is not one.** Tiles
 * are blitted inside `mapIn`, so their boxes are north-up while `0..W, 0..H`
 * is the glass -- and at 90 degrees those are different shapes. Measured with
 * `?pattern=solid`, which makes every tile a flat block: at bearing 90 the
 * tiles the engine had ASKED for spanned x -483..718, the cull threw away
 * everything past x = 412, and **24.8% of the screen was page background**.
 * At bearing 0 the same cull is exactly right, which is why this survived --
 * and why "a turned map still covers the screen" had been failing about one
 * run in three and being called flaky. It was not flaky. It was correct.
 */
function tileOnScreen(b) {
  const v = viewBox();
  return !(b.L > v.x1 || b.Tp > v.y1 || b.L + b.W < v.x0 || b.Tp + b.H < v.y0);
}

/**
 * Where a tile lands on the north-up screen. EXACTLY, at float precision.
 *
 * **This used to round, and the rounding was the defect it was written to
 * cure** (E1060). Ali, 2026-10-09: *"we seem to have lost our sub-pixel
 * accuracy ... when I pinch zoom very slowly, it still janks on the
 * magnitude of one pixel, a bit of back and forth."*
 *
 * E381 flooring the near edge and ceiling the far one WAS wrong -- it gives
 * every pair a one-pixel overlap and stretches each tile by up to 0.4% -- and
 * rounding both edges fixed the gap and kept the displacement, because a
 * tile's content still lands up to half a pixel from where it belongs and
 * each tile rounds independently. Measured against a boundary-free render of
 * the same view (`?tile=3000`, which has no tiles to displace):
 *
 *     rounded   32,074 of 630,000 pixels differ by >30   5.09%
 *     float        455 of 630,000                        0.07%
 *
 * **Seventy times closer to the picture with no boundaries in it** -- so the
 * rounding was not preventing a seam, it WAS one.
 *
 * ***AND THE SEAM E381 FEARED CANNOT HAPPEN HERE***: a tile canvas is
 * TRANSPARENT with ink drawn on it (`surface()` never fills), so abutting two
 * at fractional coordinates antialiases the ROADS and not a tile edge --
 * there is no edge to antialias. The pre-rendered tiles are opaque and are
 * safe for the other reason: their `ground` is the same colour the canvas is
 * cleared to (E1052 made the two one colour), so a half-covered edge pixel
 * blends ground into ground.
 *
 * What it buys, measured as the frame-to-frame shift of a patch 200 px from
 * the centre under a 0.2%-a-step zoom, which should move 0.40 px every frame:
 *
 *     rounded   21 of 40 frames did not move at all, then 1.4 px, then -0.6
 *     float      0 of 40, every frame 0.30 - 0.34 px
 */
function tileBox(oct, ix, iy) {
  const z = scale / Math.pow(2, oct);
  const w = TILE_CSS * z;
  return { L: ix * w + ox, Tp: iy * w + oy, W: w, H: w };
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

// ----------------------------------------------- UNREACHED road, rasterised
//
// **The pink was most of the frame budget and nothing was measuring it.**
// Ali, 2026-10-09: *"during navigation we show red roads if they are
// isolated. This is not actually relevant to the end user. But as long as you
// think it is relevant ... then at least rasterize it because I can see from
// a performance view that they are not rasterized."*
//
// It was strokes, from raw coordinates, every frame, outside the tile cache
// AND outside `span()` -- so neither the diagnostics panel nor the span log
// attributed a single millisecond to it. Measured by the one variable
// available from outside (clear `state.unreached` and compare the `frame`
// span), a 2.37 km journey in An Narjis carries **23,860 polylines and 63,291
// points**, and costs:
//
//     fine     1.6 m/px    13.4 ms      wide     34.7 m/px   168.9 ms
//     mid      4.3 m/px    14.4 ms      overview 98.2 m/px   146.1 ms
//     coarse  12.3 m/px    52.7 ms
//
// against **0.2 to 0.3 ms for the whole of the rest of the frame** at the
// coarse end. So at the city view the pink is some six hundred times the map
// it is drawn over, on the level whose entire purpose is that the road is one
// blit. **The cost RISES as the view pulls back**, which is the opposite of
// the intuition: zoomed in, most of the polylines are off-canvas and rejected
// for almost nothing; zoomed out, every one of them lands on the glass and
// has to be antialiased.
//
// So it goes in the same tile cache as the road, under a level name of its
// own: the same `rtKey`, the same `surface`, the same LRU eviction, the same
// `fillFrom` stand-in search, `tileBox` for the blit, and the same one tile
// per frame slice. A pan or a zoom inside one octave is then a handful of
// `drawImage` calls.
//
// **What it does NOT change is what the pink MEANS or when it is shown.**
// Ali's first sentence -- that isolated road is not relevant to the driver --
// is a question about the rule, and E703 is why it is a real one: the app's
// pink is JOURNEY-scoped, so it says "not reachable from where this journey
// starts" rather than "road the map cannot route on", and E1034 has 39.4% of
// the city outside the largest component. That is a rendering decision with a
// measurement behind it, and it is Ali's.

/** The pseudo-level the unreached tiles live under in `rt`. */
const UNREACHED_LV = '~unreached';

/** The pink's stroke: twelve metres of ground, floored and capped on screen. */
const PINK_W_M = 12;
const PINK_MIN_PX = 1.4;
const PINK_MAX_PX = 9;

/** Polylines per `beginPath`. Big enough to amortise, small enough to yield. */
const PINK_BATCH = 400;

/**
 * Canvas the pink may hold, out of the tile cache's own `RT_MAX_BYTES`.
 *
 * Measured: at `coarse` the pink's tiles were **42.5 MB of the 110** and at
 * the overview **51.9 MB against the road's 56.6** -- an overlay taking half
 * the cache from the map. `evictTiles` sweeps this budget before it touches
 * anything else, so the pink gives ground first.
 */
const PINK_MAX_BYTES = 24e6;

/**
 * Bumped whenever the journey changes, which is whenever the pink changes.
 *
 * The tiles are DROPPED rather than refreshed, which is the opposite of the
 * rule for road. "Keep old until new is available" is right when the two
 * pictures are of the same ground; here the old picture is the PREVIOUS
 * journey's unreachable road, and leaving that over a new route is a
 * statement that is simply false. A pink that arrives a frame late is honest.
 */
let pinkEpoch = 0;

/**
 * Every unreached polyline with its own bounding box, computed once.
 *
 * **This is the cull, and `groupsUnder` is why it has to exist**: a tile cache
 * whose tiles are not culled is the same work once per tile. The road culls
 * against `index.tiles`, which is already a spatial index; the pink has none,
 * so one pass per journey gives every polyline a box and each tile then
 * rejects on four comparisons.
 *
 * A grid bucket was the other candidate and is not worth the code: at the
 * overview one tile covers 21 km and holds nearly the whole set, so an index
 * would hand back everything anyway, and a linear scan over 23,860 boxes is a
 * fraction of a millisecond ONCE PER TILE against 146 ms every frame.
 */
let pinkBoxes = null;

function pinkIndex() {
  if (pinkBoxes) return pinkBoxes;
  pinkBoxes = [];
  for (const pts of state.unreached) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of pts) {
      if (q[0] < x0) x0 = q[0];
      if (q[0] > x1) x1 = q[0];
      if (q[1] < y0) y0 = q[1];
      if (q[1] > y1) y1 = q[1];
    }
    pinkBoxes.push({ pts, x0, y0, x1, y1 });
  }
  return pinkBoxes;
}

/** The journey changed: new pink, and none of the old pink is true any more. */
function setUnreached(list) {
  state.unreached = list || [];
  pinkBoxes = null;
  pinkEpoch++;
  for (const rec of [...rt.values()]) {
    if (rec.lv !== UNREACHED_LV) continue;
    rt.delete(rec.key);
    rtBytes -= rec.bytes + (rec.back ? rec.back.bytes : 0);
  }
}

/** The unreached polylines whose box touches this tile, plus a stroke halo. */
function unreachedUnder(rec) {
  const ref = Math.pow(2, rec.oct);
  const lon0 = (rec.ix * TILE_CSS) / (KX * ref);
  const lon1 = ((rec.ix + 1) * TILE_CSS) / (KX * ref);
  const lat1 = -(rec.iy * TILE_CSS) / ref;
  const lat0 = -((rec.iy + 1) * TILE_CSS) / ref;
  // Half the widest stroke the pink draws, so a line whose vertices all sit
  // outside the tile still puts its ink inside it.
  const dLat = (PINK_W_M / 2) / 111132;
  const dLon = (PINK_W_M / 2) / (111320 * KX);
  const w = lon0 - dLon, e = lon1 + dLon;
  const so = lat0 - dLat, no = lat1 + dLat;
  const out = [];
  for (const b of pinkIndex()) {
    if (b.x1 < w || b.x0 > e || b.y1 < so || b.y0 > no) continue;
    out.push(b.pts);
  }
  return out;
}

/**
 * Stroke a slice of the unreached set into a tile, resumable at `from`.
 *
 * One pass and one colour -- the pink is not a carriageway with a kerb round
 * it -- and **batched into one path per run of polylines**, which is the win
 * the road already had: Canvas rasterises a stroked path as a single coverage
 * mask, so overlap costs the ink of one line and the per-stroke setup is paid
 * once instead of 23,860 times.
 */
function drawPinkChunk(rec, c, polys, m, SX, SY, from, deadline) {
  const want = PINK_W_M / m;
  const lo = PINK_MIN_PX * PXS, hi = PINK_MAX_PX * PXS;
  // A clamped width is a width in SCREEN pixels, so the blit has to be told
  // when the view has stretched far enough to make it the wrong one, and
  // `floorDrifted` is the road's own machinery for exactly that.
  if (want < lo || want > hi) FLOOR_HIT = true;
  const wpx = Math.max(lo, Math.min(hi, want));
  c.strokeStyle = T.unreached;
  c.lineWidth = wpx;
  c.lineCap = 'round';
  const ink = rec.ink || (rec.ink = { x0: Infinity, y0: Infinity,
                                      x1: -Infinity, y1: -Infinity });
  let i = from, drawn = 0;
  while (i < polys.length) {
    const end = Math.min(polys.length, i + PINK_BATCH);
    c.beginPath();
    for (; i < end; i++) {
      const pts = polys[i];
      for (let k = 0; k < pts.length; k++) {
        const X = SX(pts[k][0]), Y = SY(pts[k][1]);
        if (k === 0) c.moveTo(X, Y); else c.lineTo(X, Y);
        // Where this tile actually has ink, so the blit can carry the corner
        // that has pink in it rather than the whole square.
        if (X < ink.x0) ink.x0 = X;
        if (X > ink.x1) ink.x1 = X;
        if (Y < ink.y0) ink.y0 = Y;
        if (Y > ink.y1) ink.y1 = Y;
      }
      drawn++;
    }
    c.stroke();
    if (performance.now() >= deadline) break;
  }
  // The stroke is centred on the line, and a round cap reaches half a width
  // past its last point.
  ink.pad = wpx;
  return { index: i, drawn };
}

/**
 * Tell the queue which pink tiles are missing. **Behind the road, always.**
 *
 * Called after the queue is sorted and after `noteLoading`, and both of those
 * are deliberate: only `queue[0]` is ever stepped, so appending here means a
 * pink tile is built only in a frame with no road tile outstanding, and the
 * ripple means an object in the bucket is being fetched for that ground --
 * which the pink never is.
 */
function pumpUnreached(now, queue) {
  const oct = octFor(scale);
  for (const key of visibleKeys(oct)) {
    const [ix, iy] = key.split(',').map(Number);
    const b = tileBox(oct, ix, iy);
    if (!tileOnScreen(b)) continue;
    const rec = tileRec(UNREACHED_LV, oct, key);
    rec.used = now;
    if (rec.back || !rec.done) { queue.push(rec); continue; }
    // `dataEpoch` is in here for the THEME: `applyTheme` has no cache of its
    // own to clear and bumps that epoch to say "every scene is now the wrong
    // colour", and a pink tile is a scene.
    if (rec.pink !== pinkEpoch || rec.data !== dataEpoch || floorDrifted(rec)) {
      refreshTile(rec);
      queue.push(rec);
    }
  }
}

/** Blit the pink, at this octave or the nearest one that has the ground. */
function drawUnreachedTiles(now) {
  const oct = octFor(scale);
  for (const key of visibleKeys(oct)) {
    const [ix, iy] = key.split(',').map(Number);
    const b = tileBox(oct, ix, iy);
    if (!tileOnScreen(b)) continue;
    const exact = rt.get(rtKey(UNREACHED_LV, oct, ix, iy));
    // **A finished tile with no pixels is an ANSWER, not a gap.** It says
    // there is no unreached road on that ground, and letting it fall through
    // to `fillFrom` would paint a coarser stand-in over ground we have just
    // established is clear. Six of eight tiles are empty on a measured fine
    // view, so this is also most of the blitting.
    if (exact && exact.done && !exact.canvas) continue;
    // **And a tile that HAS pink mostly has it in one corner.** The pink is a
    // handful of components, not a street grid, so carrying the whole 768 px
    // square is paying for transparency. Measured at `coarse`, where twelve
    // tiles are on screen and nearly all of them have some ink, the whole-
    // square blit was 10.3 ms a frame in a harness with no GPU.
    if (exact && exact.done && exact.canvas && exact.ink
        && blitInk(exact, b, now)) continue;
    fillFrom(UNREACHED_LV, oct, ix, iy, b, now);
  }
}

/**
 * Blit just the part of a pink tile that has ink in it.
 *
 * Returns false if there is nothing to draw, so the caller can fall through
 * to the stand-in search rather than treating a degenerate box as a picture.
 */
function blitInk(rec, b, now) {
  const i = rec.ink;
  const pad = (i.pad || 0) / 2 + 1;
  const x0 = Math.max(0, Math.floor(i.x0 - pad));
  const y0 = Math.max(0, Math.floor(i.y0 - pad));
  const x1 = Math.min(TILE_CSS, Math.ceil(i.x1 + pad));
  const y1 = Math.min(TILE_CSS, Math.ceil(i.y1 + pad));
  if (x1 <= x0 || y1 <= y0) return false;
  // The canvas is TILE_CSS at `dpr` device pixels; the box on screen is `b`,
  // which `tileBox` has already rounded to whole pixels.
  const k = rec.canvas.width / TILE_CSS;
  const fx = b.W / TILE_CSS, fy = b.H / TILE_CSS;
  ctx.drawImage(rec.canvas, x0 * k, y0 * k, (x1 - x0) * k, (y1 - y0) * k,
                b.L + x0 * fx, b.Tp + y0 * fy,
                (x1 - x0) * fx, (y1 - y0) * fy);
  BLITS.ancestor++;
  rec.used = now;
  return true;
}

/** `?raster=0`: the strokes straight to the glass, which is the control. */
function drawUnreachedDirect(m) {
  ctx.save();
  ctx.strokeStyle = T.unreached;
  ctx.lineWidth = Math.max(PINK_MIN_PX, Math.min(PINK_MAX_PX, PINK_W_M / m));
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
  // Compare on the quantised grid, so a tile is refreshed exactly when its
  // neighbours would be and they stay in step.
  const want = Math.round(
    Math.log2(scale / Math.pow(2, rec.oct)) / FLOOR_DRIFT);
  const have = Math.round(Math.log2(rec.z0) / FLOOR_DRIFT);
  return want !== have;
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

/**
 * Give up a refresh nobody is stepping, WITHOUT losing the fact of it.
 *
 * A level that falls out of the blend mid-refresh -- `mid` finishing its
 * fade-out while two of its tiles were redrawing -- is not pumped any more,
 * so its back buffers would sit allocated for the rest of the session. They
 * are dropped, and the tile is marked out of date so that it refreshes
 * properly if that level is ever wanted again. Forgetting the second half is
 * how a stale tile becomes a permanent one.
 */
function abandonRefresh(rec) {
  if (!rec.back) return;
  rtBytes -= rec.back.bytes;
  rec.back = null;
  rec.jobs = null;
  rec.job = 0;
  rec.line = 0;
  rec.data = -1;
}

/** Draw a slice of one tile. Returns true when the tile is finished. */
function stepTile(rec, budget) {
  const started = performance.now();
  const deadline = started + budget;
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
  //
  // **QUANTISED to the same grid the drift test uses**, so two tiles
  // rasterised moments apart during a zoom get the identical value. Taken
  // raw, neighbours rendered at slightly different scales floored their
  // hairlines to slightly different widths, and a road changed thickness at
  // the tile boundary -- the other half of what Ali saw as displacement.
  const steps = Math.round(Math.log2(scale / ref) / FLOOR_DRIFT);
  rec.z0 = Math.pow(2, steps * FLOOR_DRIFT);
  PXS = 1 / rec.z0;
  if (!rec.jobs) {
    if (rec.lv === UNREACHED_LV) {
      // One job, one pass, and `rec.line` indexes the polylines.
      rec.jobs = [{ pink: unreachedUnder(rec) }];
      rec.pink = pinkEpoch;
      rec.ink = null;
    } else {
      const level = levelNamed(rec.lv);
      const groups = [];
      for (const area of state.areas) {
        if (!area.index || !level) continue;
        for (const lines of groupsUnder(area, level, rec)) groups.push(lines);
      }
      // Two passes over EVERYTHING, not one per road: a kerb drawn straight
      // after its own carriageway is overpainted by the next road's
      // carriageway wherever two streets meet, and every junction ends up
      // with a seam.
      rec.jobs = [...groups.map((g) => ({ lines: g, pass: 0 })),
                  ...groups.map((g) => ({ lines: g, pass: 1 }))];
    }
    rec.t1 = performance.now();
    rec.floored = false;
  }
  // ------------------------------------------------------- `?pattern=1`
  //
  // Ali: *"Let's try with just rendering squares instead, for example, and
  // slowly zoom out and see if you see any large repaints or rather large
  // diffs in colors."*
  //
  // **Known content, so any step in the output is the ENGINE.** Every road
  // measurement so far has had to argue about geometry -- how dense the
  // streets are at this octave, how wide that carriageway is, whether a kerb
  // ate it. This has no geometry to argue about: a flat fill that must cover
  // the screen completely, squares of a fixed SCREEN size that must hold a
  // fixed share of it at every zoom, and hairlines a single screen pixel wide
  // that must survive. If any of those moves while the zoom slides, the
  // pipeline did it, and the size of the move is the size of the defect.
  if (PATTERN_ON) {
    const T = TILE_CSS;
    into.clearRect(0, 0, T, T);
    if (PATTERN === 'solid') {
      // A flat block per tile, coloured by its own key. Neighbours differ,
      // and a tile at a different octave differs from one at this octave, so
      // a stand-in is as visible as a hole.
      const h = (rec.ix * 73856093 ^ rec.iy * 19349663 ^ rec.oct * 83492791);
      into.fillStyle = `hsl(${((h % 360) + 360) % 360} 55% `
        + `${38 + (((h >> 9) % 5) + 5) % 5 * 6}%)`;
      into.fillRect(0, 0, T, T);
      into.strokeStyle = 'rgba(0,0,0,0.45)';
      into.lineWidth = 2 * PXS;
      into.strokeRect(PXS, PXS, T - 2 * PXS, T - 2 * PXS);
      into.fillStyle = 'rgba(255,255,255,0.85)';
      into.font = `600 ${11 * PXS}px ui-monospace, monospace`;
      into.fillText(`${rec.lv} @${rec.oct}`, 8 * PXS, 18 * PXS);
      into.fillText(`${rec.ix},${rec.iy}`, 8 * PXS, 32 * PXS);
      rec.paths = 1;
      rec.job = rec.jobs.length;
      FLOOR_HIT = false;
      while (rec.job < rec.jobs.length) { /* nothing to draw */ }
    } else {
    // 1. A flat fill. On screen this must come out as 100% coverage with no
    //    seam, whatever the scale -- it is the blit's own geometry, tested
    //    with nothing else in the way.
    into.fillStyle = ((rec.ix + rec.iy) & 1) ? '#203040' : '#243848';
    into.fillRect(0, 0, T, T);
    // 2. Squares of a fixed SCREEN size on a fixed SCREEN pitch: 4 px on 16
    //    is exactly 1/16 of the screen, at every zoom, for ever.
    const side = 4 * PXS, pitch = 16 * PXS;
    into.fillStyle = '#ffffff';
    for (let y = 0; y < T; y += pitch) {
      for (let x = 0; x < T; x += pitch) into.fillRect(x, y, side, side);
    }
    // 3. Hairlines one screen pixel wide on a 32 px pitch. This is the thing
    //    the carriageway is: a stroke about a pixel across, which either
    //    survives the blit or is antialiased into the background.
    into.strokeStyle = '#ff4d4d';
    into.lineWidth = 1 * PXS;
    into.beginPath();
    for (let y = pitch; y < T; y += 2 * pitch) {
      into.moveTo(0, y + 0.5 * PXS);
      into.lineTo(T, y + 0.5 * PXS);
    }
    into.stroke();
    rec.paths = 1;
    rec.job = rec.jobs.length;
    }
  }

  FLOOR_HIT = false;
  while (rec.job < rec.jobs.length) {
    const job = rec.jobs[rec.job];
    const src = job.pink || job.lines;
    const next = job.pink
      ? drawPinkChunk(rec, into, job.pink, m, SX, SY, rec.line, deadline)
      : drawChunk(into, job.lines, m, job.pass, SX, SY,
                  TILE_CSS, TILE_CSS, 0, 0, rec.line, deadline);
    rec.paths += next.drawn;
    rec.floored = rec.floored || FLOOR_HIT;
    if (next.index >= src.length) { rec.job++; rec.line = 0; } else {
      rec.line = next.index;
      PXS = 1;
      rasterStats.totalMs += performance.now() - started;
      return false;
    }
    if (performance.now() >= deadline) {
      PXS = 1;
      rasterStats.totalMs += performance.now() - started;
      return false;
    }
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
  // **An empty pink tile keeps no pixels.** Most of them are empty at a close
  // zoom -- six of eight on a measured fine view, because the cull rejects
  // 23,835 of 23,860 polylines -- and a blank 768 px canvas is 2.3 MB of
  // cache and a blit every frame for nothing. `drawUnreachedTiles` reads the
  // absent canvas as "clear here" rather than as a hole.
  if (rec.lv === UNREACHED_LV && rec.paths === 0 && rec.canvas) {
    rtBytes -= rec.bytes;
    rec.canvas = null;
    rec.ctx = null;
    rec.bytes = 0;
  }
  rec.jobs = null;
  layers.tileDone(rec.lv, rec.oct, `${rec.ix},${rec.iy}`, performance.now());
  rasterStats.count++;
  // **Which tiles, not how many.** Ali, circling the first number in the
  // toast: "I can see the first number in the bottom aligned toast changing
  // with a lot of changes as the flicker happens." A count that races is
  // either a view asking for new ground or the same ground being drawn over
  // and over, and only a per-key tally tells the two apart.
  REBUILDS.set(rec.key, (REBUILDS.get(rec.key) || 0) + 1);
  // **Work, not latency.** This used to add `now - rec.t1`, the wall-clock
  // span from the tile's first slice to its last -- so a tile spread over ten
  // frames charged all ten frames to the rasteriser, including the time the
  // painter, the network and the browser spent in between. Retracting the
  // blocking gate put more tiles in flight at once, which lengthened every
  // span without adding a single stroke, and the pan-cost bar moved 6% on a
  // change that does no more drawing. Each slice now charges its own
  // duration, which is the thing the test's name claims to measure.
  // **The figures are re-baselined**: the 3,916 ms against 423 ms that
  // justified the tile cache were taken with the old, inflated meter.
  rasterStats.lastMs = Math.round(performance.now() - rec.t1);
  rasterStats.totalMs += performance.now() - started;
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
/** A tile touched this recently is in use, whatever the byte count says. */
const EVICT_GRACE_MS = 2000;

/**
 * Drop the least recently used tiles until the cache fits.
 *
 * **Never one the view has just drawn.** The set this was given was the
 * pending QUEUE -- the tiles still being rasterised -- so everything already
 * finished and on screen was fair game, and a zoom that pushed the cache over
 * its cap took tiles straight out from under the picture. Ali: "when I zoom
 * in and out, there is a lot of flickering and tiles suddenly go missing."
 * They were not missing; they had been deleted.
 *
 * Recency is the right test and it needs no set passed in: `drawLevel` stamps
 * every tile it draws, so anything stamped inside the grace window is on
 * screen or was a moment ago. This is the same rule that fixed the z 11.49
 * flicker in the old engine, and it was lost in the rewrite.
 */
function evictTiles() {
  // **The pink may never displace the map it is drawn on top of.** It shares
  // this cache with the road, and measured at `coarse` its tiles hold 42.5 MB
  // of the 110 -- so on one LRU, with both stamped `used` every frame, the
  // overlay evicts the thing it is an overlay ON. Its own budget is swept
  // first and only ever takes pink, so what degrades under pressure is the
  // pink (standing in from a coarser octave) and never the street.
  //
  // Soft, like the road's: `EVICT_GRACE_MS` still protects anything the view
  // has just drawn, so this drops pink at octaves the view has LEFT and
  // leaves the working set alone.
  let pinkBytes = 0;
  for (const rec of rt.values()) {
    if (rec.lv === UNREACHED_LV) pinkBytes += rec.bytes;
  }
  if (pinkBytes > PINK_MAX_BYTES) {
    const old = performance.now() - EVICT_GRACE_MS;
    const order = [...rt.values()]
      .filter((r) => r.lv === UNREACHED_LV && r.used < old)
      .sort((a, b) => a.used - b.used);
    for (const rec of order) {
      if (pinkBytes <= PINK_MAX_BYTES) break;
      rt.delete(rec.key);
      rtBytes -= rec.bytes + (rec.back ? rec.back.bytes : 0);
      pinkBytes -= rec.bytes;
      rasterStats.evicted++;
    }
  }
  if (rtBytes <= RT_MAX_BYTES) return;
  const cutoff = performance.now() - EVICT_GRACE_MS;
  const order = [...rt.values()]
    .filter((r) => r.used < cutoff)
    .sort((a, b) => a.used - b.used);
  for (const rec of order) {
    if (rtBytes <= RT_MAX_BYTES) break;
    rt.delete(rec.key);
    rtBytes -= rec.bytes + (rec.back ? rec.back.bytes : 0);
    rasterStats.evicted++;
  }
}


// --------------------------------- painter state, restored in place
//
// These sat inside the block the tile-engine rewrite replaced. They
// are not part of the engine -- they are the painter's own -- and
// going out with it is what "the module has no model" looks like from
// the inside.

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

/** The level currently on screen. There is no fade towards another. */
let shownLevel = null;

let lastShown = null;

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

// ------------------------------------------------------- the loading ripple
//
// Ali: *"not only the navigation will show radar blips when loading tiles,
// even when zooming out, we will show the tiles that were not previously
// visible ... and we will show blip animations on them to show that we are
// currently loading that data ... a kind of ripple effect will show as we are
// loading the map data. Also, when panning."*
//
// This is the architecture made visible. There is no backend: every square of
// this map is an object in a bucket, fetched and drawn by the browser, and
// the ripple is that fact on screen rather than a decoration over it. A
// spinner says "wait"; this says where the data is, which squares are already
// yours and which are still coming.
//
// **The cell is a QUARTER OF A RASTER TILE, and not a kilometre.** Ali asked
// for "an artificially small tile size of maybe one kilometre or something
// like that", and measured, a literal kilometre does not survive the zoom
// range: it is 1,111 px at street zoom -- one cell, no ripple -- and 8 px at
// the overview, which is 4,746 cells on a phone. A raster tile is 384 CSS px
// at its reference scale and is shown at `scale / ref` in (0.5, 1], so a
// quarter of one is **48 to 96 px at every zoom**, which is uniform where it
// has to be uniform: on the screen, where the eye reads the ripple. On the
// ground that is 86 m at street zoom and 1,152 m at `coarse` -- Ali's
// kilometre, arrived at from the other end.

/**
 * **Off, and `?ripple=1` turns it on.** Ali, having seen it: "let's disable
 * the ripple when loading things, when zooming or panning." It is kept rather
 * than deleted because the thing it showed is real and the code to show it is
 * cheap; what it turned out to be is a busy overlay on top of a map that
 * already tells you it is loading by getting sharper.
 *
 * It also changes any measurement made by counting lit pixels, since it fills
 * cells -- one test read its baseline off a frame where the wave was at its
 * peak and then called the real map a blackout.
 */
const RIPPLE_ON = Q.get('ripple') === '1';

/** How many cells a raster tile is cut into, each way. */
const RIPPLE_SPLIT = 4;

/** One pulse of a cell still waiting. */
const RIPPLE_MS = 900;

/** How fast the wave travels outward from the middle of the view, px/s. */
const RIPPLE_SPEED = 1400;

/** A cell's last flash when its tile lands. */
const RIPPLE_DONE_MS = 420;

/** Never draw more than this many, whatever the zoom. */
const RIPPLE_MAX = 420;

/** cellKey -> {x, y, w, t0, doneAt} in north-up screen pixels. */
const ripples = new Map();

/**
 * Mark the ground a pending tile covers as loading.
 *
 * Staggered by distance from the middle of the view, which is what makes it
 * a ripple rather than a field of blinking squares: the wave leaves the
 * middle and travels out at `RIPPLE_SPEED`, so a zoom out looks like the map
 * reaching for the ground it has just been asked about.
 */
function noteLoading(rec, now, cx, cy) {
  if (!RIPPLE_ON) return;
  const b = tileBox(rec.oct, rec.ix, rec.iy);
  const step = b.W / RIPPLE_SPLIT;
  if (step < 6) return;                  // finer than the eye, and thousands
  for (let i = 0; i < RIPPLE_SPLIT; i++) {
    for (let j = 0; j < RIPPLE_SPLIT; j++) {
      const key = `${rec.key}|${i},${j}`;
      if (ripples.has(key)) continue;
      const x = b.L + i * step;
      const y = b.Tp + j * (b.H / RIPPLE_SPLIT);
      const d = Math.hypot(x + step / 2 - cx, y + step / 2 - cy);
      ripples.set(key, { x, y, w: step, h: b.H / RIPPLE_SPLIT,
                         t0: now + (d / RIPPLE_SPEED) * 1000, doneAt: 0 });
    }
  }
}

/** That tile landed: its cells flash once and go. */
function noteLoaded(rec, now) {
  for (let i = 0; i < RIPPLE_SPLIT; i++) {
    for (let j = 0; j < RIPPLE_SPLIT; j++) {
      const cell = ripples.get(`${rec.key}|${i},${j}`);
      if (cell && !cell.doneAt) cell.doneAt = now;
    }
  }
}

/**
 * Draw the ripple. Returns true while any of it is alive.
 *
 * A cell waiting pulses; a cell that has just landed rings once and goes. The
 * two read differently on purpose -- "still coming" and "here" are different
 * facts and a readout that renders them the same is a decoration.
 */
function drawRipples(now, pending) {
  if (!ripples.size) return false;
  const W = cv.width / DPR, H = cv.height / DPR;
  let alive = false;
  let drawn = 0;
  ctx.save();
  ctx.lineWidth = 1;
  for (const [key, c] of ripples) {
    // **A cell whose tile is no longer being fetched is not loading.** A fast
    // zoom abandons whole layers, and their tiles leave the queue without
    // ever completing -- so without this the map keeps pulsing over ground
    // nothing is coming for. Measured: 752 cells still breathing five
    // seconds after everything had settled.
    if (!c.doneAt && !pending.has(key.slice(0, key.lastIndexOf('|')))) {
      ripples.delete(key);
      continue;
    }
    if (c.doneAt && now - c.doneAt > RIPPLE_DONE_MS) { ripples.delete(key); continue; }
    if (now < c.t0) { alive = true; continue; }
    if (c.x > W || c.y > H || c.x + c.w < 0 || c.y + c.h < 0) continue;
    alive = true;
    if (drawn++ > RIPPLE_MAX) continue;
    if (c.doneAt) {
      // Landed: one ring out to the cell's own edge, and gone.
      const t = (now - c.doneAt) / RIPPLE_DONE_MS;
      ctx.globalAlpha = (1 - t) * 0.5;
      ctx.strokeStyle = T.blip;
      ctx.beginPath();
      ctx.arc(c.x + c.w / 2, c.y + c.h / 2, ease(t) * c.w * 0.5,
              0, Math.PI * 2);
      ctx.stroke();
    } else {
      // Waiting: a slow breath, so a slow fetch keeps saying so.
      const t = ((now - c.t0) % RIPPLE_MS) / RIPPLE_MS;
      const k = t < 0.5 ? ease(t * 2) : ease((1 - t) * 2);
      ctx.globalAlpha = k * 0.13;
      ctx.fillStyle = T.blip;
      ctx.fillRect(c.x + 1, c.y + 1, c.w - 2, c.h - 2);
      ctx.globalAlpha = k * 0.34;
      ctx.strokeStyle = T.blip;
      ctx.strokeRect(c.x + 1.5, c.y + 1.5, c.w - 3, c.h - 3);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  return alive;
}

// ------------------------------------------------------------- diagnostics
//
// Ali: *"I want you to have a new button that says uh, debug or something. A
// bug icon ... And that will copy the information that you need, which means
// that I will paste it for you here."*
//
// **What it copies is chosen by what has actually gone wrong.** Every line
// below is something that took a round trip to establish by hand: which
// octave each level has live and how much of it is built, whether a tile is
// mid-refresh, what `PXS` the hairline floor is working in, and -- the one
// that cracked the last bug -- the WIDTHS the batcher hands to each pass for
// the tile under the middle of the screen, beside the colour balance of what
// actually reached the glass.
//
// It is text, not JSON: it is going into a chat message, and a wall of braces
// is a wall of braces.

/** A compact count of what is on the glass right now. */
function glassMix() {
  try {
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let kerb = 0, fill = 0, bg = 0, n = 0;
    for (let i = 0; i < d.length; i += 64) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      n++;
      if (g > r + 12 || b > r + 12) kerb++;
      else if (r > 245 && g > 245 && b > 245) fill++;
      else bg++;
    }
    const pc = (v) => `${(100 * v / Math.max(1, n)).toFixed(1)}%`;
    return `kerb ${pc(kerb)} · carriageway ${pc(fill)} · ground ${pc(bg)}`;
  } catch (e) {
    return `unreadable (${e && e.name})`;
  }
}

/** Every stroke width the batcher would use for the tile at the centre. */
function centreStrokes() {
  const area = state.areas.find((a) => a.index);
  const lv = area && shownLevel;
  if (!area || !lv) return ['no level on screen'];
  const oct = octFor(scale);
  const r = tileRange(oct);
  const ix = Math.floor((r.ix0 + r.ix1) / 2);
  const iy = Math.floor((r.iy0 + r.iy1) / 2);
  const fake = { key: 'diag', lv, oct, ix, iy, done: false, t0: 0, used: 0,
                 bytes: 0, jobs: null, job: 0, line: 0, paths: 0, dpr: DPR,
                 data: dataEpoch, back: null, canvas: null, ctx: null };
  BATCH_SPY = [];
  try {
    let guard = 0;
    while (!stepTile(fake, 5000) && guard++ < 200) { /* one tile */ }
  } catch (e) {
    BATCH_SPY = null;
    return [`raster threw: ${e && e.message}`];
  }
  const spy = BATCH_SPY;
  BATCH_SPY = null;
  rtBytes -= fake.bytes;
  const by = new Map();
  for (const [pass, style, w] of spy) {
    const k = `pass${pass} ${style}`;
    const v = by.get(k) || { n: 0, lo: Infinity, hi: -Infinity };
    v.n++;
    v.lo = Math.min(v.lo, w);
    v.hi = Math.max(v.hi, w);
    by.set(k, v);
  }
  const out = [`tile ${ix},${iy} @ oct ${oct} · ${fake.paths} paths · `
    + `PXS ${(1 / (fake.z0 || 1)).toFixed(2)}`];
  for (const [k, v] of by) {
    out.push(`  ${k}  n=${v.n}  width ${v.lo.toFixed(2)}..${v.hi.toFixed(2)}`);
  }
  if (!by.size) out.push('  nothing batched');
  return out;
}

function debugReport() {
  const w = cv.width / DPR, h = cv.height / DPR;
  const a = state.areas.find((x) => x.index);
  const lv = a ? levelFor(a) : null;
  const deg = ((heading * 180 / Math.PI) % 360 + 360) % 360;
  const L = [];
  L.push('ALI MAPS DIAGNOSTICS');
  L.push(location.href);
  L.push(`built ${(document.querySelector('script[src*="app.js"]') || {}).src
    || '?'}`.replace(/^.*\?v=/, 'assets v='));
  L.push('');
  L.push(`view      z ${slippyZoom().toFixed(2)} · ${mpp().toFixed(2)} m/px `
    + `· bearing ${deg.toFixed(0)}°`);
  L.push(`screen    ${Math.round(w)}x${Math.round(h)} css · dpr ${DPR} `
    + `· ${themeName} (${themeChoice})`);
  L.push(`showing   ${shownLevel || '-'}${lv ? '' : ''}`);
  L.push(`glass     ${glassMix()}`);
  L.push('');
  L.push('LAYERS');
  for (const [name, lev] of layers.levels) {
    const bits = [];
    if (lev.live) {
      bits.push(`live oct ${lev.live.oct} (${lev.live.done.size} tiles`
        + `${lev.live.streaming.size ? ', ' + lev.live.streaming.size
          + ' streaming' : ''})`);
    }
    if (lev.building) {
      let have = 0;
      for (const k of lev.building.blocking) {
        if (lev.building.done.has(k)) have++;
      }
      bits.push(`building oct ${lev.building.oct} `
        + `${have}/${lev.building.blocking.size}`);
    }
    if (lev.retired.length) bits.push(`${lev.retired.length} retired`);
    L.push(`  ${name.padEnd(9)} ${bits.join(' · ') || 'nothing'}`);
  }
  L.push('');
  L.push('TILES');
  const refreshing = [...rt.values()].filter((t) => t.back).length;
  const undone = [...rt.values()].filter((t) => !t.done).length;
  L.push(`  ${rt.size} held · ${(sceneBytes() / 1e6).toFixed(0)} MB · `
    + `${undone} unbuilt · ${refreshing} refreshing · `
    + `${rasterStats.evicted} evicted · epoch ${dataEpoch}`);
  const z0s = [...new Set([...rt.values()].filter((t) => t.done)
    .map((t) => +(t.z0 || 0).toFixed(3)))];
  L.push(`  z0 in use ${z0s.join(', ') || '-'}`);
  L.push(`  data tiles decoded ${state.areas.reduce(
    (n, x) => n + x.tiles.size, 0)}`);
  L.push('');
  L.push('STROKES AT THE CENTRE');
  for (const line of centreStrokes()) L.push(`  ${line}`);
  L.push('');
  L.push('TIMING (ms total / worst)');
  for (const x of spanSummary().slice(0, 6)) {
    L.push(`  ${x.name.padEnd(14)} n=${String(x.n).padStart(4)} `
      + `total ${String(Math.round(x.total)).padStart(6)} `
      + `worst ${x.worst.toFixed(1)}`);
  }
  if (WORKER_ERROR) {
    L.push('');
    L.push('ROUTING WORKER');
    // **Why it refused, not just that it did.** Ali's panel reported "the
    // routing worker did not start" with nothing to act on; the cause is
    // the one thing that would have said whether it is the module type,
    // the asset version query or the origin.
    L.push(`  did not start: ${WORKER_ERROR}`);
    L.push('  routing fell back to the main thread');
  }
  if (jsErrors.length) {
    L.push('');
    L.push('ERRORS');
    for (const e of jsErrors.slice(-5)) L.push(`  ${e}`);
  }
  return L.join('\n');
}

/** Page errors, kept so the report can carry them. */
const jsErrors = [];
addEventListener('error', (e) => {
  jsErrors.push(`${e.message} @ ${(e.filename || '').split('/').pop()}:`
    + `${e.lineno}`);
});
addEventListener('unhandledrejection', (e) => {
  jsErrors.push(`unhandled: ${e.reason && e.reason.message}`);
});

/**
 * The screenshot and the numbers, as one image.
 *
 * Ali: *"you can make the debug download a screenshot of the canvas ... and
 * include the diagnostics yourself in the text in the image, which means that
 * you can expand the image beyond the actual screenshot with your own text.
 * In order not to occlude anything important."*
 *
 * Exactly that: the canvas at the top at its own size, and the report printed
 * on a panel GROWN BELOW it, so nothing is written over the map. One paste
 * then carries both the picture and the state that produced it -- which is
 * the whole cost of the last four rounds, where a screenshot said something
 * was wrong and everything else had to be reconstructed by hand.
 */
const SHOT_PAD = 14;
const SHOT_LINE = 17;
const SHOT_FONT = '12px ui-monospace, SFMono-Regular, Menlo, monospace';

function diagnosticImage(text) {
  const lines = text.split('\n');
  const w = cv.width;
  const scale2 = Math.min(1, w / 460);       // keep the text legible on a phone
  const lh = SHOT_LINE / scale2;
  const panel = Math.round(lines.length * lh + SHOT_PAD * 2 / scale2);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = cv.height + panel;
  const g = out.getContext('2d');
  // The map first, untouched and at its own resolution.
  g.drawImage(cv, 0, 0);
  // The report panel is always dark, whatever the map's theme: it is a bug
  // report and not a map. Taken from the palette rather than restated, so
  // it cannot be the one colour left behind when the palette moves.
  g.fillStyle = THEMES.dark.bg;
  g.fillRect(0, cv.height, w, panel);
  g.fillStyle = '#7d8996';
  g.fillRect(0, cv.height, w, Math.max(1, Math.round(1 / scale2)));
  g.font = `${Math.round(12 / scale2)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  g.textBaseline = 'top';
  let y = cv.height + SHOT_PAD / scale2;
  for (const line of lines) {
    // Headings in the accent, values in a quiet grey: this is read at a
    // glance in a chat window, not studied.
    g.fillStyle = /^[A-Z][A-Z ]+$/.test(line.trim()) ? '#ffd166'
      : line.startsWith('  ') ? '#9fb0c4' : '#e9edf3';
    g.fillText(line, SHOT_PAD / scale2, y);
    y += lh;
  }
  return out;
}

async function copyDiagnostics() {
  const btn = $('debug');
  const text = debugReport();
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (e) {
    // **A fallback, because the clipboard API is refused more often than it
    // is granted**: an insecure origin, a permissions policy, a browser that
    // wants a user gesture it does not believe it had. A diagnostics button
    // that silently fails is worse than none.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch (err) { ok = false; }
  }
  if (btn) {
    btn.classList.add('done');
    setTimeout(() => btn.classList.remove('done'), 1200);
  }

  // The image is the point; the text on the clipboard is a bonus for anyone
  // who would rather paste words.
  const img = diagnosticImage(text);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `ali-maps-${stamp}.png`;
  const blob = await new Promise((res) => img.toBlob(res, 'image/png'));
  if (!blob) { hint('Could not make the image.'); return; }

  const file = new File([blob], name, { type: 'image/png' });
  // **Share first on a phone, download on a desktop.** A download on Android
  // lands in a folder somebody then has to go and find; the share sheet puts
  // it straight into the conversation, which is where Ali is pasting it.
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Ali Maps diagnostics' });
      hint('Diagnostics shared.');
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;      // they changed their mind
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  hint(ok ? 'Diagnostics saved as an image, and copied as text.'
          : 'Diagnostics saved as an image.');
}

/** The `ix,iy` keys of the tiles this view needs at an octave. */
function visibleKeys(oct) {
  const r = tileRange(oct);
  const out = [];
  // A range from a stale octave can be enormous; the LayerSet only ever gets
  // asked about the octave the view actually wants, so this stays small.
  for (let ix = r.ix0; ix <= r.ix1; ix++) {
    for (let iy = r.iy0; iy <= r.iy1; iy++) out.push(`${ix},${iy}`);
  }
  return out;
}

/** The pixel record for one tile, made on demand. */
function tileRec(name, oct, key) {
  const [ix, iy] = key.split(',').map(Number);
  const k = rtKey(name, oct, ix, iy);
  let rec = rt.get(k);
  if (rec && rec.dpr !== DPR) {
    rt.delete(k);
    rtBytes -= rec.bytes + (rec.back ? rec.back.bytes : 0);
    rec = null;
  }
  if (!rec) rec = newTile(name, oct, ix, iy);
  return rec;
}

/**
 * Tell the LayerSet what this level needs, and queue what is missing.
 *
 * Blocking first: a layer cannot appear until all of them are in, so working
 * on a streamed tile ahead of a blocking one delays the reveal for nothing.
 */
function pumpLevel(level, now, queue) {
  const oct = octFor(scale);
  const keys = visibleKeys(oct);
  const req = layers.want(level.name, oct, keys, now);
  for (const key of req.blocking) queue.push(tileRec(level.name, oct, key));
  for (const key of req.streaming) queue.push(tileRec(level.name, oct, key));

  // **A finished tile can still be out of date, and the rewrite lost this.**
  // A raster tile is rasterised from whatever DATA tiles have arrived, so one
  // built before its data landed is permanently short: roads stop dead at its
  // edge, which is what Ali photographed. The old engine refreshed on the
  // data epoch and on hairline drift, and moving the queueing into the
  // LayerSet dropped it -- `want` cannot report a tile as pending, because as
  // far as it is concerned the tile is done.
  //
  // The refresh renders into a second canvas and swaps when it lands, so
  // nothing blinks while it runs.
  refreshTiles(level.name, oct, keys, queue);
  return req;
}

/**
 * Bring finished tiles up to date, for ANY level holding a live layer.
 *
 * Split out of `pumpLevel` when the blocking gate was retracted. A level that
 * is not in the blend is not pumped -- `mid` sits at `want.t === 0` for most
 * of a session -- and under the old rule that was harmless, because a layer
 * nobody finished never went live and so was never part of a plan. Now it
 * goes live on its first tile, so a `mid` tile rasterised before its data
 * landed is a permanently empty tile inside a LIVE layer, waiting for the
 * blend to move onto it. Measured: four of them at
 * `#15.48/24.81220/46.63378/27`, every one on `mid`.
 */
function refreshTiles(name, oct, keys, queue, create = true) {
  for (const key of keys) {
    // **Never CREATE a record for a level nobody is building.** The first
    // version called `tileRec`, which allocates, so every frame minted
    // twenty-five records for a level that would never rasterise them: the
    // cache grew without bound, the eviction pass thrashed, and seven tests
    // that had nothing to do with this went from two seconds to forty-seven.
    // A refresh is for a tile that exists.
    const rec = create ? tileRec(name, oct, key)
                       : rt.get(rtKey(name, oct, ...key.split(',').map(Number)));
    if (!rec) continue;
    // **A refresh that is not re-queued is a refresh that never finishes**,
    // and that is the hole Ali photographed. `want` only ever returns keys
    // the LayerSet still calls pending, and a refreshed tile is not one: it
    // was reported done long ago and lives in `layer.done` for good. So the
    // ONLY frame in which a refresh was ever queued was the frame that
    // started it. If it did not fit in that frame's budget -- and a
    // full-detail tile never does -- it sat with `back` allocated, `jobs`
    // null and `job` 0 for the rest of the session, while the blit went on
    // drawing the canvas it was refreshing AWAY from.
    //
    // Measured at `#15.48/24.81220/46.63378/27`: two of the twenty-five live
    // `fine` tiles, both beside the centre, stuck at 0 paths for as long as
    // the page was open, which on screen is a band of empty ground with the
    // neighbours' roads ending in stubs at its edge.
    if (rec.back) { queue.push(rec); continue; }
    if (!rec.done) continue;                  // the layer queue owns this one
    if (rec.data !== dataEpoch || floorDrifted(rec)) {
      refreshTile(rec);
      queue.push(rec);
    }
  }
}

/**
 * Draw one level: its backdrop, then the layer coming in over it.
 *
 * **There is one rule here and it used to be six conditions.** A live layer
 * is never taken away until another is live, so "do not fade anything out
 * until something has taken its place" is a property of the state machine
 * rather than a test this function has to remember to make.
 */
/**
 * **Pre-rendered tiles, behind `?raster=pre`, for the zooms where this map
 * is a single hairline.**
 *
 * 651f894 deleted an earlier pre-rendered tileset on Ali's word, and the
 * reason was DRIFT: "the ladder, the palettes and the widths all had to be
 * expressed twice... A second copy of the map that has to be kept in step
 * with the first is a second map." That rule stands, and this is built so
 * the three things that drifted cannot:
 *
 *   * there is no ladder in it -- the raster carries EVERY road, because it
 *     has no byte budget to declutter against;
 *   * there is no second pass -- `rasterlevel.py` refuses to render at or
 *     below the 4.09 m/px where `roadWidths` first returns a carriageway, so
 *     above that the whole map is one stroke in one colour;
 *   * and the builder READS `THIN_PX`, `LAT0` and the palette out of this
 *     file rather than restating them.
 *
 * It is OFF by default and the vector path is untouched, so the two can be
 * compared on one view rather than from memory.
 */
// **ON by default** (Ali, 2026-10-08: "Looks good lets enable it").
// `?prerender=0` forces the vector path, so the two can still be compared
// on one view rather than from memory.
const PRERENDER = Q.get('prerender') !== '0';
/**
 * Did the pre-rendered pass actually put something on the glass last frame?
 *
 * **The byte saving is here, not in the blit.** Skipping the vector fetch is
 * the whole point - a level that is never asked for is never downloaded or
 * rasterised - but skipping it before the raster has drawn would show a
 * blank frame if a tile were slow or missing. So the vectors keep running
 * until the raster has covered the view once, and resume the moment it
 * stops: one frame of overlap, and it cannot fail closed.
 */
let PRE_DREW = false;
/**
 * May the vector level be skipped THIS frame?
 *
 * `PRE_DREW` alone is not enough, and the first load is why: on frame one
 * nothing has drawn yet, so a rule that waits for ink downloads the whole
 * vector level before the first raster tile has had a chance to land - which
 * is the half of Ali's complaint the pictures do not show (*"nor is it a
 * particularly lightweight file to download"*). So the hold also covers
 * WAITING: while the raster for this view is still in flight the vector
 * fetch does not start, and it starts the moment the raster gives up.
 *
 * **It cannot wait for ever.** `PRE_GRACE_MS` bounds it, and a level whose
 * every visible tile has come back empty gives up at once rather than
 * waiting out the clock.
 */
let PRE_HOLD = true;
const PRE_GRACE_MS = 4000;
const preIndex = new Map();          // base -> index | null | 'loading'
const preTile = new Map();           // url -> ImageBitmap | 'loading' | null
const preSince = new Map();          // level dir -> when its tiles were asked
/** When the vectors first covered the view during a hold; 0 when not held. */
let preFadeAt = 0;
/**
 * The level being dissolved FROM, and when the dissolve started.
 *
 * **Ali, 2026-10-09: *"I have tried intensively and never saw a fade."*
 * Ali is right and the engine's own fade machinery is not a counter-example.**
 * `LEVEL_FADE_MS` only ever applied to one OCTAVE of a level replacing
 * another octave of the SAME level -- two pictures of the same roads at two
 * reference scales -- and measured across a real octave crossing that is
 * **12.19% of the glass against 12.16%**: a dissolve between two pictures
 * nobody can tell apart. A fade you cannot see is not a fade.
 *
 * What a person actually sees is a change of LEVEL, and every rung of the
 * ladder is a step in content: the ways go 100 / 40.7 / 22.9 / 11.5 / 5.2
 * per cent down `fine, mid, coarse, wide, overview`, so each step roughly
 * halves the map. Those stepped, with nothing in between.
 *
 * **This is NOT the blend Ali removed on 2026-09-28.** That was a span of
 * zoom where two levels were continuously mixed, with a settle timer to
 * stop it sticking half way -- eleven direction reversals in one slow zoom.
 * This is a one-shot dissolve on a discrete switch, with no zoom-span mixing
 * and no settle: it starts when the new level COVERS the view, runs once,
 * and ends. It cannot stick, because nothing re-reads the zoom while it
 * runs.
 */
let fadeFrom = null;
let levelFadeAt = 0;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/**
 * How many decoded pre-rendered tiles to hold. A 256 px bitmap is a quarter
 * of a megabyte, and a session that pans the whole city at the finest
 * pre-rendered level would otherwise hold every tile of it for ever -- 320
 * for Riyadh today, and four times that at the next level down. A view needs
 * a few dozen, so this is generous and still bounded.
 */
const PRE_TILE_CAP = 240;

/** Drop the oldest decoded tiles, which is insertion order in a `Map`. */
function preEvict() {
  if (preTile.size <= PRE_TILE_CAP) return;
  for (const [url, img] of preTile) {
    if (preTile.size <= PRE_TILE_CAP * 0.8) break;
    if (img === 'loading') continue;   // in flight: its `then` still needs it
    if (img && img.close) img.close();
    preTile.delete(url);
  }
}

/**
 * Which pre-rendered level serves this view, or null to leave it to vectors.
 *
 * **A tile is only ever shrunk, never magnified** -- the octave cache's own
 * rule, and for the same reason: magnifying a raster is blur. So below the
 * finest level published (`minMpp`) this returns null and the vector path
 * runs untouched, which is why `fine` and `mid` are unaffected by any of it.
 *
 * **And "shrunk" is `lv.mpp <= m`, which is the direction this had
 * backwards.** A tile drawn at `lv.mpp` covers `tile * lv.mpp` metres and
 * lands on `tile * lv.mpp / m` screen pixels, so a level COARSER than the
 * view is the one that gets blown up. Pick the coarsest level that is still
 * at or finer than the view: least shrink, fewest tiles, no magnification.
 */
function preLevelFor(idx, m) {
  const set = idx.themes && idx.themes[themeName];
  if (!set || !set.levels || !set.levels.length) return null;
  if (m < (idx.minMpp || 0)) return null;
  let best = null;
  for (const lv of set.levels) {
    if (lv.mpp <= m && (!best || lv.mpp > best.mpp)) best = lv;
  }
  return best;
}

/** Does the pre-rendered set cover this view? Asked before any vector work. */
function preCovers(area) {
  if (!PRERENDER || !area) return false;
  const idx = preIndex.get(area.base);
  if (!idx || idx === 'loading') return false;
  return !!preLevelFor(idx, mpp());
}

/**
 * How far BELOW its own floor the raster may be held while the vectors come.
 *
 * **Dropping the raster the instant the view crosses `minMpp` was worth ten
 * blank frames.** Measured across 8.7 m/px (z 13.99 -> 14.02, three
 * hundredths): the glass goes 36.06% kerb to **0.00% for ten frames**, then
 * crawls, and takes **fourteen** to reach 80% of where it lands. The control
 * names the cause in one column -- `data tiles decoded 0 -> 12` with the
 * raster on against `12 -> 12` under `?prerender=0`, which has **zero blank
 * frames**. Nothing was in hand, because a level that is never asked for is
 * never downloaded (E1044, working exactly as designed).
 *
 * So the raster is HELD past its floor until the vector level covers the
 * view, which is this engine's own oldest rule -- Ali: *"we should not fade
 * out any tiles unless new tiles have taken their place"* -- applied to the
 * one handover that did not have it. Crossing the floor already makes
 * `preCovers` false, so the vectors start fetching on that very frame; the
 * hold simply covers the gap.
 *
 * **A fetch margin was built first and thrown away**: warming the vectors
 * within 2x of the floor also removed the blank, and cost **5.65 MB at 14
 * m/px** for a level the view might never reach. The hold costs nothing and
 * is bounded instead by BLUR -- a raster is only ever shrunk (`preLevelFor`),
 * and holding one below its floor magnifies it. At 1.5x the worst case is a
 * tile stretched half again, for the second or so the vectors take; past
 * that it gives up and the old behaviour returns, which fails closed.
 */
const PRE_HOLD_MAG = 1.5;

/** The finest level, for the hold: below the floor there is no choice. */
function preFinest(idx) {
  const set = idx.themes && idx.themes[themeName];
  if (!set || !set.levels || !set.levels.length) return null;
  let best = null;
  for (const lv of set.levels) if (!best || lv.mpp < best.mpp) best = lv;
  return best;
}

/**
 * Just below the floor, with a raster still worth magnifying? Draws nothing.
 *
 * Asked BEFORE anything is drawn, because during the dissolve the vectors go
 * down first and the raster on top of them.
 */
function preHoldable(area) {
  if (!PRERENDER || !area) return null;
  const idx = preIndex.get(area.base);
  if (!idx || idx === 'loading') return null;
  const floor = idx.minMpp || 0;
  const m = mpp();
  if (!floor || m >= floor) return null;          // the floor is not crossed
  if (m * PRE_HOLD_MAG < floor) return null;      // too far in; it would blur
  return preFinest(idx);
}


/**
 * Draw the pre-rendered level, and say whether the vectors are still needed.
 *
 * Returns `'drew'` when something reached the glass, `'wait'` while the index
 * or a tile is still in flight and the grace has not run out, and `false`
 * when there is no raster for this view or it has failed.
 */
/** The raster level whose tiles are on the glass, per area, for the hold. */
const preShown = new Map();          // base -> level dir
/** When the dissolve between two RASTER levels started, per area. */
const preSwapAt = new Map();         // base -> ms

/** A raster level by its own `dir`, which is what the index keys on. */
function preByDir(idx, dir) {
  const set = idx.themes && idx.themes[themeName];
  if (!set || !set.levels) return null;
  return set.levels.find((lv) => lv.dir === dir) || null;
}

/**
 * One raster level's visible tiles: requested always, drawn when `alpha > 0`.
 *
 * Lifted out of `drawPrerendered` so the hold can ASK whether the incoming
 * level covers the view without drawing it, and so there is exactly one copy
 * of the tile loop -- two would be the drift this whole file is about.
 *
 * `got` counts a tile that FAILED as settled: a tile the server does not have
 * is never coming, and waiting for it would wedge the hold for ever.
 */
function drawPreLevel(area, idx, lv, alpha, now) {
  const s = lv.scale, kx = idx.kx, T = lv.tile || 256;
  const box = viewBox();
  let drew = false, pending = false, want = 0, got = 0;
  for (const [ix, iy] of lv.tiles) {
    const lon0 = (ix * T) / (kx * s), lon1 = ((ix + 1) * T) / (kx * s);
    const lat1 = -(iy * T) / s, lat0 = -((iy + 1) * T) / s;
    const L = sx(lon0), R = sx(lon1), Tp = sy(lat1), B = sy(lat0);
    if (R < box.x0 || L > box.x1 || B < box.y0 || Tp > box.y1) continue;
    want++;
    const url = area.base + '/raster/' + lv.dir + '/' + ix + '/' + iy + '.webp';
    const img = preTile.get(url);
    if (img === undefined) {
      preTile.set(url, 'loading');
      fetch(url)
        .then((r) => (r.ok ? r.blob() : null))
        .then((bl) => (bl ? createImageBitmap(bl) : null))
        .then((bm) => { preTile.set(url, bm); preEvict(); draw(); })
        .catch(() => { preTile.set(url, null); draw(); });
      pending = true;
      continue;
    }
    if (img === 'loading') { pending = true; continue; }
    got++;
    if (!img) continue;        // this one failed; the others may still land
    if (alpha <= 0) continue;  // asked for and not drawn: this is a cover test
    // Float, for the same reason as `tileBox` (E1060): rounding displaced
    // each tile by up to half a pixel and made a slow pinch jank by one.
    // These tiles are OPAQUE, so the edge does antialias -- against a canvas
    // cleared to the very colour the tile's own ground is (E1052), which is
    // why it cannot show.
    ctx.drawImage(img, L, Tp, R - L, B - Tp);
    BLITS.level++;
    drew = true;
  }
  return { drew, pending, want, got, covers: want > 0 && got === want };
}

/**
 * How far a held raster level may be magnified while its successor arrives.
 *
 * Adjacent published levels are a factor of two apart, so zooming IN across a
 * boundary means magnifying the outgoing (coarser) one by up to 2x before the
 * finer one lands. Anything past that is a level two steps away and not worth
 * the blur. Zooming OUT holds the FINER level, which is SHRUNK, and shrinking
 * is the one thing a raster is always allowed -- so this only binds one way.
 */
const PRE_SWAP_MAG = 2.2;

/**
 * Draw the pre-rendered level, and say whether the vectors are still needed.
 *
 * Returns `'drew'` when something reached the glass, `'wait'` while the index
 * or a tile is still in flight and the grace has not run out, and `false`
 * when there is no raster for this view or it has failed.
 *
 * ***AND A CHANGE OF RASTER LEVEL IS A HANDOVER LIKE ANY OTHER*** (E1057).
 * Ali, 2026-10-09: *"I don't see that we are fading between the rasterized
 * zoom levels."* There was nothing to see: this picked one level and drew it,
 * so crossing 17.4 m/px swapped the 8.7 tiles for the 17.4 tiles in a single
 * frame. Measured WARM the glass steps **41% to 64% in one frame** and back
 * 64% to 43%; measured COLD it was far worse -- the outgoing level was
 * dropped before the incoming one had arrived and the map read **0.17% for
 * fourteen frames**.
 *
 * E1051 fixed exactly this for the raster-to-vector handover, and the rule is
 * the same one: *"we should not fade out any tiles unless new tiles have
 * taken their place"*. So the outgoing level is HELD until the incoming one
 * covers the view, and then dissolves into it. The hold needs no extra fetch
 * -- the cover test requests the incoming tiles itself.
 */
function drawPrerendered(area, now, alpha = 1, force = null) {
  if (!PRERENDER) return false;
  // **Only ask when the area says it has one.** A speculative fetch 404s on
  // every area that does not, and a browser logs that as a console error
  // whatever the caller does with the promise - which is a real failure, not
  // noise: the e2e suite's "no console errors" caught it. The area index
  // carries the path, so an area without a raster makes no request at all.
  if (!area.index || !area.index.raster) return false;
  const have = preIndex.get(area.base);
  if (have === undefined) {
    preIndex.set(area.base, 'loading');
    fetch(area.base + '/' + area.index.raster)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { preIndex.set(area.base, j); draw(); })
      .catch(() => { preIndex.set(area.base, null); });
    return 'wait';
  }
  if (have === 'loading') return 'wait';
  if (!have) return false;

  const lv = force || preLevelFor(have, mpp());
  if (!lv) return false;
  if (alpha <= 0) return false;

  // ---------------------------------------------------- the level handover
  // `force` is the vector handover's own hold and has already chosen; this
  // runs only on the ordinary path, where the zoom picks the level.
  let outgoing = null, outA = 0;
  if (!force) {
    const shown = preShown.get(area.base);
    const old = shown && shown !== lv.dir ? preByDir(have, shown) : null;
    // Hold a NEIGHBOUR, and never magnify one far past its own scale.
    if (old && mpp() * PRE_SWAP_MAG >= old.mpp) {
      const cov = drawPreLevel(area, have, lv, 0, now);     // request, no ink
      if (!cov.covers) {
        preSwapAt.delete(area.base);
        ctx.save();
        ctx.globalAlpha = alpha;
        const held = drawPreLevel(area, have, old, 1, now);
        ctx.restore();
        if (held.drew) {
          draw();                   // keep asking until the new one covers
          return 'drew';
        }
        // The outgoing level has been evicted too; there is nothing to hold.
      } else {
        let t0 = preSwapAt.get(area.base);
        if (!t0) { t0 = now; preSwapAt.set(area.base, t0); }
        outA = 1 - clamp01((now - t0) / LEVEL_FADE_MS);
        if (outA > 0) outgoing = old;
        else preSwapAt.delete(area.base);
      }
    } else {
      preSwapAt.delete(area.base);
    }
  }

  const since = area.base + '|' + lv.dir;
  if (!preSince.has(since)) preSince.set(since, now);
  ctx.save();
  ctx.globalAlpha = alpha;
  const r = drawPreLevel(area, have, lv, 1, now);
  // The outgoing level goes ON TOP at a falling alpha, which is a
  // cross-dissolve and not an overlay (E1051's own ordering).
  if (outgoing) {
    ctx.globalAlpha = alpha * outA;
    drawPreLevel(area, have, outgoing, 1, now);
    draw();                         // a dissolve needs the next frame
  }
  ctx.restore();
  if (r.drew) {
    if (!force && !outgoing) preShown.set(area.base, lv.dir);
    return 'drew';
  }
  // Nothing is outstanding, so nothing more is coming: fall back now rather
  // than sitting out the grace on a view the raster cannot serve.
  if (!r.pending) return false;
  return (now - preSince.get(since)) < PRE_GRACE_MS ? 'wait' : false;
}

function drawLevel(name, alpha, now) {
  const plan = layers.plan(name, now, !levelStale(name));
  if (!plan || alpha <= 0) return false;
  let drew = false;
  for (const part of [...plan.backdrop, plan.front]) {
    for (const t of part.tiles) {
      const [ix, iy] = t.key.split(',').map(Number);
      const rec = rt.get(rtKey(name, part.oct, ix, iy));
      if (!rec || !rec.canvas) continue;
      const b = tileBox(part.oct, ix, iy);
      const W = cv.width / DPR, H = cv.height / DPR;
      if (!tileOnScreen(b)) continue;
      rec.used = now;
      ctx.globalAlpha = alpha * part.alpha * t.alpha;
      ctx.drawImage(rec.canvas, b.L, b.Tp, b.W, b.H);
      BLITS.level++;
      drew = true;
    }
  }
  ctx.globalAlpha = 1;
  if (plan.fading) draw();
  return drew;
}

/**
 * Draw the map straight to the screen, with no tiles in between.
 *
 * **`?raster=0`, and it exists because the tile cache may not be paying for
 * itself.** Ali, after three refuted fixes for the octave flip: *"If you
 * cannot reproduce it nor fix it, then you need to refactor the engine and
 * simplify."* The flip is reproducible and unexplained, and everything it
 * needs to happen comes from ONE decision -- that a tile is rasterised for a
 * REFERENCE octave and shown at a different, sliding scale. That decision is
 * where `PXS`, `z0`, the drift refresh, the quantisation grid, the ancestor
 * blit, the eviction and the supersampling that slides 1x to 2x inside every
 * octave all come from, and the flip with them.
 *
 * Drawing in screen space removes every one of those at a stroke: there is no
 * octave, so `PXS` is 1, a pixel is a pixel, and there is no boundary to flip
 * at. `drawChunk` already takes a projection, so this is the same batcher and
 * the same widths -- nothing is reimplemented, which is what makes the two
 * comparable at all.
 *
 * **And the measurement that bought the tile cache is not evidence any more.**
 * "Ten pans cost 3,916 ms with a viewport bitmap and 423 ms with a tile cache"
 * was taken through `rasterStats.totalMs`, which charged a tile the WALL-CLOCK
 * SPAN from its first slice to its last -- the painter, the network and the
 * browser in between included. That meter was corrected the day before this
 * was written, so the number that justified the whole design has never been
 * taken honestly.
 */
const RASTER = Q.get('raster') !== '0';

/**
 * Synthetic tile content, so a step in the output is the engine's.
 *
 * `?pattern=1` draws squares of a fixed SCREEN size -- a known share of the
 * glass at every zoom -- and hairlines one pixel wide.
 *
 * `?pattern=solid` fills each tile with ONE flat colour and nothing else.
 * Ali: *"can we try with solid color rasterized boxes so i can see how it
 * looks"*. It is the cleanest question this codebase can ask: a flat square
 * has no thin lines to lose, no antialiasing to argue about and no geometry
 * at all, so **whatever still moves is the engine moving it** -- and every
 * tile arriving, fading, being stood in for or thrown away is visible to the
 * eye as a block of colour appearing or changing. The colour is a hash of the
 * tile's own key, so neighbours differ and the octave is legible at a glance.
 */
const PATTERN = Q.get('pattern') || '';
const PATTERN_ON = PATTERN === '1' || PATTERN === 'solid';

/**
 * How many tile blits each pass made, for the frame just drawn.
 *
 * The synthetic pattern is what made this worth counting. Its white squares
 * are a fixed 1/16 of the screen at every zoom BY CONSTRUCTION, so a reading
 * of 25% cannot be the pattern and cannot be the scale -- it can only be the
 * same ground painted more than once, by layers at different octaves whose
 * squares land in different places. A compositor that stacks four pictures of
 * one street draws that street four times, which is what a kerb turning to
 * mud and a carriageway turning to nothing looks like.
 */
const BLITS = { level: 0, ancestor: 0, leftover: 0, fallback: 0 };

/** How many times each tile key has been rasterised since load. */
const REBUILDS = new Map();

function drawDirect(area, want, now) {
  const W = cv.width / DPR, H = cv.height / DPR;
  const m = mpp();
  // A rotated viewport's ground reaches outside the screen rectangle, and
  // `drawChunk` derives its cull box from the corners it is given. Shift the
  // projection into a padded box and translate the same amount back out, so
  // the culling is generous and the drawing lands exactly where it would.
  const P = Math.ceil(Math.hypot(W, H) / 2);
  const SX = (lon) => sx(lon) + P;
  const SY = (lat) => sy(lat) + P;
  const levels = [want];
  let drew = false;
  ctx.save();
  ctx.translate(-P, -P);
  // Two passes over EVERYTHING, not one per road: a kerb drawn straight after
  // its own carriageway is overpainted by the next road's carriageway
  // wherever two streets meet, and every junction ends up with a seam.
  for (let pass = 0; pass < 2; pass++) {
    for (const lv of levels) {
      ctx.globalAlpha = 1;
      for (const lines of visibleGroups(area, lv)) {
        const r = drawChunk(ctx, lines, m, pass, SX, SY,
                            W + 2 * P, H + 2 * P, 0, 0, 0, Infinity);
        if (r.drawn) drew = true;
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  return drew;
}

/**
 * A tile the live layer has not built yet, drawn from its own ANCESTOR.
 *
 * The coarser octave containing it, blitted from the matching sub-rectangle.
 * `app.js` has described this since the tile cache was written -- "that is
 * what stops a hole at the edge of a pan" -- and the rewrite deleted it: it
 * was one of the six disagreeing conditions `levelStale` replaced, and the
 * comment was left behind describing code that is no longer there.
 *
 * Retracting the blocking gate is what made its absence matter. A layer used
 * to reach the screen complete, so a missing tile was a transient nobody saw;
 * now a layer is on screen from its first tile and every one still building
 * is a rectangle of background. Measured across the z9.36 boundary under a
 * loaded box, twelve consecutive frames at 35-45% of the settled ink, with
 * nothing to fall back on because `overview` is the coarsest LEVEL there --
 * the only picture of that ground in hand is the same level one octave up.
 *
 * Drawn UNDER the layer's own tiles, so a real tile always wins, and bounded
 * to four octaves: past that a tile is a smear, and a smear is a lie about
 * how much we know.
 */
function drawAncestors(name, now) {
  const oct = octFor(scale);
  const L = layers.levels.get(name);
  // **A level with NO layer is exactly when this matters most.** Bailing here
  // meant that the instant the ladder stepped to a level the engine had never
  // built -- which is every level switch -- the gap-filler did nothing at
  // all, and the map was whatever `drawLevel` could manage from a layer that
  // did not exist. Measured: the worst frame of a fast zoom out at 11.7% of
  // the settled ink, and no amount of widening the search changed it by a
  // single digit, because the search was never reached.
  const live = L && L.live;
  let drew = false;
  for (const key of visibleKeys(oct)) {
    // **A stand-in stays until the tile above it is OPAQUE, not until it
    // exists.** Ali, after the composition was made stable: "Now its
    // flickering ONLY as the number on the bottom left is increasing, never
    // otherwise." That number is tiles FINISHED, so the flicker was what
    // happens at the instant one lands: the key entered `done`, so the
    // stand-in stopped being drawn on that very frame, while the tile
    // replacing it starts at alpha 0 and fades in. Full, nearly blank, then
    // back -- once per tile, as often as the counter ticks.
    if (live && live.oct === oct) {
      const at = live.done.get(key);
      if (at !== undefined
          && (live.blocking.has(key) || now - at >= layers.tileFadeMs)) {
        continue;
      }
    }
    const [ix, iy] = key.split(',').map(Number);
    const b = tileBox(oct, ix, iy);
    if (!tileOnScreen(b)) continue;
    // **The best picture of THIS GROUND that exists, nearest first** -- this
    // level's own octaves before any other level's, because a level is a
    // different map and an octave is only a different resolution of the same
    // one. Per KEY and gaps only, so it can never paint over a good tile,
    // which is what the whole-level dumps did.
    if (fillFrom(name, oct, ix, iy, b, now)) { drew = true; continue; }
    for (const alt of standInLevels(name)) {
      if (fillFrom(alt, oct, ix, iy, b, now)) { drew = true; break; }
    }
  }
  return drew;
}

/** Other levels, nearest rung first: a level four away is a worse picture. */
function standInLevels(name) {
  const area = state.areas.find((a) => a.index);
  if (!area) return [];
  const order = area.index.levels.map((l) => l.name);
  const from = order.indexOf(name);
  return order
    .filter((n) => n !== name)
    .sort((a, b) => Math.abs(order.indexOf(a) - from)
                  - Math.abs(order.indexOf(b) - from));
}

/**
 * Draw one tile's worth of ground from `name`, at the nearest octave it has.
 *
 * Exact, then coarser (one blit covers the square), then finer (four children
 * cover one parent -- which is what a zoom OUT needs, since it uncovers
 * ground whose only rendering is the octave you just came from).
 */
function fillFrom(name, oct, ix, iy, b, now) {
  const exact = rt.get(rtKey(name, oct, ix, iy));
  if (exact && exact.done && exact.canvas) {
    ctx.drawImage(exact.canvas, b.L, b.Tp, b.W, b.H);
    BLITS.ancestor++;
    exact.used = now;
    return true;
  }
  let jx = ix, jy = iy;
  for (let up = 1; up <= 4; up++) {
    // `>>` floors towards negative infinity, which is what a tile index
    // wants: -4235 at one octave is -2118 at the next, not -2117.
    jx >>= 1;
    jy >>= 1;
    const rec = rt.get(rtKey(name, oct - up, jx, jy));
    if (!rec || !rec.done || !rec.canvas) continue;
    const span = 1 << up;
    const sx2 = ((ix % span) + span) % span;
    const sy2 = ((iy % span) + span) % span;
    const sw = rec.canvas.width / span, sh = rec.canvas.height / span;
    ctx.drawImage(rec.canvas, sx2 * sw, sy2 * sh, sw, sh, b.L, b.Tp, b.W, b.H);
    BLITS.ancestor++;
    rec.used = now;
    return true;
  }
  // **And finer, up to three octaves down.** One step was not enough: a FAST
  // zoom out crosses several octaves before anything of the new one is
  // rasterised, and the only picture of that ground is the octave you came
  // from, which by then is three or four steps finer. With a single step the
  // worst frame of a fast zoom out fell to 11.7% of the settled ink -- the
  // blackout, arriving through the door marked "simplify".
  //
  // 4, then 16, then 64 blits for one square, and it stops there: past that a
  // tile is a smear, and the work stops being worth it.
  for (let down = 1; down <= 3; down++) {
    const span = 1 << down;
    let any = false;
    for (let k = 0; k < span * span; k++) {
      const cx = ix * span + (k % span), cy = iy * span + ((k / span) | 0);
      const rec = rt.get(rtKey(name, oct + down, cx, cy));
      if (!rec || !rec.done || !rec.canvas) continue;
      ctx.drawImage(rec.canvas, b.L + (k % span) * b.W / span,
                    b.Tp + ((k / span) | 0) * b.H / span,
                    b.W / span, b.H / span);
      BLITS.ancestor++;
      rec.used = now;
      any = true;
    }
    if (any) return true;
  }
  return false;
}



/**
 * Is this level's live layer actually a picture of THIS zoom?
 *
 * A live layer at a stale octave is a stand-in, not coverage: after a fast
 * zoom out it is a postage stamp in the middle of the view. It is still
 * drawn -- never fade out what has not been replaced -- but it does not count
 * as having covered the screen, so the fallback runs underneath it.
 *
 * **This is the one condition that used to be six.** "Is the wanted thing
 * ready" was asked separately by a gate, a coverage pass, an ancestor walk
 * and a range check, and they disagreed. Now there is one place to ask, and
 * it is a property of the LayerSet rather than a guess reconstructed from the
 * current scale.
 */
/**
 * One answer per level per frame.
 *
 * `levelStale` now walks the view's keys, and `drawLevel` asks it for every
 * level the fallback pass draws -- so an uncached version rebuilt the key
 * array five or six times a frame for an answer that cannot change inside
 * one. That is not free on the frame this measures: the octave-boundary dip
 * is a race between the view and the rasteriser, and work added to the
 * painter comes straight out of the rasteriser's budget.
 */
let staleCache = new Map();

function levelStale(name) {
  const hit = staleCache.get(name);
  if (hit !== undefined) return hit;
  const v = levelStaleNow(name);
  staleCache.set(name, v);
  return v;
}

function levelStaleNow(name) {
  const L = layers.levels.get(name);
  if (!L || !L.live) return true;
  if (L.live.oct !== octFor(scale)) return true;
  // **Live is no longer the same thing as covered.** With the blocking gate
  // retracted a layer goes live on its FIRST tile, so "the wanted level is
  // live" stopped meaning "the wanted level fills the screen" -- and this
  // gate is what decides whether anything is drawn underneath it. Measured on
  // a fast zoom out with the gate gone and this line unchanged: the worst
  // frame fell to 22% of the settled ink, which is most of the way back to
  // the black screen the whole rewrite was for.
  //
  // **Ask the view, not the queue.** `streaming.size > 0` was the first
  // version and it is a proxy for the wrong thing: profiled across the z9.36
  // boundary, the dip sits on twelve frames where the layer is live, nothing
  // is streaming, and its twenty-four tiles have shrunk back from the edges
  // of a screen that is still zooming out. Nothing was pending because
  // nothing had been asked for yet -- so the only honest question is whether
  // the tiles this view needs are actually in hand.
  for (const k of visibleKeys(L.live.oct)) {
    if (!L.live.done.has(k)) return true;
  }
  return false;
}

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

function labelTiles() {
  const W = cv.width / DPR, H = cv.height / DPR;
  ctx.save();
  ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (const rec of rt.values()) {
    const b = tileBox(rec.oct, rec.ix, rec.iy);
    if (b.W < 40 || !tileOnScreen(b)) {
      continue;
    }
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

/**
 * How long the hand must be still before the map commits to the finer level.
 *
 * **Longer than a slow zoom's cadence, and that is the whole point.** Ali:
 * "as i slowly zoom out, the highest fidelity layers flicker in and out." A
 * slow zoom is a string of short gestures with gaps, and at 240 ms every gap
 * was long enough to start the settle pulling the blend towards the finer
 * level -- then the next notch pushed it back. Measured over a notch every
 * 300 ms: eleven direction reversals in one zoom, each one the fine level
 * brightening and dimming again.
 *
 * A deliberate zoom runs at three or four notches a second. A stop is a stop.
 * 600 ms tells them apart, and the eased blend below means that even when it
 * is wrong, it is wrong gradually.
 */
const SETTLE_HOLD_MS = 600;

/** And how long the commit takes. Short: this is a resolve, not a transition. */


function paint() {
  return span('frame', () => paintFrame());
}

function paintFrame() {
  const frameStart = performance.now();
  // **The view is bounded here and nowhere else** (E1061): nine assignments
  // move `scale` and not one of them could own a limit without the other
  // eight drifting away from it.
  clampView();
  staleCache = new Map();
  BLITS.level = BLITS.ancestor = BLITS.leftover = BLITS.fallback = 0;
  const w = cv.width / DPR, h = cv.height / DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = T.bg;
  ctx.fillRect(0, 0, w, h);
  // Under the road, so a road map never has a border over it.
  span('world', () => drawWorld(w, h));

  const area = state.areas.find((a) => a.index);
  // **`homeHint` on this path too.** It owns a VISIBLE element, and a
  // painter that returns early leaves whatever the last frame decided on the
  // glass -- which showed the way back, captioned with its placeholder text,
  // over a map that was perfectly on screen.
  if (!area) { drawOverlay(w, h, false); homeHint(w, h); return; }
  // **One level. No blend, no settle, no second opinion.** What the zoom is
  // for is a threshold, and it is the same answer whether the hand is moving
  // or has been still for a minute.
  const want = levelFor(area);
  // Once the pre-rendered level is up, the vector level underneath it is not
  // fetched, not decoded and not rasterised.
  const need = (PRE_HOLD && preCovers(area)) ? [] : [want];

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
  const now = performance.now();
  const queue = [];
  for (const lv of need) pumpLevel(lv, now, queue);
  // **A sweep over levels that are live but not drawn was tried and backed
  // out.** With the gate retracted a `mid` layer goes live on one tile, so
  // its unrefreshed tiles sit inside a live plan -- but refreshing them from
  // here cost seven unrelated tests forty-seven seconds apiece, because the
  // sweep runs every frame over a level nothing is building and the queue it
  // fills is never drained by the same budget. Those tiles are not on the
  // glass; `pumpLevel` fixes them the moment the blend moves onto that level,
  // which is the first frame anyone could see them.
  // Any refresh belonging to a level that is no longer drawn: nothing will
  // ever step it, so release it rather than hold the pixels for ever.
  const live = new Set(need.map((l) => l.name));
  for (const rec of rt.values()) {
    // **The pink is exempt, and the defect this guards against is NOT
    // demonstrated.** This drops a refresh belonging to a level the blend
    // has left, because nothing will step it again -- and `UNREACHED_LV` is
    // never IN `need`, so by inspection every pink refresh is abandoned on
    // the frame after it starts and restarted by `pumpUnreached` on the
    // next. Measured with a theme change at `coarse`, where seventeen pink
    // tiles carry ink, **no pink tile holds a back buffer at any sample
    // over nine seconds, with or without this line** -- a pink tile fits in
    // one slice, so the second frame never arrives to abandon it. The
    // exemption is kept because it is unarguably correct (`pumpUnreached`
    // runs on every frame the pink is visible, so it cannot be orphaned the
    // way a level can) and costs one comparison, NOT because it fixed
    // anything that was measured.
    if (rec.lv === UNREACHED_LV) continue;
    if (rec.back && !live.has(rec.lv)) abandonRefresh(rec);
  }
  const pendingKeys = new Set(queue.map((r) => r.key));
  // **Fed by the real queue, not by a guess.** Every cell that pulses is
  // ground an object in the bucket is actually being fetched and drawn for;
  // when the queue is empty nothing pulses, because nothing is loading.
  for (const rec of queue) { rec.used = now; noteLoading(rec, now, w / 2, h / 2); }
  if (ripples.size > RIPPLE_MAX * 4) {
    // A whole-city zoom out can ask for thousands at once. Keep the ones
    // nearest the middle -- they are the ones a person is looking at, and
    // they are also the ones the wave reaches first.
    const keep = [...ripples.entries()]
      .sort((a, b) => a[1].t0 - b[1].t0)
      .slice(0, RIPPLE_MAX * 4);
    ripples.clear();
    for (const [k, v] of keep) ripples.set(k, v);
  }

  let drewSomething = false;
  if (!RASTER) {
    span('blit', () => {
      drewSomething = drawDirect(area, want, now);
      shownLevel = want.name;
    });
  } else
  span('blit', () => {
    // **ONE PICTURE, DRAWN THE SAME WAY EVERY FRAME.**
    //
    // Ali, after `?raster=0` made the flicker stop: *"disabling the
    // rasterizer makes the flicker go away completely ... This means that you
    // do not have the correct visibility."* Measured per FRAME rather than
    // per settled view -- which is what that sentence was about, since a
    // settled map is exactly the state in which there is nothing to see --
    // the flickering frames have one signature and it is not subtle: **the
    // number of tiles blitted collapses from one frame to the next, 66 to 6,
    // 20 to 5, 17 to 11**, with no eviction, no missing canvas and the same
    // tiles held. The engine stopped drawing most of what it had drawn a
    // frame earlier.
    //
    // The cause was a CONDITION, not the passes. `levelStale` gated the
    // stand-ins -- every other level's plan, then every finished tile of this
    // level at other octaves -- and the moment it flipped, sixty tiles of
    // content appeared or vanished together. Under the blocking gate it
    // flipped only at an octave boundary; once a layer could go live on one
    // tile it flipped whenever a tile landed or the view moved, several times
    // a second during a zoom.
    //
    // **Deleting the stand-ins was tried first and is far worse** -- `blits`
    // goes 9 to 0 at an octave change and the screen empties, because the
    // ground a zoom uncovers has no rendering at any other octave. They are
    // load-bearing. So they simply always run, underneath, and the live layer
    // covers them as its tiles arrive. There is no decision left to
    // oscillate, which is the whole of the fix.
    for (const lv of need) {
      drewSomething = span('ancestors', () => drawAncestors(lv.name, now))
        || drewSomething;
    }
    // **AND THE TWO WHOLE-LEVEL DUMPS ARE GONE.** Ali, looking at the fixed
    // composition: "nothing gets faded out. So full res stuff is still
    // visible in all zoomed out if they were visible when all zoomed in" and
    // "the really low res stuff for zoomed out tiles are still visible when
    // all zoomed in, on top of the high res tiles."
    //
    // Both were `drawLeftovers`, which painted EVERY finished tile of a level
    // at EVERY octave, coarsest first so the finest landed on top. Gated on
    // `levelStale` that was rare; unconditional -- which is what stopped the
    // flicker -- it meant a fine tile from a close-up visit was repainted
    // over the overview for the rest of the session. `drawFallback` did the
    // same across LEVELS.
    //
    // Neither is needed now that the stand-in above is per KEY and searches
    // both directions: it fills the holes and paints nothing else, so there
    // is no stale octave to see and no decision to oscillate.
    // `?raster=pre`: the pre-rendered level covers the view or it does
    // not, and when it does not the vector path runs exactly as before.
    // **THE HANDOVER, which is the one transition in this engine that had
    // no "keep the old until the new is there" rule.** Ali, 2026-10-09:
    // "going from z14 into z14.1 we go from Pre-rendered to rendered, which
    // ironically lowers the detail", and "I still see no fading whatsoever".
    // Measured, it was worse than a step: ten frames of a BLANK map.
    //
    // Below the raster's floor `preCovers` is already false, so the vectors
    // start fetching on the very frame the floor is crossed. The raster is
    // held over them until they cover the view (`levelStale`), and then
    // dissolves into them -- vectors down first, raster on top at a falling
    // alpha, which is a cross-dissolve and not an overlay.
    const holdLv = preCovers(area) ? null : preHoldable(area);
    let fadeA = 0;
    if (holdLv) {
      if (!levelStale(want.name) && !preFadeAt) preFadeAt = now;
      fadeA = preFadeAt
        ? 1 - clamp01((now - preFadeAt) / LEVEL_FADE_MS) : 1;
    } else {
      preFadeAt = 0;
    }
    if (holdLv && fadeA > 0) {
      if (fadeA < 1) {
        drewSomething = drawLevel(want.name, 1, now) || drewSomething;
      }
      const pre = drawPrerendered(area, now, fadeA, holdLv);
      PRE_DREW = pre === 'drew';
      // **Never hold the vectors back during a hold**: they are the thing
      // being waited for, and `PRE_HOLD` is what stops them loading.
      PRE_HOLD = false;
      drewSomething = drewSomething || PRE_DREW;
      if (fadeA < 1) draw();          // a dissolve needs the next frame
      shownLevel = fadeA < 1 ? `${want.name} (handing over)`
                             : `${want.name} (pre-rendered, held)`;
    } else {
      const pre = drawPrerendered(area, now);
      PRE_DREW = pre === 'drew';
      PRE_HOLD = pre === 'drew' || pre === 'wait';
      if (PRE_DREW) {
        // The raster is its own picture; a level dissolve under it would be
        // invisible and would hold tiles for nothing.
        fadeFrom = null;
        levelFadeAt = 0;
        drewSomething = true;
        shownLevel = `${want.name} (pre-rendered)`;
      } else {
        // **The dissolve starts when the new level COVERS the view**, not
        // when the zoom crosses: starting earlier dissolves into holes, and
        // `levelStale` is the engine's own answer to "is every visible key
        // in hand".
        // **The dissolve is on a CLOCK and never on a condition**, which
        // is what the first version got wrong. Holding the old level until
        // the new one COVERED stalled the start of the session: the level
        // changes once while the view is still framing itself, the old
        // level has no tiles at all, and holding it drew nothing -- five
        // tests timed out in `drawn()` waiting for a first tile. A
        // transition that can wait for ever is a transition that can stop
        // the map.
        if (fadeFrom === null) fadeFrom = want.name;
        let a = 0;
        if (fadeFrom !== want.name) {
          if (!levelFadeAt) levelFadeAt = now;
          a = 1 - clamp01((now - levelFadeAt) / LEVEL_FADE_MS);
          if (a <= 0) {
            fadeFrom = want.name;
            levelFadeAt = 0;
            a = 0;
          }
        }
        // And only dissolve FROM something that exists. At the first frame,
        // and any time the level being left has no live tiles, there is
        // nothing to cross-dissolve with and the new level simply draws.
        const from = a > 0 ? layers.levels.get(fadeFrom) : null;
        const cross = !!(from && from.live && from.live.done.size);
        // **A TRUE cross-dissolve: the new comes UP as the old goes down.**
        // Drawing the new at full under an old that merely fades out is an
        // overlay, and two pictures at full strength ADD -- measured at
        // +82% through the fade and a 23% drop in one frame when the
        // underlay went. Summing to one keeps the ink roughly level; on
        // antialiased hairlines the arithmetic dip is about 8%.
        drewSomething = drawLevel(want.name, cross ? 1 - a : 1, now)
          || drewSomething;
        if (cross) {
          drewSomething = drawLevel(fadeFrom, a, now) || drewSomething;
          draw();
        }
        shownLevel = cross ? `${fadeFrom} to ${want.name}` : want.name;
      }
    }
  });
  if (DEBUG_TILES) labelTiles();
  // On the ground, so it turns with the map -- these are squares of Riyadh,
  // not marks on the glass.
  if (span('ripple', () => drawRipples(now, pendingKeys))) draw();

  mapOut();

  // A level change is a reason to re-read the readout: the zoom has not moved
  // but the answer to "which level am I on" has.
  if (shownLevel !== lastShown) { lastShown = shownLevel; showWhere(); }

  // Rasterise a slice of what is outstanding, after drawing, so the work
  // lands in the gap at the end of the frame rather than in front of it.
  //
  // **The queue is already in priority order**: blocking tiles come before
  // streamed ones, because a layer cannot appear until all of the first are
  // in. Within that, nearest the middle of the screen, since the tile under
  // somebody's eye is worth more than the one at the corner.
  const cx0 = w / 2, cy0 = h / 2;
  const dist = (r) => {
    const b2 = tileBox(r.oct, r.ix, r.iy);
    return Math.hypot(b2.L + b2.W / 2 - cx0, b2.Tp + b2.H / 2 - cy0);
  };
  queue.sort((p1, p2) => dist(p1) - dist(p2));
  // After the sort and after `noteLoading`, on purpose -- see `pumpUnreached`.
  if (RASTER && state.unreached.length) pumpUnreached(now, queue);
  // **The ripple is fed by the real queue, not by a guess.** Every cell that
  // pulses is ground an object in the bucket is actually being fetched and
  // drawn for; when the queue is empty nothing pulses, because nothing is
  // loading.

  evictTiles();
  const budget = gesturing ? SLICE_GESTURE_MS : SLICE_MS;
  if (queue.length && performance.now() - frameStart < OVERRUN_MS) {
    const rec = queue[0];
    if (span('raster:tile', () => stepTile(rec, budget))) {
      noteLoaded(rec, performance.now());
      toastRaster(`${rec.lv} · tile · ${rasterStats.lastMs} ms · `
        + `${rec.paths.toLocaleString()} paths · `
        + `${(sceneBytes() / 1e6).toFixed(0)} MB canvas`);
    }
  }
  if (queue.length || !drewSomething) draw();

  drawOverlay(w, h, drewSomething);
  homeHint(w, h);
}

/**
 * The way back, when the view has left the map.
 *
 * Ali, 2026-10-09: *"When we go outside the map bounds, we should have a
 * sticky button that moves with an arrow that points to Riyadh that says go
 * back to Riyadh. If I move it around, it will switch position fluently to
 * point to be in the closest proximity and direction of Riyadh."*
 *
 * ***THIS IS WHY `clampView` BOUNDS THE PLANET AND NOT THE MAP.*** A clamp
 * that walls the centre into the data was built first and measured well --
 * an escaped fragment landed on the map at 14.03% of the glass lit against
 * 0.19% -- and a wall and a way back are two answers to one defect. The way
 * back is the one that lets somebody look at where the map ISN'T on purpose,
 * which a driver at the edge of the corpus has every reason to do.
 *
 * ***IT SHOWS FOR TWO REASONS AND ALI NAMED THE SECOND***: *"also show it if
 * we zoom out far too much 'back to riyadh' and on country level 'back to
 * Saudi Arabia'."* So it appears when **no area is on the glass at all**, and
 * also when the map IS on the glass and is **less than a quarter of it
 * across** -- a speck you cannot aim at is as unusable as one off the edge.
 * A district half off the edge needs no button, and neither does a loading
 * one.
 *
 * ***AND THE NAME IS THE VIEWER'S OWN SCALE, NOT ALWAYS THE DISTRICT'S.***
 * Two tiers and **neither is configured**: the nearest area's own title,
 * which is what the district chooser calls it, and **the COUNTRY the map is
 * in, once the country fits on the screen**. The country comes from
 * `world.json` -- the same public-domain outline the border layer draws, so
 * the name and its real size are read off the geometry rather than typed
 * into a flavour, and it works for a map anywhere in the world rather than
 * for Riyadh.
 *
 * *A first version put `places` in the flavour metadata and it was the wrong
 * home twice over: `d/flavors.json` is VERSIONED DATA, which a push
 * deliberately does not publish (E1055), so the label could not ship with
 * the page that needed it -- and it would have had to be typed again for
 * every city.*
 *
 * **Where it sits depends on which reason it is.** Off the glass, it goes on
 * the edge where the ray crosses. ON the glass, the ray has nowhere to send
 * it, so it sits at the bottom middle like any other action and the arrow
 * still points at the speck.
 *
 * It is placed every frame, so it slides along the edge under a pan, and only
 * its `transform` changes -- CSS transitions that, so the movement is
 * continuous rather than a jump per frame. The target is the NEAREST area,
 * because "the closest proximity and direction" is a question with more than
 * one answer once the corpus has two districts.
 */
let homeTarget = null;

/**
 * Which country the map is in, and how big it is, from `world.json`.
 *
 * **Read off the border geometry rather than configured**, so a map of
 * anywhere gets its own country's name with nothing typed in. Cached on the
 * country's identity, because the answer only changes if the data moves --
 * and recomputed once `world.json` arrives, which is exactly when a view is
 * wide enough for the answer to be wanted.
 */
let homeCountryCache = null;

function homeCountry() {
  if (homeCountryCache !== null) return homeCountryCache || null;
  if (!WORLD) return null;
  const b = dataBox();
  if (!b) return null;
  const x = (b[0] + b[2]) / 2, y = (b[1] + b[3]) / 2;
  for (const c of WORLD.countries) {
    let inside = false;
    for (const f of c.r) {
      // Ray casting, even-odd, over every ring of the country at once. An
      // enclave would confuse it and a name is not worth a topology.
      for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) {
        const xi = f[i], yi = f[i + 1], xj = f[j], yj = f[j + 1];
        if ((yi > y) !== (yj > y)
            && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      }
    }
    if (!inside) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [a, b2, a1, b3] of c.b) {
      x0 = Math.min(x0, a); y0 = Math.min(y0, b2);
      x1 = Math.max(x1, a1); y1 = Math.max(y1, b3);
    }
    homeCountryCache = {
      name: c.n,
      spanKm: Math.max((x1 - x0) * KX, y1 - y0) * 111.132,
    };
    return homeCountryCache;
  }
  homeCountryCache = false;        // asked and answered: the open sea
  return null;
}

function homeHint(w, h) {
  const el = $('home');
  if (!el) return;
  const areas = (state.areas || []).filter((a) => a.bounds);
  // Not before the view has been framed: until `fit` or `applyHash` has run,
  // "the map is not on screen" is true of a view nobody chose.
  if (!areas.length || !loaded || !hashApplied) {
    el.hidden = true;
    homeTarget = null;
    return;
  }
  // Is any of it on the glass? The screen's own ground is the rotation-aware
  // box (viewBox), in world degrees -- the same question `tileBox` consumers
  // ask, and a screen rectangle would miss the four corner triangles.
  const vb = viewBox();
  const [lon0, lat0] = [(vb.x0 - ox) / (KX * scale), (oy - vb.y1) / scale];
  const [lon1, lat1] = [(vb.x1 - ox) / (KX * scale), (oy - vb.y0) / scale];
  let near = null, best = Infinity, onGlass = false;
  for (const a of areas) {
    const b = a.bounds;
    if (b[0] <= lon1 && b[2] >= lon0 && b[1] <= lat1 && b[3] >= lat0) {
      onGlass = true;
    }
    // Nearest by its own centre, in metres, so a long district is not
    // preferred over a near one by an accident of shape.
    const clon = (b[0] + b[2]) / 2, clat = (b[1] + b[3]) / 2;
    const d = Math.hypot((clon - (lon0 + lon1) / 2) * KX,
                         clat - (lat0 + lat1) / 2);
    if (d < best) { best = d; near = a; }
  }
  if (!near) { el.hidden = true; homeTarget = null; return; }
  // **Too far out counts as gone.** The whole of the data, across the glass:
  // under a quarter of the screen's shorter side there is nothing to aim at.
  const all = dataBox();
  const mapPx = all
    ? Math.max((all[2] - all[0]) * KX * scale, (all[3] - all[1]) * scale)
    : 0;
  const tiny = mapPx < Math.min(w, h) / 4;
  if (onGlass && !tiny) { el.hidden = true; homeTarget = null; return; }
  homeTarget = near;
  const name = $('homename');
  // Ali's own words for it: *"a button ... that says go back to Riyadh"*,
  // and *"on country level 'back to Saudi Arabia'"*. The country when the
  // country fits the glass, else the area's own title.
  const viewKm = Math.max(w, h) * mpp() / 1000;
  const country = homeCountry();
  const label = (country && country.spanKm <= viewKm)
    ? country.name : (near.title || 'the map');
  if (name) name.textContent = `Back to ${label}`;
  // **Shown before it is measured**, because a hidden element has no box and
  // the inset is taken from its own width; and the first placement is made
  // with the transition off, or it slides in from the top-left corner.
  const appearing = el.hidden;
  el.hidden = false;
  if (appearing) el.style.transition = 'none';
  // Where the ray from the middle of the screen to the map crosses the edge,
  // inset by the button's own half-size so it never hangs off the glass.
  const b = near.bounds;
  const [tx, ty] = rot(sx((b[0] + b[2]) / 2), sy((b[1] + b[3]) / 2));
  const cx = w / 2, cy = h / 2;
  let dx = tx - cx, dy = ty - cy;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  const r = el.getBoundingClientRect();
  const padX = Math.max(24, r.width / 2) + 10;
  const padY = Math.max(24, r.height / 2) + 10;
  if (onGlass) {
    // The map is on the glass and too small to aim at, so the ray has
    // nowhere to send the button: it sits where an action sits, and the
    // arrow is what says which speck.
    //
    // **Above whatever is already down there, measured rather than
    // assumed.** The first version sat at the bottom edge and landed on top
    // of the "tap the map" hint and the scale bar; these move with the
    // layout and the drawer, so the floor is read off them.
    let floor = h - padY;
    // The scale bar is drawn on the CANVAS, bottom left -- there is no
    // element to measure, and lifting clear of the hint clears it too.
    for (const id of ['hint', 'nav']) {
      const other = $(id);
      if (!other || other.hidden) continue;
      const ob = other.getBoundingClientRect();
      if (ob.height > 0 && getComputedStyle(other).display !== 'none') {
        floor = Math.min(floor, ob.top - padY);
      }
    }
    el.style.transform = `translate(${Math.round(cx)}px, `
      + `${Math.round(Math.max(padY, floor))}px) translate(-50%, -50%)`;
    const gg = $('homearrow');
    if (gg) {
      gg.style.transform =
        `rotate(${(Math.atan2(dy, dx) * 180 / Math.PI + 90).toFixed(1)}deg)`;
    }
    if (appearing) { void el.offsetWidth; el.style.transition = ''; }
    return;
  }
  // The largest step along the ray that stays inside the inset rectangle --
  // and `Infinity` where the ray is parallel to that pair of edges, which is
  // what makes a straight-up or straight-left direction land on a corner-free
  // point rather than at zero.
  const tX = Math.abs(dx) > 1e-6 ? (cx - padX) / Math.abs(dx) : Infinity;
  const tY = Math.abs(dy) > 1e-6 ? (cy - padY) / Math.abs(dy) : Infinity;
  const t = Math.max(0, Math.min(tX, tY, len));
  const px = Math.round(cx + dx * t), py = Math.round(cy + dy * t);
  el.style.transform = `translate(${px}px, ${py}px) translate(-50%, -50%)`;
  // The arrow's own rotation, in screen space, so it accounts for the
  // heading: the svg points NORTH at rest, which is -90 degrees from atan2.
  const g = $('homearrow');
  if (g) {
    g.style.transform =
      `rotate(${(Math.atan2(dy, dx) * 180 / Math.PI + 90).toFixed(1)}deg)`;
  }
  if (appearing) { void el.offsetWidth; el.style.transition = ''; }
}

/**
 * The national outline, at country scale.
 *
 * Ali, 2026-10-09: *"Can we add nation borders?"* -- asked in the same turn
 * as the way back from an escaped view, and the two answer one thing: once
 * the view may leave the map on purpose, a screen with no road on it should
 * still say where you are.
 *
 * ***THIS IS THE FIRST IMPORTED GEOMETRY IN THE APP AND THE PROVENANCE IS
 * THE POINT.*** A border is a legal fact and not a visible one -- most of
 * Saudi Arabia's run through unmarked desert -- so it cannot be detected and
 * has to come from somewhere. It comes from **Natural Earth 1:110m, which is
 * PUBLIC DOMAIN**, so no licence decision arises and in particular ***IT IS
 * NOT OSM***, which `CLAUDE.md` forbids at every stage. It is CHROME: it
 * enters no graph, no tile, no training target and no figure, and it is drawn
 * faintly and under the road so it cannot be mistaken for road we found.
 * `services/maps/borders.py` makes `world.json` and records the source,
 * the url and its sha256 in the file itself.
 *
 * **Fetched only when one could be on screen.** Riyadh is about four hundred
 * kilometres from the nearest border, so under `WORLD_SPAN_M` there is
 * nothing to draw and the 151 kB would be bytes for nothing: an ordinary
 * session never asks for it.
 */
let WORLD = null;
let worldAsked = false;
const WORLD_SPAN_M = 50000;

function drawWorld(w, h) {
  if (Math.max(w, h) * mpp() < WORLD_SPAN_M) return;
  if (!WORLD) {
    if (!worldAsked) {
      worldAsked = true;
      fetch(`${ROOT}world.json`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d) return;
          // One bbox per ring, once, so a frame culls instead of stroking
          // ten thousand points of the Pacific.
          for (const c of d.countries) {
            c.b = c.r.map((f) => {
              let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
              for (let i = 0; i < f.length; i += 2) {
                if (f[i] < x0) x0 = f[i];
                if (f[i] > x1) x1 = f[i];
                if (f[i + 1] < y0) y0 = f[i + 1];
                if (f[i + 1] > y1) y1 = f[i + 1];
              }
              return [x0, y0, x1, y1];
            });
          }
          WORLD = d;
          homeCountryCache = null;     // answerable now
          draw();
        })
        .catch(() => { /* chrome: a map without it is still a map */ });
    }
    return;
  }
  const vb = viewBox();
  const lo0 = (vb.x0 - ox) / (KX * scale), lo1 = (vb.x1 - ox) / (KX * scale);
  const la0 = (oy - vb.y1) / scale, la1 = (oy - vb.y0) / scale;
  mapIn();
  ctx.strokeStyle = T.border;
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  const path = new Path2D();
  const labels = [];
  for (const c of WORLD.countries) {
    let widest = 0;
    for (let k = 0; k < c.r.length; k++) {
      const [x0, y0, x1, y1] = c.b[k];
      if (x0 > lo1 || x1 < lo0 || y0 > la1 || y1 < la0) continue;
      widest = Math.max(widest, (x1 - x0) * KX * scale);
      const f = c.r[k];
      path.moveTo(sx(f[0]), sy(f[1]));
      for (let i = 2; i < f.length; i += 2) path.lineTo(sx(f[i]), sy(f[i + 1]));
      path.closePath();
    }
    // **A name only where the country has room for one.** The threshold is
    // the label's own scale and not a zoom: a country 90 screen pixels wide
    // can carry its name and one 9 px wide cannot, at any zoom.
    if (widest > 90) labels.push([c.n, sx(c.c[0]), sy(c.c[1])]);
  }
  // One path, stroked once -- self-overlap then costs the ink of one line
  // rather than compounding, which is why the roads are drawn this way too.
  ctx.stroke(path);
  mapOut();
  // The names are marks on the GLASS and stay upright whatever the heading.
  if (labels.length) {
    ctx.fillStyle = T.borderInk;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [name, x, y] of labels) {
      const [px, py] = rot(x, y);
      if (px < 0 || py < 0 || px > w || py > h) continue;
      ctx.fillText(name.toUpperCase(), px, py);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }
}

/** The route, the pins and the scale bar: tens of paths, redrawn every frame. */
function drawOverlay(w, h, drew) {
  const m = mpp();
  mapIn();
  // Road we can draw and cannot route on, in UNREACHED pink. A map that
  // quietly hides it is lying to the driver -- and it is RASTERISED like the
  // road, because as strokes it was six hundred times the rest of the frame
  // at the city view. See `UNREACHED_LV`.
  if (state.unreached.length) {
    span('pink', () => {
      if (RASTER) drawUnreachedTiles(performance.now());
      else drawUnreachedDirect(m);
    });
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
  if (drawScale(w, h)) draw();
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
  // ***THE SHEET, AND ALI PICKED IT OFF A PICTURE*** (2026-10-09, on
  // E1024's Riyadh sheet: *"I really like the color scheme here. Lets
  // use that for dark mode."*). These are `sheet_style.py`'s own
  // numbers, which is why the chrome already matched: BG (13,15,19),
  // its road ink (238,242,248), the done-frame slate (28,34,45) and
  // WARN (255,209,102) for the route.
  //
  // What it changes is the ROAD: a green kerb became a near-white one,
  // so the map is one bright thing on a near-black ground and the only
  // colour on it is the route. The one-way marking survives as a COOL
  // near-white rather than a cyan -- the information is kept and the
  // monochrome is not broken by it.
  dark: {
    bg: '#0d0f13',
    carriageway: '#1c222d',
    kerbTwoWay: '#eef2f8',
    kerbOneWay: '#b9cfe4',
    route: '#ffd166',
    // A pin somebody else put here, from `?marker=`. The stylesheet's own
    // `--warn`, so the bubble's border and the pin are one colour, and not
    // the route's amber -- a marker is not a destination until somebody
    // taps it.
    marker: '#f0913a',
    routeEdge: '#fff0c2',
    routeDim: '#6b5a2e',
    unreached: '#d67a8a',
    highlight: '#ffffff',
    blip: '#8fe9ff',
    scale: 'rgba(233,237,243,.75)',
    scaleLine: 'rgba(233,237,243,.55)',
    // E1061: the national outline, drawn UNDER the road at country scale.
    // Faint on purpose -- it is there to say where you are when there is no
    // road on screen, and must not read as geometry we detected.
    border: 'rgba(238,242,248,.26)',
    borderInk: 'rgba(238,242,248,.42)',
    sky0: '#05070c',
    sky1: '#131d29',
    // **`ground` IS THE RASTER'S BACKGROUND AND `bg` IS THE CANVAS
    // CLEAR, SO THEY MUST AGREE.** `rasterlevel.py` fills a pre-rendered
    // tile with `ground` and `paintFrame` clears to `bg`; they were
    // #0a0d11 and #0b0d11, near enough that nobody saw the seam and
    // close enough that one would eventually show.
    ground: '#0d0f13',
    horizon: 'rgba(238,242,248,.20)',
    star: '#ffffff',
    starBright: '#cfe6ff',
    stars: true,
  },
  // ***AND LIGHT IS THE PRINTED POSTER*** (Ali, same turn: *"for light
  // mode, lets go with those nostalgic map posters that people
  // make"*). Cream paper, one deep ink, one accent -- the WPA / vintage
  // chart palette, which is what that genre is: the roads are drawn in
  // ink on paper and the ground is the paper.
  //
  // ***THE INK IS TEAL AND NOT SEPIA, AND THAT IS A LICENCE DECISION AS
  // WELL AS A LOOK.*** `publish.py` proves a raster is ours by CONTENT:
  // every pixel lies on the line between the theme's ground and its
  // kerb, and a photograph does not. Desert imagery is a warm wedge
  // (R > G > B), so a cream-to-sepia line runs straight down it and a
  // satellite tile sits ON it -- measured, a sand pixel is 24.8 off a
  // sepia line against the tolerance of 24. A cool ink crosses the
  // neutral axis and leaves that wedge at once. The nostalgic palette
  // that is ALSO provable is the one with teal in it.
  light: {
    bg: '#f2e8d5',
    carriageway: '#fbf5e8',
    kerbTwoWay: '#1d4e50',
    // **AND THE ONE-WAY INK IS SLATE AND NOT THE OLIVE THIS FIRST
    // SHIPPED**, for the same reason and measured the same way: a
    // cream-to-olive line runs through khaki, which is desert, and it
    // took the guard from one Esri tile in thirty to THREE. Slate and
    // teal both read as the same printed era and both leak nothing the
    // committed palette did not.
    kerbOneWay: '#4a5f80',
    route: '#c05c38',
    marker: '#a7651a',
    routeEdge: '#7d3418',
    routeDim: '#e0bda6',
    unreached: '#8a4a63',
    highlight: '#16211f',
    blip: '#2e7d7f',
    scale: 'rgba(23,43,45,.82)',
    scaleLine: 'rgba(23,43,45,.5)',
    border: 'rgba(29,78,80,.30)',
    borderInk: 'rgba(29,78,80,.55)',
    sky0: '#9db9bd',
    sky1: '#f2e8d5',
    ground: '#f2e8d5',
    horizon: 'rgba(29,78,80,.40)',
    star: '#ffffff',
    starBright: '#ffffff',
    // No stars in daylight. Drawing them and hoping nobody looks is the sort
    // of detail that makes the rest look careless.
    stars: false,
  },
};

/**
 * The theme follows the device, and there is no control for it.
 *
 * Ali, 2026-10-10, listing the chrome to remove: *"Ali Maps / The whole city
 * / Fit / Auto / Locate ... They are not needed."* "Auto" was the theme
 * button in the state nearly everybody was in, and a three-way cycle in the
 * corner of a map is a control that explains itself by being pressed.
 *
 * **And the stored choice goes with the button.** A preference nothing can
 * reach any more would pin somebody to light for good, so the key is read by
 * nothing and removed on sight -- a setting with no way back to it is worse
 * than no setting.
 */
const themeChoice = 'system';
try { localStorage.removeItem('alimap.theme'); } catch (e) { /* fine */ }

/** What is actually on screen, which is what the phone says. */
let themeName = (() => {
  try {
    return matchMedia('(prefers-color-scheme: light)').matches
      ? 'light' : 'dark';
  } catch (e) {
    return 'dark';
  }
})();
let T = THEMES[themeName];

function applyTheme(name) {
  themeName = THEMES[name] ? name : 'dark';
  T = THEMES[themeName];
  document.body.classList.toggle('light', themeName === 'light');
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
/**
 * `?draw=casing` or `?draw=fill` renders one pass only.
 *
 * Ali: "If you want, we can add a debug mode so we can see what is
 * happening." This is the one that settles the question a screenshot cannot:
 * roads are drawn as all casings, then all fills, so where two overlap the
 * second road's fill covers the first road's casing. That is what makes a
 * junction look continuous -- and over a dense bundle of parallel
 * carriageways it is what turns the bundle into a white slab. Seeing the
 * casing pass alone says immediately whether the outlines were drawn and
 * erased, or never drawn at all.
 */
const ONLY_PASS = { casing: 0, fill: 1 }[Q.get('draw')];

/** When set, every batched stroke is recorded. Debug only. */
let BATCH_SPY = null;

/**
 * The carriageway is at full strength once it is this many SCREEN pixels
 * wide, and proportionally transparent below that.
 *
 * Two pixels, because that is about where a white core stops reading as a
 * road surface and starts reading as a road being rubbed out.
 */
const FILL_FULL_PX = 2.0;

function drawChunk(c, lines, m, pass, SX, SY, w, h, mx, my, from, deadline) {
  if (ONLY_PASS !== undefined && pass !== ONLY_PASS) {
    return { index: lines.length, drawn: 0 };
  }
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
    if (BATCH_SPY) BATCH_SPY.push([pass, style, +width.toFixed(2)]);
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

  for (const bt of batches.values()) {
    // **The carriageway fades in as it becomes wide enough to be one.**
    // Ali's map at z 15.48 was a field of white slivers with no outline: the
    // casings were all drawn -- the casing pass alone is a complete, healthy
    // map -- and then a one-pixel white core was painted down the middle of
    // a two-pixel green road, leaving half a pixel of green on each side,
    // which antialiases to nothing.
    //
    // Removing the old five-pixel flip was right (Ali: "there is no
    // transition or fade for it") and it left this: between about two and
    // five screen pixels a road is too narrow to BE hollow, and drawing it
    // hollow anyway erases it. So the fill carries an alpha that rises with
    // its own width, and the transition stays continuous -- a narrow road is
    // a line, a wide one is a carriageway, and nothing flips.
    c.globalAlpha = bt.style === T.carriageway
      ? Math.min(1, (bt.width / PXS) / FILL_FULL_PX)
      : 1;
    c.strokeStyle = bt.style;
    c.lineWidth = bt.width;
    c.stroke(bt.path);
  }
  c.globalAlpha = 1;
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
  // **Thirteen, not sixteen, so it lines up under the button above it.** The
  // toolbar sits 12 px from the edge and its buttons are 34 px wide, so the
  // last one's centre is `w - 29` -- and the crosshair is that button now
  // (Ali: "Place it above the compass"). A control stack that is three
  // pixels out of true reads as a mistake at any size.
  const x = w - COMPASS_R - 13;
  let y = COMPASS_R + 16;
  // **Everything that can take the top right corner, asked in turn.** The
  // toolbar wraps to two rows when the provenance badge is long, and the 3d
  // window opens at `right: 12px; top: 58px` -- which is the compass, exactly.
  // Two passes, because clearing the toolbar can move the compass into the
  // 3d window and clearing the 3d window can move it back under the toolbar.
  // **And the open MENU is NOT one of them, which was tried the other way
  // first.** The panel drops from the hamburger at the right edge and lands
  // exactly on the compass, so dodging it is arithmetically correct and
  // measured badly: on the live map's three-row list the compass went from
  // y 72 to y 332 and back, the crosshair with it, and a corner that jumps
  // 260 px because a menu opened is the kind of movement an eye follows
  // instead of the thing being chosen. A dropdown covering what is under it
  // is what every menu does. The 3d window still moves it, because that one
  // STAYS.
  for (let pass = 0; pass < 2; pass++) {
    for (const id of ['top', 'nav3dwrap']) {
      const el = $(id);
      if (!el || el.hidden) continue;
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

/**
 * A compass that looks like an object, with no 3d engine anywhere near it.
 *
 * Ali: *"Can you make a compass look like a 3D compass without having an
 * actual 3D engine?"* Yes, and the trick is to fake the LIGHT and never the
 * GEOMETRY. A projected tilt would be the obvious way and it is the one thing
 * this control may not do: the compass is reporting a number, and a dial
 * tilted into perspective maps screen angle to bearing non-linearly, so the
 * needle would stop pointing where it says. Everything here is drawn in plan,
 * exactly as before, and the depth is entirely shading:
 *
 *   * a BEVEL on the rim, lit from the top left, so the ring stands proud;
 *   * the face DISHED under it, with the rim's shadow falling across the top
 *     left of the floor and its reflected light on the bottom right;
 *   * the needle as a PRISM -- each half split along its spine into two
 *     facets, shaded by the dot product of each facet's own normal with a
 *     fixed light, so the bright side SWAPS as the needle turns, which is the
 *     cue that says metal rather than paint;
 *   * a pivot cap with its own highlight, and a drop shadow under both.
 *
 * The light is fixed in SCREEN space, not in the map's, because a light that
 * turned with the map would read as the whole instrument rolling.
 */
const LIGHT = [-0.55, -0.84];             // towards the light, screen space

// **The south half is dimmer than the north on purpose.** Lit, a bright
// silver tail reads as the pointer at the headings where it catches the
// light, and which end is north is the one thing this control exists to say.
const NEEDLE = {
  dark: { n: [239, 75, 82], s: [138, 150, 168] },
  light: { n: [168, 64, 42], s: [58, 74, 72] },
};

/** `rgb()` for a colour scaled by `k` and clamped. */
function lit(c, k) {
  const v = (i) => Math.max(0, Math.min(255, Math.round(c[i] * k)));
  return `rgb(${v(0)},${v(1)},${v(2)})`;
}

/**
 * The bezel is the same picture every frame, so it is drawn once.
 *
 * Nine paths and three gradients a frame is not free at the city view, where
 * the whole rest of the frame is a fifth of a millisecond (E1048), and none
 * of it changes unless the theme or the device pixel ratio does. Cached on
 * exactly those two.
 */
const BEZEL_PAD = 5;
let bezel = null;

function compassBezel() {
  const key = `${themeName}:${DPR}`;
  if (bezel && bezel.key === key) return bezel;
  const light = themeName === 'light';
  const size = (COMPASS_R + BEZEL_PAD) * 2;
  const c = document.createElement('canvas');
  c.width = Math.ceil(size * DPR);
  c.height = Math.ceil(size * DPR);
  const g = c.getContext('2d');
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  g.translate(size / 2, size / 2);
  const TAU = Math.PI * 2;

  // The shadow the whole disc casts on the map, which is what lifts it off
  // the page at all. Drawn as a filled circle whose own shadow is the point.
  g.save();
  g.shadowColor = light ? 'rgba(40,30,15,.30)' : 'rgba(0,0,0,.60)';
  // Shadow blur and offsets are NOT transformed by the CTM, so they are
  // DEVICE pixels and have to be scaled by hand.
  g.shadowBlur = 5 * DPR;
  g.shadowOffsetY = 1.8 * DPR;
  g.beginPath();
  g.arc(0, 0, COMPASS_R - 0.5, 0, TAU);
  g.fillStyle = light ? '#d9cdb4' : '#242a33';
  g.fill();
  g.restore();

  // The rim, as a bevel: a linear ramp across the disc from the light to the
  // shade, which is what a torus under one light does.
  const rim = g.createLinearGradient(-COMPASS_R, -COMPASS_R,
                                     COMPASS_R, COMPASS_R);
  if (light) {
    rim.addColorStop(0, '#fffdf6');
    rim.addColorStop(0.45, '#e9ddc3');
    rim.addColorStop(1, '#b0a07c');
  } else {
    rim.addColorStop(0, '#59616f');
    rim.addColorStop(0.45, '#2b313b');
    rim.addColorStop(1, '#0c0f14');
  }
  g.beginPath();
  g.arc(0, 0, COMPASS_R, 0, TAU);
  g.fillStyle = rim;
  g.fill();

  // The face, dished: a vignette with its highlight off centre towards the
  // light, so the floor reads as sunk rather than as a flat sticker.
  const face = g.createRadialGradient(-2.2, -3.0, 0.5, 0, 1.5, COMPASS_R - 1);
  if (light) {
    face.addColorStop(0, '#fcf7ea');
    face.addColorStop(0.65, '#f2e8d5');
    face.addColorStop(1, '#ded0b2');
  } else {
    face.addColorStop(0, '#1b2029');
    face.addColorStop(0.65, '#121620');
    face.addColorStop(1, '#070a0e');
  }
  g.beginPath();
  g.arc(0, 0, COMPASS_R - 2.6, 0, TAU);
  g.fillStyle = face;
  g.fill();

  // **The inner wall, which is where the depth actually reads.** With the
  // light up and to the left, the wall ON that side faces away from it and is
  // in shadow, and the wall opposite catches the bounce -- the opposite way
  // round from the rim's own outer slope, which is exactly why a bevel looks
  // like a bevel.
  //
  // ***STROKED AS A WHOLE CIRCLE THROUGH A GRADIENT, NEVER AS AN ARC.*** An
  // arc from one angle to another ends where it ends, and at this size a hard
  // end reads as a second ring drawn on the dial rather than as light falling
  // on a wall. A full circle stroked with a ramp that passes through
  // transparent at the middle fades out on its own, which is what the light
  // does.
  const axis = (a, b) => {
    const gr = g.createLinearGradient(-COMPASS_R, -COMPASS_R,
                                      COMPASS_R, COMPASS_R);
    gr.addColorStop(0, a);
    gr.addColorStop(0.5, 'rgba(0,0,0,0)');
    gr.addColorStop(1, b);
    return gr;
  };
  g.lineWidth = 1.6;
  g.beginPath();
  g.arc(0, 0, COMPASS_R - 3.0, 0, TAU);
  g.strokeStyle = axis(light ? 'rgba(86,66,34,.34)' : 'rgba(0,0,0,.75)',
                       light ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.13)');
  g.stroke();

  // And the specular along the top left of the rim itself, the same way.
  g.lineWidth = 1.2;
  g.beginPath();
  g.arc(0, 0, COMPASS_R - 0.6, 0, TAU);
  g.strokeStyle = axis(light ? 'rgba(255,255,255,.98)' : 'rgba(255,255,255,.34)',
                       light ? 'rgba(120,100,66,.30)' : 'rgba(0,0,0,.45)');
  g.stroke();

  bezel = { c, key, size };
  return bezel;
}

function drawCompass(w, h) {
  const [cx, cy] = compassAt(w, h);
  const north = -heading;                 // where north has ended up on screen
  const b = compassBezel();
  ctx.drawImage(b.c, cx - b.size / 2, cy - b.size / 2, b.size, b.size);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(north);
  // **Short and narrow, so the N stays readable.** Ali: "compass pin is a bit
  // too big (occludes the N)." The needle stops well inside the ring and the
  // letter sits in the gap between its tip and the rim.
  //
  // Two halves of one needle, because a single arrow reads as "go this way"
  // rather than "this is where north is". North is RED, which is the one
  // convention every compass ever made agrees on -- and it is a fixed red on
  // both themes rather than a palette colour, because a compass that changes
  // which end is north with the light would be worse than no compass.
  const tip = COMPASS_R - 9.5;
  const wide = 3.4;                       // half the needle at its waist
  const col = NEEDLE[themeName] || NEEDLE.dark;

  // The shadow both halves cast on the face, offset down and to the right of
  // the light. One blurred pass under the whole needle, not two.
  ctx.save();
  ctx.shadowColor = themeName === 'light'
    ? 'rgba(60,45,20,.38)' : 'rgba(0,0,0,.65)';
  ctx.shadowBlur = 2.6 * DPR;
  ctx.shadowOffsetX = 0.9 * DPR;
  ctx.shadowOffsetY = 1.3 * DPR;
  ctx.beginPath();
  ctx.moveTo(0, -tip);
  ctx.lineTo(wide, 0);
  ctx.lineTo(0, tip);
  ctx.lineTo(-wide, 0);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,.9)';
  ctx.fill();
  ctx.restore();

  // **Four facets, lit one at a time.** Each is a plane whose in-plane normal
  // is the needle's own left or right, turned with it -- so as the map turns,
  // the lit side crosses over and the needle reads as a solid thing rotating
  // rather than a picture of one.
  const cs = Math.cos(north), sn = Math.sin(north);
  const facet = (sign) => {
    // The outward normal of this side, in screen space.
    const nx = sign * cs, ny = sign * sn;
    const d = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1]);
    return 0.62 + 0.78 * d;               // ambient, then the lit term
  };
  const half = (dir, c) => {
    for (const sign of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(0, -dir * tip);
      ctx.lineTo(sign * wide, 0);
      // **The facets of a half meet AT THE PIVOT**, so the two halves tile
      // the whole needle: a ridge short of the waist leaves two notches
      // either side of the centre that nothing covers.
      ctx.lineTo(0, 0);
      ctx.closePath();
      ctx.fillStyle = lit(c, facet(sign));
      ctx.fill();
    }
  };
  half(1, col.n);                         // north, towards -y before the turn
  half(-1, col.s);

  // The pivot the needle turns on, which is the one place a hard highlight
  // can sit without competing with the N.
  ctx.restore();
  ctx.save();
  ctx.translate(cx, cy);
  const cap = ctx.createRadialGradient(-0.5, -0.7, 0.1, 0, 0, 2.0);
  if (themeName === 'light') {
    cap.addColorStop(0, '#ffffff');
    cap.addColorStop(0.55, '#d8cbb0');
    cap.addColorStop(1, '#8e8168');
  } else {
    cap.addColorStop(0, '#dfe6f0');
    cap.addColorStop(0.55, '#8d97a7');
    cap.addColorStop(1, '#333a45');
  }
  ctx.beginPath();
  ctx.arc(0, 0, 1.8, 0, Math.PI * 2);
  ctx.fillStyle = cap;
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
/**
 * The scale bar, which goes when the map stops moving.
 *
 * Ali, 2026-10-10: *"Make the scale indicator auto hide."* It is a readout
 * and not a control -- nothing is ever pressed on it -- so it belongs on
 * screen while the thing it reports is changing and nowhere afterwards. The
 * same rule the zoom readout has had on a phone since it was added, and for
 * the same reason: the map is what somebody came for.
 *
 * **Fading needs frames**, and the frame loop stops when nothing has
 * changed, so this says when it still wants one -- the same contract
 * `drawBlips` has.
 */
const SCALE_HOLD_MS = 2200;
const SCALE_FADE_MS = 420;

/** When the view last moved. `showWhere` is the one thing that knows. */
let scaleAt = -1e9;
let scaleTimer = 0;

/**
 * Mark the view as having moved, and ARM A FRAME FOR WHEN THE HOLD ENDS.
 *
 * **Without the timer it never fades at all**, which is what the first
 * version did: the frame loop stops as soon as nothing is changing, so by
 * the time the hold expires there is no frame left to notice -- and the bar
 * sits on the last painted frame for ever. Measured at a flat 1,447 lit
 * pixels five seconds after the last gesture. The fade then carries itself,
 * because a fading frame asks for the next one.
 */
function noteScale() {
  scaleAt = performance.now();
  clearTimeout(scaleTimer);
  scaleTimer = setTimeout(draw, SCALE_HOLD_MS + 20);
}

function scaleAlpha(now) {
  const age = now - scaleAt;
  if (age <= SCALE_HOLD_MS) return 1;
  if (age >= SCALE_HOLD_MS + SCALE_FADE_MS) return 0;
  return 1 - (age - SCALE_HOLD_MS) / SCALE_FADE_MS;
}

function drawScale(w, h) {
  const now = performance.now();
  const a = scaleAlpha(now);
  if (a <= 0) return false;
  const m = mpp();
  const want = Math.min(180, w * 0.28) * m;
  const pow = 10 ** Math.floor(Math.log10(want));
  const step = [1, 2, 5, 10].map(k => k * pow).find(v => v >= want) || pow * 10;
  const px = step / m;
  if (!Number.isFinite(px) || px < 20) return false;
  // Bottom LEFT: the credit lives bottom right and the two overlapped.
  const x = 16, y = h - 14;
  ctx.save();
  ctx.globalAlpha = a;
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
  // Still mid-fade, so the next frame has something to do.
  return a < 1;
}

function drawRoute() {
  const line = state.route.line;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = themeName === 'light'
    ? 'rgba(251,245,232,.80)' : 'rgba(0,0,0,.55)';
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
  // The query string's own markers, drawn last so a marker is never under a
  // journey pin, and in the alarm colour because they are the only thing on
  // this map that somebody else put there.
  if (shownMarker) placeMarker();
  for (const m of state.markers) {
    pin([m.lon, m.lat], T.marker, T.bg);
    const [X, Y] = onGlass([m.lon, m.lat]);
    ctx.save();
    ctx.beginPath();
    ctx.arc(X, Y, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = T.bg;
    ctx.fill();
    ctx.restore();
  }
}

/** The marker under a tap, if there is one. Screen pixels, after the turn. */
function markerAt(x, y) {
  let best = null, bd = 18;
  for (const m of state.markers) {
    const [X, Y] = onGlass([m.lon, m.lat]);
    const d = Math.hypot(X - x, Y - y);
    if (d < bd) { bd = d; best = m; }
  }
  return best;
}

/**
 * What a marker says when it is tapped.
 *
 * A DOM bubble and not canvas text: it carries a LINK, and a link drawn on a
 * canvas is a link nobody can open, copy or read with a screen reader.
 */
let shownMarker = null;
let markerBox = { w: 180, h: 80 };

function openMarker(m) {
  const el = $('marker');
  if (!el) return;
  const dest = `${m.lat.toFixed(6)},${m.lon.toFixed(6)}`;
  el.innerHTML = '';
  if (m.title) {
    const b = document.createElement('b');
    b.textContent = m.title;
    el.appendChild(b);
  }
  if (m.desc) {
    const p = document.createElement('p');
    p.textContent = m.desc;
    el.appendChild(p);
  }
  const a = document.createElement('a');
  a.href = `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = 'Directions';
  el.appendChild(a);
  el.hidden = false;
  // Measured ONCE, here, because the bubble is as wide as its own words --
  // and then reused every frame it is open, so sticking it to its pin costs
  // two style writes rather than a layout flush (E1065).
  const r = el.getBoundingClientRect();
  markerBox = { w: r.width, h: r.height };
  shownMarker = m;
  placeMarker();
}

/** Above the pin, and never off the glass. */
function placeMarker() {
  const el = $('marker');
  if (!el || !shownMarker) return;
  const [X, Y] = onGlass([shownMarker.lon, shownMarker.lat]);
  const w = cv.width / DPR, h = cv.height / DPR;
  const left = Math.max(8, Math.min(w - markerBox.w - 8, X - markerBox.w / 2));
  const top = Y - markerBox.h - 16 < 8 ? Y + 18 : Y - markerBox.h - 16;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.min(h - markerBox.h - 8, top))}px`;
}

function closeMarker() {
  const el = $('marker');
  if (el) el.hidden = true;
  shownMarker = null;
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
let holdTimer = 0;
function settle() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { gesturing = false; draw(); }, 120);
  // **And a frame when the hold expires.** The settle only moves when a
  // frame runs, and once the blend has stopped changing nothing schedules
  // one -- so the map sat at the zoom's blend for ever, waiting for a
  // repaint to notice that six hundred milliseconds of stillness had passed.
  clearTimeout(holdTimer);
  holdTimer = setTimeout(draw, SETTLE_HOLD_MS + 40);
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
  if (wasLast && downAt && moved < 10) {
    // **A marker answers a tap even in an embed**, which is the whole point
    // of it; setting a journey from a tap still does not.
    const hit = markerAt(x, y);
    if (hit) {
      openMarker(hit);
    } else if (!EMBED) {
      closeMarker();
      const [tlon, tlat] = llAt(x, y);
      onTap(tlon, tlat);
    } else {
      closeMarker();
    }
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
  // The scale bar rides on the same signal: it is on screen while the view
  // is moving and for a couple of seconds after.
  noteScale();
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
  // **A finite number is not a coordinate.** The fragment Ali's blank map was
  // stuck on reads `-358.46676` for its latitude, and this accepted it and
  // restored it on every reload. `clampView` would pull the view back now,
  // but a fragment outside the world is not a view to restore from at all --
  // refuse it and let `fit` open on the data.
  if (Math.abs(lat) > 85 || Math.abs(lon) > 180 || z < -1 || z > 30) {
    return false;
  }
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
/** Why the worker refused to start, for the diagnostics panel. */
let WORKER_ERROR = '';

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
    routeWorker.onerror = (ev) => {
      // **A worker that will not start is not a reason to have no routing**,
      // and until now that comment described an intention the code did not
      // carry out: it set the flag for NEXT time and rejected everything
      // in flight, so the first route after a worker failure always failed
      // visibly and only a retry took the fallback. Ali hit exactly that --
      // one attempt, 708 ms, "the routing worker did not start" -- with a
      // main-thread path sitting right there. Re-run them here instead.
      routeWorker = false;
      WORKER_ERROR = (ev && (ev.message || ev.type)) || 'failed to load';
      const waiting = [...routeWaiting.values()];
      routeWaiting.clear();
      for (const w of waiting) {
        if (!w.area) { w.reject(new Error('the routing worker did not start')); continue; }
        planAndRoute(w.area.store, w.from, w.to, { endBlocks: END_BLOCKS })
          .then((res) => w.resolve({ local: true, res }))
          .catch((err) => w.reject(err));
      }
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
    // The request carries what it needs to be RE-RUN, because a worker that
    // dies mid-flight can only be recovered from by somebody holding the
    // arguments (see `onerror`).
    routeWaiting.set(id, { resolve, reject, area, from, to });
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
  // only where the answer is put -- and `setUnreached` is the one way in,
  // because the pink is a rasterised layer now and its tiles have to go.
  setUnreached(res.unreached);
}

// ------------------------------------------------------------------ loading

async function loadFlavour(id) {
  const all = await fetch(`${DATA}d/flavors.json`).then(r => r.json());
  const f = all.flavors.find(x => x.id === id) || all.flavors[0];
  state.flavour = f;
  state.areas = [];
  state.route = null;
  setUnreached([]);
  state.bounds = null;

  // Which maps there are, kept for the menu: the picker is one list of
  // releases and flavours now, and it cannot be built until both the
  // releases and the flavours are in hand.
  flavourDoc = all;

  // The provenance badge is not decoration. The OSM flavour is a tech demo
  // and must never be mistaken for the corpus — on screen or in a screenshot
  // of the screen — so it is shown in the embed too.
  // ***AND IT IS ONLY EVER ON THE IMPORTED FLAVOUR.*** Ali, 2026-10-09:
  // *"Why would we need a badge stating where the data comes from
  // though?"* On the corpus: we would not. It is our own map and the
  // default one, the picker already names it, nothing legally requires it,
  // and a reader can do nothing with it -- a boast, not a disambiguation.
  //
  // The DANGER IS ONE-WAY and that is the whole asymmetry: a screenshot of
  // the OSM tech demo taken for Ali Maps' own detection is the confusion
  // this was built for, and it has shipped once. ***AND ON A PHONE THE
  // BADGE IS THE ONLY ATTRIBUTION THERE IS***, because the credit plate is
  // `display: none` under 640px -- measured, not assumed.
  const badge = $('badge');
  const imported = f.provenance === 'imported';
  badge.hidden = !imported;
  badge.className = 'badge ' + f.provenance;
  badge.textContent = imported
    ? 'TECH DEMO · OpenStreetMap, not the Ali Maps corpus'
    : '';

  // The credit follows the flavour. An earlier build printed "Roads detected
  // from satellite imagery. No imported road network." over the OSM demo,
  // which is the precise confusion the badge exists to prevent — and the
  // credit is the line that survives into a screenshot.
  const ours = document.querySelector('#credit .ours');
  // ODbL attribution is required wherever the data is shown, so on the OSM
  // flavour this line is marked as one the embed may not hide.
  ours.classList.toggle('required', f.provenance === 'imported');
  // ***AND ON THE CORPUS FLAVOUR IT SAYS NOTHING***, because the map does
  // not need to introduce itself. Ali, 2026-10-09: *"Why do we say 'Roads
  // detected from satellite imagery. No imported road network.'
  // Everywhere"*. It was on screen FOUR times at once - the badge, this
  // credit, the info panel's note and a provenance stat tile - and now it
  // is on screen nowhere, because every one of them was a claim about us
  // rather than about the ground.
  // The OSM line is a LICENCE OBLIGATION and stays wherever the data is
  // shown, which is the whole reason these two slots are not one.
  ours.innerHTML = f.provenance === 'imported'
    ? 'Road data &copy; <a href="https://www.openstreetmap.org/copyright" '
      + 'target="_blank" rel="noopener">OpenStreetMap</a> contributors, ODbL.'
      + '<br>Segmented into the Ali Maps model. Not the Ali Maps corpus.'
    : '';
  // ***AND `required` IS ON THE PLATE AND NOT ONLY ON THE LINE, BECAUSE A
  // PHONE HIDES THE PLATE.*** `@media (max-width: 640px)` dropped the whole
  // credit, so on a phone the ODbL attribution was not on screen at all --
  // page or embed - and the badge, which names OpenStreetMap but not the
  // licence, was carrying it alone. Measured at 380 px before it was fixed.
  const plate = $('credit');
  plate.hidden = !imported;
  plate.classList.toggle('required', imported);

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
    // **The raster index is fetched BEFORE the first paint, on purpose.**
    // It is about 20 kB and it decides whether a 1.87 MB vector level is
    // wanted at all, so one round trip here is the cheapest request this
    // client makes. Fetched from the first FRAME instead, the vector level
    // is already in flight by the time the answer arrives and the byte case
    // is lost even though the picture is right.
    if (PRERENDER && area.index.raster) {
      preIndex.set(base, 'loading');
      await fetch(`${base}/${area.index.raster}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => preIndex.set(base, j))
        .catch(() => preIndex.set(base, null));
    }
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


// ----------------------------------------------------------------- controls


// **There is no Fit button.** Ali removed it, and the action survives where
// it is actually wanted: `#home` is the same `fit`, aimed at the area the
// hint is pointing at, and it appears exactly when the map is off screen --
// which is the one moment anybody reached for Fit.
$('home').onclick = () => {
  fit(homeTarget ? homeTarget.bounds : undefined);
  refresh();
  draw();
};

applyTheme(themeName);
// The device is the control now, so the page follows it while it is open.
try {
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
    applyTheme(e.matches ? 'light' : 'dark');
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
  setUnreached([]);
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

/**
 * The menu, which is every choice the toolbar used to hold.
 *
 * Ali, 2026-10-10: *"for switching versions, I guess we can have that under a
 * right top orientated hamburger menu that can switch versions, report a bug,
 * and the versions can also change to OpenStreetMap that we already have."*
 *
 * **One list, not two.** A release and a flavour are different things to us --
 * one is a snapshot of the corpus, the other is whose data it is -- and from
 * the outside they answer the same question, "which map am I looking at". So
 * the releases are listed newest first and the imported flavour sits under
 * them with its own line of small print, because the one distinction that
 * does matter is the one the badge is still there to make.
 */
let flavourDoc = null;        // flavors.json, as loaded
let versionDoc = null;        // versions.json, or null on an origin with none
let versionId = null;         // the release in use

const TICK = '<span class="tick"><svg viewBox="0 0 24 24" aria-hidden="true"'
  + ' focusable="false"><path d="M4.5 12.5 9 17 19.5 6.5"/></svg></span>';
const NOTICK = '<span class="tick"></span>';

/** Go to a map, by whatever combination of release and flavour it is. */
function goToMap(params) {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  location.href = u.toString();
}

function buildMenu() {
  const box = $('maps');
  if (!box) return;
  box.innerHTML = '';
  const onCorpus = !state.flavour || state.flavour.provenance !== 'imported';
  const rows = [];

  // The releases, newest first: the list is read top down and the newest is
  // what nearly everybody wants. An origin with no releases file still has
  // one map, so it gets one row rather than an empty heading.
  if (versionDoc && versionDoc.versions.length) {
    for (const v of [...versionDoc.versions].reverse()) {
      rows.push({
        label: v.label || v.id,
        // **The DATE and not the note.** A release's `note` is written for
        // the ledger -- entry numbers, kilometres, which arm -- and three of
        // them turned the menu into a 360 px wall of engineering prose that
        // pushed the compass into the middle of the screen. It is the row's
        // tooltip instead, which is where the old select had it.
        detail: v.builtAt ? `Built ${v.builtAt}` : '',
        tip: v.note || '',
        current: onCorpus && v.id === versionId,
        go: { f: 'corpus', v: v.id },
      });
    }
  } else {
    rows.push({
      label: 'Ali Maps',
      detail: 'Every road found by detection',
      current: onCorpus,
      go: { f: 'corpus' },
    });
  }

  // And whatever else we hold, which today is the OpenStreetMap tech demo.
  // Named for its DATA and not for its title: "Riyadh - tech demo" does not
  // say the one thing somebody switching to it needs to know.
  for (const f of (flavourDoc ? flavourDoc.flavors : [])) {
    if (f.provenance !== 'imported') continue;
    rows.push({
      label: 'OpenStreetMap',
      detail: 'Tech demo. Not the Ali Maps corpus.',
      current: !onCorpus && state.flavour.id === f.id,
      go: { f: f.id },
    });
  }

  for (const r of rows) {
    const b = document.createElement('button');
    b.type = 'button';
    if (r.tip) b.title = r.tip;
    if (r.current) b.setAttribute('aria-current', 'true');
    b.innerHTML = (r.current ? TICK : NOTICK)
      + `<span>${r.label}`
      + (r.detail ? `<small>${r.detail}</small>` : '')
      + '</span>';
    b.onclick = () => { closeMenu(); goToMap(r.go); };
    box.appendChild(b);
  }
}

function openMenu() {
  $('sheet').hidden = false;
  $('menu').setAttribute('aria-expanded', 'true');
}

function closeMenu() {
  $('sheet').hidden = true;
  $('menu').setAttribute('aria-expanded', 'false');
}

$('menu').onclick = () => ($('sheet').hidden ? openMenu() : closeMenu());

$('bug').onclick = () => {
  closeMenu();
  copyDiagnostics();
};

// **A press on the map closes the menu and does nothing else.** Letting it
// through would set a journey's start under a finger that was dismissing a
// panel -- E868's rule in the labelling tool, and the same answer here: catch
// it on the way down, before the canvas sees it.
addEventListener('pointerdown', (e) => {
  if ($('sheet').hidden) return;
  const t = e.target;
  if (t && t.closest && t.closest('#sheet, #menu')) return;
  closeMenu();
  e.preventDefault();
  e.stopPropagation();
}, true);

addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('sheet').hidden) closeMenu();
  else if (e.key === 'Escape') closeMarker();
});

/**
 * The crosshair: where am I.
 *
 * The same action the Locate button had -- a fix, the view moved onto it, and
 * the journey's start set -- behind the target Ali asked for. It says what it
 * is doing in the button itself while the fix is pending, because a
 * geolocation prompt can sit unanswered for a long time and a control that
 * looks idle is a control somebody presses again.
 */
$('locate').onclick = () => {
  const btn = $('locate');
  if (!navigator.geolocation) return hint('This browser has no location.');
  btn.classList.add('on');
  hint('Finding you…');
  navigator.geolocation.getCurrentPosition((p) => {
    btn.classList.remove('on');
    state.me = [p.coords.longitude, p.coords.latitude];
    state.from = state.me;
    state.to = null;
    const w = cv.width / DPR, h = cv.height / DPR;
    scale = (h / 900) * 111132;
    ox = w / 2 - state.me[0] * KX * scale;
    oy = h / 2 + state.me[1] * scale;
    hint('Now tap where you are going.');
    refresh();
  }, () => {
    btn.classList.remove('on');
    hint('Could not get your location.');
  }, { enableHighAccuracy: true });
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
let loaded = false;

window.__alimaps = {
  /** True once the flavour, its areas and the initial framing are all in. */
  get loaded() { return loaded; },
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
  /** Which octave each level has LIVE, which is the one on screen. */
  octaves: () => {
    const out = {};
    for (const [name, L] of layers.levels) {
      if (L.live) out[name] = L.live.oct;
    }
    return out;
  },
  /**
   * Per level: the live octave, how many of its tiles exist, and how many it
   * would take to cover the view.
   *
   * `drawn` is derived from the LayerSet rather than counted by the painter,
   * so it cannot go stale the way the old one did -- a level that stopped
   * being asked for kept its last count for ever and reported `fine` as on
   * screen at z 10 when it had not been drawn in seconds.
   */
  gens: () => {
    const out = {};
    for (const [name, L] of layers.levels) {
      const live = L.live;
      const b = L.building;
      out[name] = {
        oct: live ? live.oct : null,
        drawn: live && live.oct === octFor(scale) ? live.done.size : 0,
        need: live ? live.blocking.size : 0,
        building: b ? { oct: b.oct, have: b.done.size, need: b.blocking.size }
          : null,
      };
    }
    return out;
  },
  layers,
  ripples,
  zoomIntent,
  gesturing: () => gesturing,
  report: debugReport,
  blits: () => ({ ...BLITS }),
  rebuilds: () => {
    let total = 0, again = 0, worst = [];
    for (const [k, n] of REBUILDS) { total += n; if (n > 1) again += n - 1; }
    worst = [...REBUILDS.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    return { keys: REBUILDS.size, total, again, worst };
  },
  visibleKeys: (oct) => visibleKeys(oct),
  tileBox: (oct, ix, iy) => tileBox(oct, ix, iy),
  compassAt: () => compassAt(cv.width / DPR, cv.height / DPR),
  // Where a place is on the glass, turn and all -- so a test can press
  // the pin rather than guess at the projection.
  glassAt: (lon, lat) => onGlass([lon, lat]),
  diagnosticImage: () => diagnosticImage(debugReport()),
  _pxs: () => PXS,
  /** Rasterise one tile from scratch into a fresh canvas, and report it. */
  redraw: (lv, oct, ix, iy) => {
    const fake = { key: 'probe', lv, oct, ix, iy, done: false, t0: 0,
                   used: performance.now(), bytes: 0, jobs: null, job: 0,
                   line: 0, paths: 0, dpr: DPR, data: dataEpoch, back: null,
                   canvas: null, ctx: null };
    BATCH_SPY = [];
    while (!stepTile(fake, 10000)) { /* one tile, no budget */ }
    const spy = BATCH_SPY;
    BATCH_SPY = null;
    const g = fake.canvas.getContext('2d');
    const d = g.getImageData(0, 0, fake.canvas.width, fake.canvas.height).data;
    const hist = new Map();
    for (let i = 0; i < d.length; i += 16) {
      if (d[i + 3] < 20) continue;
      const k = `${d[i]},${d[i + 1]},${d[i + 2]}`;
      hist.set(k, (hist.get(k) || 0) + 1);
    }
    rtBytes -= fake.bytes;
    // And what the width rule made of this tile's own roads.
    const PXSOF = (r) => 1 / r.z0;
    const level = levelNamed(lv);
    const m = 111132 / Math.pow(2, oct);
    const ws = [];
    for (const area of state.areas) {
      if (!area.index || !level) continue;
      for (const lines of groupsUnder(area, level, fake)) {
        for (const l of lines) {
          const W = Math.max(THIN_PX * PXSOF(fake), Math.min(140 * PXSOF(fake),
            (l.widthM || 6) / m));
          const kerb = Math.max(1.1 * PXSOF(fake),
            Math.min(4 * PXSOF(fake), W * 0.09));
          ws.push([+W.toFixed(2), +kerb.toFixed(2), +(W - 2 * kerb).toFixed(2),
                   l.widthM, l.oneway ? 1 : 0]);
        }
      }
    }
    ws.sort((a, b) => b[0] - a[0]);
    const byPass = {};
    for (const [ps, st, wd] of spy) {
      const k = `pass${ps} ${st}`;
      (byPass[k] = byPass[k] || []).push(wd);
    }
    const summary = Object.entries(byPass).map(([k, v]) => [k, v.length,
      +Math.min(...v).toFixed(2), +Math.max(...v).toFixed(2)]);
    return { strokes: summary, paths: fake.paths, pxs: +PXSOF(fake).toFixed(3),
             widest: ws.slice(0, 4), narrowest: ws.slice(-4), n: ws.length,
             top: [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5) };
  },
  /**
   * The pre-rendered layer, for a test rather than for a regex.
   *
   * E827: a print string is not an interface, and the raster's own state
   * was only readable by matching "pre-rendered" in `report()` -- which
   * cannot tell "held the outgoing level" from "fell through to the
   * vectors", and that is the whole of what E1057 is about.
   */
  pre: () => ({ drew: PRE_DREW, hold: PRE_HOLD,
                shown: Object.fromEntries(preShown),
                swapping: preSwapAt.size,
                level: state.areas.map((a) => {
                  const ix = preIndex.get(a.base);
                  if (!ix || ix === 'loading') return null;
                  const lv = preLevelFor(ix, mpp());
                  return lv ? lv.dir : null;
                }) }),
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
    // **There is no blend any more.** Kept as a hook so anything asking gets
    // a straight answer rather than an exception: one level, `t` always 0.
    const n = levelFor(a).name;
    return { a: n, b: null, t: 0, settled: { a: n, b: null, t: 0 } };
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
    // **The fades, because 420 and 200 ms were chosen and never looked at.**
    // Ali, 2026-10-09, three times: *"I still see no fading whatsoever"*,
    // *"I have tried intensively and never saw a fade"*, *"Even tiles
    // arriving, i didnt see them?"* -- and the tile fade MEASURES as
    // working, alphas ramping 0.01, 0.04, 0.12, 0.22, 0.43, 0.66 on 19
    // frames of 90. It runs in a fifth of a second on a hand that is
    // already moving. **A fade nobody can see is not a fade**, so rather
    // than pick a number for Ali these are a knob: set them live, decide by
    // eye, and the value that wins gets committed.
    if (o && o.fadeMs !== undefined) {
      LEVEL_FADE_MS = Math.max(0, Math.min(4000, o.fadeMs));
      layers.fadeMs = LEVEL_FADE_MS;
    }
    if (o && o.tileFadeMs !== undefined) {
      layers.tileFadeMs = Math.max(0, Math.min(4000, o.tileFadeMs));
    }
    // `thinTwoWay`/`thinOneWay` were read and written here and DECLARED
    // NOWHERE, so `__alimaps.tune()` threw a ReferenceError on every call --
    // the tuning hook, unusable, since whichever edit removed the constants
    // left their uses behind. There is one colour per road class now and
    // nothing to override.
    if (o) invalidate();
    return { sliceMs: SLICE_MS, sliceGestureMs: SLICE_GESTURE_MS,
             overrunMs: OVERRUN_MS, predictS: PREDICT_S, thinPx: THIN_PX,
             fadeMs: LEVEL_FADE_MS, tileFadeMs: layers.tileFadeMs,
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

// ------------------------------------------------------------- the release
//
// Which corpus this page is showing. Published releases are immutable and
// the newest one is served from the data origin itself, so:
//
//   * no `versions.json`              -> the origin, exactly as before;
//   * `versions.json`, nothing asked  -> `latest`, which IS the origin;
//   * `?v=<id>`                       -> that release's own base.
//
// A release is a snapshot of `d/` and nothing else, so switching changes
// the tiles and never the page.

async function chooseVersion() {
  let doc = null;
  try {
    const r = await fetch(`${DATA_ROOT}versions.json`, { cache: 'no-cache' });
    if (r.ok) doc = await r.json();
  } catch (_) { /* an origin with no releases file is the old shape */ }
  if (!doc || !Array.isArray(doc.versions) || !doc.versions.length) {
    return null;
  }
  // **An embed always gets `latest`.** A pinned release on somebody else's
  // page is a map going quietly stale with nobody to notice it.
  let want = Q.get('v');
  if (EMBED && want) {
    embedRefusals.push(
      'An embedded Ali Maps always shows the newest published map, so '
      + `the release "${want}" was ignored.`);
    want = null;
  }
  const pick = doc.versions.find((x) => x.id === want)
    || doc.versions.find((x) => x.id === doc.latest)
    || doc.versions[doc.versions.length - 1];
  // A base is a path under the origin, never an absolute URL: a release
  // cannot redirect the page at somebody else's bucket.
  DATA = DATA_ROOT + String(pick.base || '').replace(/^\/+/, '')
    .replace(/([^/])$/, '$1/');
  // The list itself belongs to the menu, which also carries the flavours --
  // Ali: "the versions can also change to OpenStreetMap that we already
  // have" -- so it is built once both are known.
  versionDoc = doc;
  versionId = pick.id;
  return pick;
}

// ---------------------------------------------------------------------- go
await chooseVersion();
await loadFlavour(wantedFlavour());
buildMenu();
// **The page has finished arranging itself.** `loadFlavour` ends in `fit()`,
// which is the last thing that moves the view without being asked -- so a
// test that starts driving before this lands can have its gesture undone by
// the initial framing. A harness needs something true to wait for, and "a
// tile has been drawn" is not it: one tile is drawn long before the flavour,
// the areas and the framing are settled.
state.markers = parseMarkers();
// **A marker with no view asked for frames itself**, because somebody who
// sends a link to a place means the place. A hash, a `?lat`, an embed
// intent or a `?from` all say otherwise and all win -- `fit` is what decides
// that, and this only ever calls it when none of them is there.
if (state.markers.length && !INTENT && !location.hash && !Q.get('lat')
    && !Q.get('from')) {
  const PAD = 0.0027;                     // about 300 m, so one pin has a view
  let b = [1e9, 1e9, -1e9, -1e9];
  for (const m of state.markers) {
    b = [Math.min(b[0], m.lon - PAD), Math.min(b[1], m.lat - PAD),
         Math.max(b[2], m.lon + PAD), Math.max(b[3], m.lat + PAD)];
  }
  hashApplied = true;                     // the markers ARE the framing
  fit(b);
}
loaded = true;
noteScale();
draw();

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
} else if (embedRefusals.length) {
  hint(embedRefusals[0]);
}
// **And nothing is said on a first load.** Ali, 2026-10-10, removing it: a
// card over the map telling somebody to tap the map is the page explaining
// itself before anybody has asked, and the map is what they came for. The
// hint still speaks once a journey is under way -- "Now tap where you are
// going" is an answer to something they did.

/**
 * Do what the embed URL asked for.
 *
 * Anything we cannot do is SAID, in the page, rather than quietly dropped --
 * a satellite request that silently returns a road map is the caller being
 * told something untrue about what they are looking at.
 */
async function applyEmbedIntent(intent) {
  for (const w of [...embedRefusals, ...intent.warnings]) hint(w);

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
