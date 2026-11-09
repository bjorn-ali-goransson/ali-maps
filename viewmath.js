/**
 * The view arithmetic, in ONE place, because there are now two readers.
 *
 * Ali, 2026-10-05: *"I do believe that you need a TypeScript CLI to generate
 * a view with parametrics ... And it should use the same TypeScript code."*
 *
 * The page and the CLI must agree about which detail level a zoom asks for
 * and which tiles a view touches, or the CLI answers a question about a map
 * nobody is looking at. A deliverable that restates what another file owns
 * goes stale (E549, E736), so this module owns it and both import it.
 *
 * Everything here is pure: no canvas, no DOM, no fetch.
 */

/** Web-mercator metres per pixel at a slippy zoom, at a reference latitude. */
export function mppForZoom(zoom, lat) {
  return 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** zoom;
}

/** The slippy zoom a given metres-per-pixel is, at a reference latitude. */
export function zoomForMpp(mpp, lat) {
  return Math.log2(156543.03392 * Math.cos(lat * Math.PI / 180) / mpp);
}

/**
 * Which detail level a view is drawn at.
 *
 * `index` is the area's own published `index.json`, so the LADDER and the
 * switch points are the published map's and are never restated here.
 */
export function levelForMpp(index, m) {
  const L = index.levels;
  const sw = index.switchMpp || [1.5, 9];
  let pick = L[0];
  for (let i = 0; i < sw.length && i + 1 < L.length; i++) {
    if (m >= sw[i]) pick = L[i + 1];
  }
  return pick;
}

/** Slippy tile x/y for a lon/lat at a zoom. */
export function tileOf(lon, lat, z) {
  const n = 2 ** z;
  const r = lat * Math.PI / 180;
  return [Math.floor((lon + 180) / 360 * n),
          Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI)
                     / 2 * n)];
}

/**
 * The lon/lat box a viewport covers, with the map turned by `bearing`.
 *
 * A turned viewport sees a LARGER axis-aligned box than an untouched one,
 * and the corners are what decide it -- measured, because a non-square
 * viewport turned 90 degrees genuinely sees different ground.
 */
export function viewBounds(lon, lat, mpp, width, height, bearing = 0) {
  const t = -bearing * Math.PI / 180;
  const hw = width / 2;
  const hh = height / 2;
  const k = 111320 * Math.cos(lat * Math.PI / 180);
  let lo = [Infinity, Infinity];
  let hi = [-Infinity, -Infinity];
  for (const [px, py] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
    const x = (px * Math.cos(t) - py * Math.sin(t)) * mpp;
    const y = (px * Math.sin(t) + py * Math.cos(t)) * mpp;
    const dlon = x / k;
    const dlat = -y / 111132;
    lo = [Math.min(lo[0], lon + dlon), Math.min(lo[1], lat + dlat)];
    hi = [Math.max(hi[0], lon + dlon), Math.max(hi[1], lat + dlat)];
  }
  return [lo[0], lo[1], hi[0], hi[1]];
}

/** Which of the area's published draw tiles a view box touches. */
export function tilesInView(index, box) {
  const z = index.zoom;
  const n = 2 ** z;
  const out = [];
  for (const [tx, ty] of index.tiles || []) {
    const w = tx / n * 360 - 180;
    const e = (tx + 1) / n * 360 - 180;
    const ty2lat = (y) => {
      const m = Math.PI - 2 * Math.PI * y / n;
      return 180 / Math.PI * Math.atan(0.5 * (Math.exp(m) - Math.exp(-m)));
    };
    const north = ty2lat(ty);
    const south = ty2lat(ty + 1);
    if (e >= box[0] && w <= box[2] && north >= box[1] && south <= box[3]) {
      out.push([tx, ty]);
    }
  }
  return out;
}
