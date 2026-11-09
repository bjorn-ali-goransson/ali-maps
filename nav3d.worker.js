// Welding and smoothing road geometry for the driver's-eye view, off the main
// thread.
//
// **Why this is display-only, stated before anything else.** The corpus cannot
// draw a curve: every road edge is a straight two-point segment, and E311
// found that in the two districts with ground truth nothing needs one. Nothing
// here changes that. This welds adjacent straight pieces into a continuous
// path and rounds the joins **for the renderer**, because a 6 m-wide ribbon
// pitched onto the horizon shows every 3-degree kink as a notch, and a notch
// that is not in the road is as much of a lie as a missing street.
//
// So: the smoothed geometry never leaves this worker's output, never reaches a
// graph, is never measured, and is never written to disk. "GEOMETRY MAY ONLY
// PROPOSE. CONTROL GEOMETRY MUST NEVER REACH A PRODUCTION GRAPH" (E157) — this
// is a long way below even proposing.
//
// **Why a worker.** Welding a district and sampling splines through it is tens
// of milliseconds, and it has to happen again every time the view moves to a
// different instruction. On the main thread that lands squarely in the frame
// that is also tweening the camera. Here it lands nowhere the user can feel,
// and the result comes back as one transferable buffer.
//
// **Why an LOD radius.** A driver can see a few hundred metres. Welding the
// whole city to draw four streets is work with no viewer.

const E7 = 1e-7;

/** Decoded tiles, keyed by URL. The worker fetches its own. */
const tiles = new Map();

/** Chains whose ends turn by more than this are different roads, not a bend. */
const WELD_MAX_TURN_DEG = 42;

/** Two pieces this far apart or closer share an end. Kerb-width slack. */
const WELD_SNAP_M = 1.2;

/** A carriageway may only weld to one of comparable width. */
const WELD_WIDTH_RATIO = 1.6;

/** Metres between samples along a smoothed curve. */
const SAMPLE_M = 3.5;

/** Chains shorter than this are not worth smoothing; they pass through. */
const MIN_SMOOTH_M = 12;

function readDrawTile(buffer) {
  const v = new DataView(buffer);
  for (let i = 0; i < 4; i++) {
    if (v.getUint8(i) !== 'LPM3'.charCodeAt(i)) throw new Error('not LPM3');
  }
  let off = 4;
  const n = v.getUint32(off, true);
  off += 4;
  const out = [];
  for (let i = 0; i < n; i++) {
    const roadClass = v.getUint8(off);
    const oneway = v.getUint8(off + 1) !== 0;
    const widthM = v.getUint16(off + 2, true) / 10;
    const nPts = v.getUint16(off + 4, true);
    off += 6;
    const pts = new Float64Array(nPts * 2);
    for (let p = 0; p < nPts; p++) {
      pts[p * 2] = v.getInt32(off, true) * E7;
      pts[p * 2 + 1] = v.getInt32(off + 4, true) * E7;
      off += 8;
    }
    out.push({ roadClass, oneway, widthM, pts });
  }
  return out;
}

// ------------------------------------------------------------------ welding

const key = (x, y) => `${Math.round(x)}|${Math.round(y)}`;

function bearing(ax, ay, bx, by) {
  return Math.atan2(bx - ax, by - ay) * 180 / Math.PI;
}

function angleBetween(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Join straight pieces into continuous paths.
 *
 * Only where the join is genuinely a continuation: ends within a kerb's width
 * of each other, turning by less than `WELD_MAX_TURN_DEG`, and of comparable
 * carriageway width. **A real 90-degree junction must not be welded**, because
 * smoothing one would round off a corner that is square on the ground — the
 * exact "surprise" CLAUDE.md puts above positional accuracy.
 */
function weld(lines) {
  // Adjacency on endpoints rounded to `WELD_SNAP_M`, in local metres so the
  // tolerance is a distance rather than a number of degrees.
  const at = new Map();
  const add = (k, rec) => {
    let v = at.get(k);
    if (!v) at.set(k, (v = []));
    v.push(rec);
  };
  const endKey = (l, which) => {
    const n = l.mx.length;
    const x = which === 0 ? l.mx[0] : l.mx[n - 1];
    const y = which === 0 ? l.my[0] : l.my[n - 1];
    return key(x / WELD_SNAP_M, y / WELD_SNAP_M);
  };
  lines.forEach((l, i) => {
    add(endKey(l, 0), { i, end: 0 });
    add(endKey(l, 1), { i, end: 1 });
  });

  const used = new Uint8Array(lines.length);
  const chains = [];

  /** Follow from one end of a line while exactly one continuation fits. */
  const extend = (chain, fromLine, fromEnd) => {
    let cur = fromLine, end = fromEnd;
    for (;;) {
      const l = lines[cur];
      const n = l.mx.length;
      // The bearing leaving this end.
      const ax = end === 1 ? l.mx[n - 2] : l.mx[1];
      const ay = end === 1 ? l.my[n - 2] : l.my[1];
      const bx = end === 1 ? l.mx[n - 1] : l.mx[0];
      const by = end === 1 ? l.my[n - 1] : l.my[0];
      const out = bearing(ax, ay, bx, by);

      const here = at.get(endKey(l, end)) || [];
      let best = null;
      let candidates = 0;
      for (const rec of here) {
        if (rec.i === cur || used[rec.i]) continue;
        const m = lines[rec.i];
        const ratio = m.widthM / Math.max(l.widthM, 0.1);
        if (ratio > WELD_WIDTH_RATIO || ratio < 1 / WELD_WIDTH_RATIO) continue;
        if (m.oneway !== l.oneway) continue;
        const k = m.mx.length;
        const cx = rec.end === 0 ? m.mx[0] : m.mx[k - 1];
        const cy = rec.end === 0 ? m.my[0] : m.my[k - 1];
        const dx = rec.end === 0 ? m.mx[1] : m.mx[k - 2];
        const dy = rec.end === 0 ? m.my[1] : m.my[k - 2];
        const into = bearing(cx, cy, dx, dy);
        if (angleBetween(out, into) > WELD_MAX_TURN_DEG) continue;
        candidates++;
        if (!best || angleBetween(out, into) < best.turn) {
          best = { rec, turn: angleBetween(out, into) };
        }
      }
      // More than one plausible continuation is a junction, not a bend. Stop
      // rather than guess which way the street goes.
      if (!best || candidates > 1) return;

      const m = lines[best.rec.i];
      used[best.rec.i] = 1;
      const k = m.mx.length;
      if (best.rec.end === 0) {
        for (let p = 1; p < k; p++) chain.push(m.mx[p], m.my[p]);
      } else {
        for (let p = k - 2; p >= 0; p--) chain.push(m.mx[p], m.my[p]);
      }
      cur = best.rec.i;
      end = best.rec.end === 0 ? 1 : 0;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const l = lines[i];
    const fwd = [];
    for (let p = 0; p < l.mx.length; p++) fwd.push(l.mx[p], l.my[p]);
    extend(fwd, i, 1);
    // ...then the other way, prepending.
    const back = [];
    const tmp = [];
    for (let p = l.mx.length - 1; p >= 0; p--) tmp.push(l.mx[p], l.my[p]);
    extend(tmp, i, 0);
    for (let p = tmp.length - 2; p >= l.mx.length * 2; p -= 2) {
      back.push(tmp[p], tmp[p + 1]);
    }
    const pts = back.length ? back.concat(fwd) : fwd;
    chains.push({ pts, widthM: l.widthM, oneway: l.oneway });
  }
  return chains;
}

// ------------------------------------------------------------- smoothing

function chainLength(p) {
  let n = 0;
  for (let i = 0; i + 3 < p.length; i += 2) {
    n += Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
  }
  return n;
}

/**
 * Centripetal Catmull-Rom through the welded vertices.
 *
 * Centripetal (alpha = 0.5) rather than uniform, because uniform Catmull-Rom
 * overshoots and self-intersects where two vertices sit close together — which
 * in this data is every junction approach, and an overshoot puts the kerb
 * through the pavement.
 */
function smooth(p) {
  const n = p.length / 2;
  if (n < 3) return p;
  const out = [];
  const px = (i) => p[Math.max(0, Math.min(n - 1, i)) * 2];
  const py = (i) => p[Math.max(0, Math.min(n - 1, i)) * 2 + 1];

  for (let i = 0; i < n - 1; i++) {
    const x0 = px(i - 1), y0 = py(i - 1);
    const x1 = px(i), y1 = py(i);
    const x2 = px(i + 1), y2 = py(i + 1);
    const x3 = px(i + 2), y3 = py(i + 2);

    const d01 = Math.sqrt(Math.hypot(x1 - x0, y1 - y0)) || 1e-4;
    const d12 = Math.sqrt(Math.hypot(x2 - x1, y2 - y1)) || 1e-4;
    const d23 = Math.sqrt(Math.hypot(x3 - x2, y3 - y2)) || 1e-4;

    const seg = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.min(24, Math.round(seg / SAMPLE_M)));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      // Barry-Goldman, so the knot spacing is honoured rather than assumed.
      const t0 = 0, t1 = t0 + d01, t2 = t1 + d12, t3 = t2 + d23;
      const tt = t1 + (t2 - t1) * t;
      const a1x = ((t1 - tt) * x0 + (tt - t0) * x1) / (t1 - t0 || 1);
      const a1y = ((t1 - tt) * y0 + (tt - t0) * y1) / (t1 - t0 || 1);
      const a2x = ((t2 - tt) * x1 + (tt - t1) * x2) / (t2 - t1 || 1);
      const a2y = ((t2 - tt) * y1 + (tt - t1) * y2) / (t2 - t1 || 1);
      const a3x = ((t3 - tt) * x2 + (tt - t2) * x3) / (t3 - t2 || 1);
      const a3y = ((t3 - tt) * y2 + (tt - t2) * y3) / (t3 - t2 || 1);
      const b1x = ((t2 - tt) * a1x + (tt - t0) * a2x) / (t2 - t0 || 1);
      const b1y = ((t2 - tt) * a1y + (tt - t0) * a2y) / (t2 - t0 || 1);
      const b2x = ((t3 - tt) * a2x + (tt - t1) * a3x) / (t3 - t1 || 1);
      const b2y = ((t3 - tt) * a2y + (tt - t1) * a3y) / (t3 - t1 || 1);
      out.push(((t2 - tt) * b1x + (tt - t1) * b2x) / (t2 - t1 || 1),
               ((t2 - tt) * b1y + (tt - t1) * b2y) / (t2 - t1 || 1));
    }
  }
  out.push(p[p.length - 2], p[p.length - 1]);
  return out;
}

// ---------------------------------------------------------------- the job

let token = 0;

async function build(msg) {
  const mine = ++token;
  const { base, suffix, zoom, tileList, origin, anchor, lodM, batch } = msg;
  const kx = 111320 * Math.cos(origin[1] * Math.PI / 180);

  // Which tiles the LOD disc touches.
  const need = [];
  const dLon = lodM / kx, dLat = lodM / 111132;
  const tileOf = (lon, lat) => {
    const n = 2 ** zoom;
    const x = Math.floor((lon + 180) / 360 * n);
    const r = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI)
      / 2 * n);
    return [x, y];
  };
  const [x0, y0] = tileOf(anchor[0] - dLon, anchor[1] + dLat);
  const [x1, y1] = tileOf(anchor[0] + dLon, anchor[1] - dLat);
  for (const [x, y] of tileList) {
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) need.push([x, y]);
  }

  const lines = [];
  for (const [x, y] of need) {
    const url = `${base}/${x}_${y}${suffix}.alimap`;
    let decoded = tiles.get(url);
    if (!decoded) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        decoded = readDrawTile(await res.arrayBuffer());
        tiles.set(url, decoded);
        // A worker that never forgets is a worker that eventually is the tab's
        // memory problem.
        if (tiles.size > 24) tiles.delete(tiles.keys().next().value);
      } catch {
        continue;
      }
    }
    if (mine !== token) return;                  // the view moved on
    lines.push(...decoded);
  }

  // Into local metres about the origin, dropping anything outside the LOD.
  const ax = (anchor[0] - origin[0]) * kx;
  const ay = (anchor[1] - origin[1]) * 111132;
  const local = [];
  for (const l of lines) {
    const n = l.pts.length / 2;
    const mx = new Float64Array(n), my = new Float64Array(n);
    let near = false;
    for (let i = 0; i < n; i++) {
      mx[i] = (l.pts[i * 2] - origin[0]) * kx;
      my[i] = (l.pts[i * 2 + 1] - origin[1]) * 111132;
      if (!near && Math.hypot(mx[i] - ax, my[i] - ay) <= lodM) near = true;
    }
    if (near) local.push({ mx, my, widthM: l.widthM, oneway: l.oneway });
  }

  if (mine !== token) return;
  const chains = weld(local);

  // Stream the result: the view fills as it is built rather than all at once
  // after a pause nobody can explain.
  let pack = [];
  let sent = 0;
  const flush = (done) => {
    if (!pack.length && !done) return;
    const offsets = new Uint32Array(pack.length + 1);
    let total = 0;
    pack.forEach((c, i) => { offsets[i] = total; total += c.pts.length; });
    offsets[pack.length] = total;
    const pts = new Float32Array(total);
    const widths = new Float32Array(pack.length);
    const oneway = new Uint8Array(pack.length);
    pack.forEach((c, i) => {
      pts.set(c.pts, offsets[i]);
      widths[i] = c.widthM;
      oneway[i] = c.oneway ? 1 : 0;
    });
    self.postMessage(
      { type: 'geometry', id: msg.id, token: mine, done, chains: pack.length,
        pts, offsets, widths, oneway },
      [pts.buffer, offsets.buffer, widths.buffer, oneway.buffer]);
    sent += pack.length;
    pack = [];
  };

  for (const c of chains) {
    if (mine !== token) return;
    const pts = chainLength(c.pts) >= MIN_SMOOTH_M ? smooth(c.pts) : c.pts;
    pack.push({ pts: Float32Array.from(pts), widthM: c.widthM,
                oneway: c.oneway });
    if (pack.length >= (batch || 120)) flush(false);
  }
  flush(true);
  void sent;
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'build') build(msg);
  else if (msg.type === 'cancel') token++;
};
