// Reading `.alimap` in the browser.
//
// The third parser of these formats, after `corpus_mappack.py` (which writes
// them) and `map_pack.dart` / `routing.dart` (which the phone reads them with).
// Three independent readers is a feature: a format only one program can read
// is a format with no specification, and the rule in this project is that a
// format you have not read back has not been written (E167, E169).
//
// `parser_check.mjs` runs this against the Python writer's own dump and fails
// on any disagreement, so this file cannot drift.

const GRAPH_MAGIC = 'LPG1';
const TILE_MAGIC = 'LPM2';
const NO_NAME = 0xffff;

function magic(view, off, want) {
  for (let i = 0; i < 4; i++) {
    if (view.getUint8(off + i) !== want.charCodeAt(i)) return false;
  }
  return true;
}

// Coordinates are int32 at 1e-7 degrees -- about 11 mm, far finer than
// anything the corpus can resolve, and immune to float drift between the
// three languages that parse this.
const E7 = 1e-7;

/** One LPM2 drawing tile: road polylines, no topology. */
export function readTile(buffer) {
  const v = new DataView(buffer);
  if (!magic(v, 0, TILE_MAGIC)) throw new Error('not an LPM2 tile');
  let off = 4;
  const nNames = v.getUint16(off, true);
  off += 2;
  const names = [];
  for (let i = 0; i < nNames; i++) {
    const len = v.getUint16(off, true);
    off += 2;
    names.push(new TextDecoder().decode(new Uint8Array(buffer, off, len)));
    off += len;
  }
  const nLines = v.getUint32(off, true);
  off += 4;
  const lines = [];
  for (let i = 0; i < nLines; i++) {
    const roadClass = v.getUint8(off);
    const maxspeed = v.getUint16(off + 1, true);
    const nameId = v.getUint16(off + 3, true);
    const lanes = v.getUint8(off + 5);
    const oneway = v.getUint8(off + 6);
    const nPts = v.getUint16(off + 7, true);
    off += 9;
    const pts = new Float64Array(nPts * 2);
    for (let p = 0; p < nPts; p++) {
      pts[p * 2] = v.getInt32(off, true) * E7;
      pts[p * 2 + 1] = v.getInt32(off + 4, true) * E7;
      off += 8;
    }
    lines.push({
      roadClass,
      maxspeed,
      // A nameId past the end of the table is "no name", which is every edge
      // in this corpus: no street name has ever been invented.
      name: nameId === NO_NAME || nameId >= names.length ? null : names[nameId],
      lanes,
      oneway: oneway !== 0,
      pts,
    });
  }
  return { names, lines };
}

/** One LPG1 routing graph: nodes, and the edges between them. */
export function readGraph(buffer) {
  const v = new DataView(buffer);
  if (!magic(v, 0, GRAPH_MAGIC)) throw new Error('not an LPG1 graph');
  let off = 4;
  const nNames = v.getUint32(off, true);
  off += 4;
  const names = [];
  for (let i = 0; i < nNames; i++) {
    const len = v.getUint16(off, true);
    off += 2;
    names.push(new TextDecoder().decode(new Uint8Array(buffer, off, len)));
    off += len;
  }
  const nNodes = v.getUint32(off, true);
  off += 4;
  const nodes = new Float64Array(nNodes * 2);
  for (let i = 0; i < nNodes; i++) {
    nodes[i * 2] = v.getInt32(off, true) * E7;
    nodes[i * 2 + 1] = v.getInt32(off + 4, true) * E7;
    off += 8;
  }
  const nEdges = v.getUint32(off, true);
  off += 4;
  const edges = [];
  for (let i = 0; i < nEdges; i++) {
    const from = v.getUint32(off, true);
    const to = v.getUint32(off + 4, true);
    const roadClass = v.getUint8(off + 8);
    const oneway = v.getUint8(off + 9);
    const maxspeed = v.getUint16(off + 10, true);
    const speed = v.getUint16(off + 12, true) / 10; // decimetres/second
    const lengthM = v.getUint32(off + 14, true) / 100; // centimetres
    const nameId = v.getUint16(off + 18, true);
    const nShape = v.getUint16(off + 20, true);
    off += 22;
    const shape = new Float64Array(nShape * 2);
    for (let p = 0; p < nShape; p++) {
      shape[p * 2] = v.getInt32(off, true) * E7;
      shape[p * 2 + 1] = v.getInt32(off + 4, true) * E7;
      off += 8;
    }
    edges.push({
      from,
      to,
      roadClass,
      oneway: oneway !== 0,
      maxspeed,
      speed,
      lengthM,
      name: nameId === NO_NAME || nameId >= names.length ? null : names[nameId],
      shape,
    });
  }
  return { names, nodes, edges };
}

/** The polyline an edge really follows: node, shape, node. */
export function edgePath(graph, e) {
  const out = [graph.nodes[e.from * 2], graph.nodes[e.from * 2 + 1]];
  for (let i = 0; i < e.shape.length; i++) out.push(e.shape[i]);
  out.push(graph.nodes[e.to * 2], graph.nodes[e.to * 2 + 1]);
  return out;
}

const DRAW_MAGIC = 'LPM3';

/**
 * One `LPM3` drawing tile: road polylines with the width we measured.
 *
 * `LPM2` carries class, maxspeed, name, lanes and a one-way flag and cannot
 * carry a carriageway width, so a renderer reading it has to draw every road
 * the same weight. Width is the measurement this whole corpus is built on --
 * "the pair is the carriageway, its separation is the width" -- so the map
 * that draws our roads reads this instead.
 *
 * The fourth reader of our formats, and checked against the Python writer's
 * own dump by `parser_check.mjs`: a format you have not read back has not been
 * written (E167, E169).
 */
export function readDrawTile(buffer) {
  const v = new DataView(buffer);
  if (!magic(v, 0, DRAW_MAGIC)) throw new Error('not an LPM3 tile');
  let off = 4;
  const n = v.getUint32(off, true);
  off += 4;
  const lines = [];
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
    lines.push({ roadClass, oneway, widthM, pts });
  }
  return { lines };
}
