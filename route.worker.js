// Routing, off the main thread.
//
// Ali: "is the A* pathfinding a web worker? Should it be?"
//
// It was not, and it should be, and the measurement says so rather than
// taste. A route blocked the main thread for **163 to 196 ms** in a single
// long task — decoding fifty-odd routing tiles and then running the fine
// search over them — which is three to four times the sixteen milliseconds a
// frame has and well past the fifty at which a person feels a freeze. The map
// stopped dead in the middle of the one interaction it exists for.
//
// **The worker does the whole job, not just the search.** Handing it only the
// A* would mean posting the subgraph across, and a corridor's subgraph is
// tens of thousands of nodes and edges — the transfer would cost about what
// the search does. So the worker owns the tile store, fetches, decodes,
// plans, searches, walks the legs into instructions and floods for the
// unreachable road, and posts back plain data the page can draw.
//
// It also posts every tile as it lands, because the page shows those arriving
// (`noteTile`) and that is the thing keeping somebody company while this
// runs.
//
// The engine modules are imported rather than reimplemented — the same rule
// as everywhere else in this project. `web/src/engine` is compiled beside the
// page and both threads load the same files.

import { TileStore } from './engine/store.js';
import { route as planAndRoute, search } from './engine/router.js';
import { metres } from './engine/tiles.js';

/** One store per area, kept for the life of the worker. */
const stores = new Map();

/**
 * The tiles the current journey's planned line crosses.
 *
 * **Not every tile that is fetched.** Ali: "there still seem to be a 5x5
 * generic blip when navigating." There was, and it was honest in the narrow
 * sense -- those twenty-five tiles really were fetched -- but it was not
 * telling anybody anything. The corridor is the planned line plus a square of
 * padding round each end, because the plan only reaches as far as the nearest
 * arterial and the first and last few streets are not on it. The square is a
 * guess, it is the same square on every journey, and it is drawn as a square,
 * which is why it reads as a generic wave rather than as a readout.
 *
 * So the padding is fetched silently and the line is what pings.
 */
let onPlan = new Set();

function storeFor(base, id) {
  let s = stores.get(base);
  if (!s) {
    s = new TileStore({
      baseUrl: `${base}/route`,
      maxTiles: 256,
      onTile: (level, x, y, bytes) => {
        // Only the fine level reaches the page: the coarse planning level is
        // a handful of tiles for the whole city, and reporting one of those
        // as an arrival lights up a third of Riyadh.
        if (level !== 'fine') return;
        const z = s.index && s.index.levels[level] && s.index.levels[level].zoom;
        if (typeof z === 'number') {
          // **Every tile, and which kind it is.** Ali: "i want them to
          // emanate from the artery route first off, then every tile that we
          // are downloading, then any neighboring tiles." So the page is told
          // about all of them and told which are the journey, rather than
          // being told about a filtered subset -- a readout that hides half
          // the fetching is not a readout of the fetching.
          self.postMessage({ type: 'tile', id, level, x, y, bytes, zoom: z,
                             onRoute: onPlan.has(`${x}/${y}`) });
        }
      },
    });
    stores.set(base, s);
  }
  return s;
}

/** A leg, flattened to what the page needs and nothing more. */
function legOut(graph, leg) {
  const a = graph.coords.get(leg.from);
  const b = graph.coords.get(leg.to);
  const e = leg.edge;
  const fwd = e.from === leg.from;
  const shape = fwd ? e.shape : [...e.shape].reverse();
  return {
    a, b, shape,
    classId: e.classId,
    nameId: e.nameId,
    lengthM: e.lengthM,
  };
}

/**
 * Why a journey failed, from what the search already has in hand.
 *
 * The same reasoning the page used to do, moved here because it needs the
 * subgraph and the subgraph is not leaving this thread.
 */
function diagnose(graph, from, to) {
  if (!graph) return 'The routing tiles for this area did not load.';
  const near = (p) => (graph.nearestOnEdge
    ? graph.nearestOnEdge(p[0], p[1], 8000, 1)[0] : null);
  const a = near(from);
  const b = near(to);
  const far = [];
  if (!a || a.distM > 500) {
    far.push(`the start is ${a ? Math.round(a.distM) + ' m' : 'more than 8 km'}`
      + ' from the nearest road anything can drive');
  }
  if (!b || b.distM > 500) {
    far.push(`the destination is ${b ? Math.round(b.distM) + ' m'
      : 'more than 8 km'} from the nearest road anything can drive`);
  }
  if (far.length) {
    return `No route, because ${far.join(', and ')}. The map draws service `
      + 'roads and tracks that the router will not send a vehicle down, so a '
      + 'street being visible is not the same as it being routable.';
  }
  const seen = new Set([a.edge.from, a.edge.to]);
  const stack = [a.edge.from, a.edge.to];
  while (stack.length) {
    const n = stack.pop();
    for (const e of graph.out.get(n) || []) {
      for (const nb of [e.from, e.to]) {
        if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
      }
    }
  }
  if (!seen.has(b.edge.from) && !seen.has(b.edge.to)) {
    return 'No route: both ends are on road, but the two are not connected '
      + `to each other. The piece reachable from the start holds `
      + `${seen.size.toLocaleString()} junctions; the destination is not `
      + 'among them.';
  }
  return 'No route: the two ends are connected but every path between them '
    + 'leaves the corridor that was fetched. This is the one failure the '
    + 'corridor itself can cause, and it is rare.';
}

/**
 * Road we fetched and cannot reach from where the journey starts.
 *
 * "A map that quietly hides road it cannot route on is lying to the driver."
 * The flood is over tens of thousands of edges, which is exactly the sort of
 * work that has no business on the thread drawing the map.
 */
function unreachable(graph, legs) {
  if (!graph || !legs.length) return [];
  const start = legs[0].from;
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const n = stack.pop();
    for (const e of graph.out.get(n) || []) {
      for (const nb of [e.from, e.to]) {
        if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
      }
    }
  }
  const out = [];
  const done = new Set();
  for (const list of graph.out.values()) {
    for (const e of list) {
      if (done.has(e)) continue;
      done.add(e);
      if (seen.has(e.from) || seen.has(e.to)) continue;
      const a = graph.coords.get(e.from);
      const b = graph.coords.get(e.to);
      if (a && b) out.push([a, ...e.shape, b]);
    }
  }
  return out;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type !== 'route') return;
  const { id, base, from, to, endBlocks } = m;
  try {
    const store = storeFor(base, id);
    onPlan = new Set();
    const res = await planAndRoute(store, from, to, {
      endBlocks,
      // The plan is known before a single fine tile is asked for, so the
      // artery it found can be shown travelling while they are fetched.
      onCorridor: (keys, all, planLine) => {
        onPlan = keys;
        self.postMessage({ type: 'plan', id, line: planLine || [],
                           tiles: all.length });
      },
    });
    const graph = res.graph;
    const out = {
      type: 'result',
      id,
      stats: res.stats,
      walkStartM: res.walkStartM ?? null,
      walkEndM: res.walkEndM ?? null,
      hasPlan: !!res.plan,
      classIds: (store.index && store.index.classIds) || {},
      namesPath: (store.index && store.index.names) || null,
      namesZoom: (store.index && store.index.namesZoom)
        || (store.index && store.index.levels.fine.zoom) || 14,
    };
    if (res.route) {
      out.route = {
        metres: res.route.metres,
        seconds: res.route.seconds,
        line: res.route.line,
      };
      out.legs = res.route.legs.map((l) => legOut(graph, l));
      out.unreached = unreachable(graph, res.route.legs);
      out.corridor = res.corridor;
    } else {
      out.why = diagnose(graph, from, to);
    }
    self.postMessage(out);
  } catch (err) {
    // A tile that is missing and a tile that failed are different facts, and
    // only one of them may be quiet. This is the loud one.
    self.postMessage({ type: 'error', id, message: String(err && err.message
      ? err.message : err) });
  }
};

void search;
void metres;
