/**
 * Routing in the browser: plan on the coarse level, then route on the fine.
 *
 * Bjorn: "The artery route is not what should be used as the final route. It
 * should only be used in order to know which tiles to download on a more
 * detailed level."
 *
 * So there are two searches and they do different jobs. The coarse one is a
 * *planner* whose output is a list of tiles; the fine one produces the route
 * anyone actually drives. Measured over ten cross-town journeys, the corridor
 * that falls out of the coarse plan never excludes the optimal fine path —
 * detour is zero at the mean and at the worst case, with no margin ring.
 *
 * That has a consequence worth stating, because it removes the hard part of
 * tiled routing: **the fine tile set is known before the fine search starts.**
 * A search that discovers its tiles as it goes has to suspend mid-expansion
 * and resume without either deadlocking or quietly settling a node whose edges
 * had not arrived. Planning first means that situation never arises, and the
 * fine A* below is ordinary synchronous code over data already in hand.
 */
import { JUNCTION_PENALTY_S, edgeSeconds, metres, tileOf, } from './tiles.js';
/** A minimal binary heap. The browser has no priority queue either. */
class Heap {
    constructor() {
        this.items = [];
        this.keys = [];
    }
    get size() { return this.items.length; }
    // Indices here are in range by construction, so the non-null assertions are
    // the honest expression of an invariant the compiler cannot see, rather than
    // a way of switching the check off.
    push(item, key) {
        this.items.push(item);
        this.keys.push(key);
        let i = this.items.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.keys[parent] <= this.keys[i])
                break;
            this.swap(i, parent);
            i = parent;
        }
    }
    pop() {
        if (!this.items.length)
            return undefined;
        const top = this.items[0];
        const lastItem = this.items.pop();
        const lastKey = this.keys.pop();
        if (this.items.length) {
            this.items[0] = lastItem;
            this.keys[0] = lastKey;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let small = i;
                if (l < this.keys.length && this.keys[l] < this.keys[small])
                    small = l;
                if (r < this.keys.length && this.keys[r] < this.keys[small])
                    small = r;
                if (small === i)
                    break;
                this.swap(i, small);
                i = small;
            }
        }
        return top;
    }
    swap(a, b) {
        const ti = this.items[a];
        this.items[a] = this.items[b];
        this.items[b] = ti;
        const tk = this.keys[a];
        this.keys[a] = this.keys[b];
        this.keys[b] = tk;
    }
}
/** Nodes and their edges, assembled from whichever tiles were fetched. */
export class Subgraph {
    constructor() {
        this.coords = new Map();
        this.out = new Map();
        this.names = [];
        this.nextVirtual = -1;
    }
    add(tile) {
        for (const [id, pos] of tile.nodes) {
            if (!this.coords.has(id))
                this.coords.set(id, pos);
        }
        for (const e of tile.edges) {
            this.link(e.from, e);
            // A two-way edge is usable from either end. One-ways are stored in the
            // direction their geometry runs, which is the convention the exporter
            // and the phone both follow.
            if (!e.oneway)
                this.link(e.to, e);
        }
    }
    link(node, e) {
        const list = this.out.get(node);
        if (list)
            list.push(e);
        else
            this.out.set(node, [e]);
    }
    /**
     * The nearest node to a point.
     *
     * Linear over the subgraph, which is a few thousand nodes rather than the
     * city's 159,228 — one more thing the tiling makes cheap enough not to
     * index.
     */
    nearest(lon, lat, withinM = 500) {
        let best = null;
        let bestD = withinM;
        for (const [id, [nlon, nlat]] of this.coords) {
            const d = metres(lon, lat, nlon, nlat);
            if (d < bestD) {
                bestD = d;
                best = id;
            }
        }
        return best;
    }
    /**
     * Where a point joins the road, as a point ON an edge rather than a vertex.
     *
     * `nearest` above offers a VERTEX, and E358 measured what that costs: the
     * app put a driver **32.1 m** from a road the corpus has at 2.6 m, because
     * the edges run to a median of 30 m and the nearest vertex is up to half an
     * edge away. E370 confirmed that densifying the graph to a vertex every 10 m
     * fixes the distance, and E373 then found that densifying breaks the k
     * mechanism, because the k nearest candidates collapse into k vertices of
     * one edge.
     *
     * Splitting at the snap point gets the distance without either cost. No new
     * geometry is published, no node is renumbered (E151), and the graph on disk
     * is untouched — the split lives for the length of one query.
     *
     * Candidates are grouped by `nameId` before `k` is counted, which is E373's
     * rule as code: **k means k distinct roads, never k vertices.**
     */
    nearestOnEdge(lon, lat, withinM = 500, k = 8) {
        const byRoad = new Map();
        const seen = new Set();
        for (const list of this.out.values()) {
            for (const e of list) {
                if (seen.has(e))
                    continue;
                seen.add(e);
                const a = this.coords.get(e.from);
                const b = this.coords.get(e.to);
                if (!a || !b)
                    continue;
                const pts = [a, ...e.shape, b];
                let run = 0;
                let best = null;
                for (let i = 0; i + 1 < pts.length; i++) {
                    const [ax, ay] = pts[i];
                    const [bx, by] = pts[i + 1];
                    const kx = 111320 * Math.cos((ay * Math.PI) / 180);
                    const dx = (bx - ax) * kx;
                    const dy = (by - ay) * 111132;
                    const px = (lon - ax) * kx;
                    const py = (lat - ay) * 111132;
                    const d2 = dx * dx + dy * dy;
                    const t = d2 <= 1e-12 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / d2));
                    const d = Math.hypot(px - t * dx, py - t * dy);
                    const segLen = Math.hypot(dx, dy);
                    if (!best || d < best.d) {
                        best = {
                            d,
                            p: [ax + (bx - ax) * t, ay + (by - ay) * t],
                            along: run + segLen * t,
                        };
                    }
                    run += segLen;
                }
                if (!best || best.d > withinM)
                    continue;
                // The edge's own recorded length is what the cost model uses, so the
                // split is scaled to it rather than to the sum of its segments.
                const alongM = run > 0 ? (best.along / run) * e.lengthM : 0;
                const cur = byRoad.get(e.nameId);
                if (!cur || best.d < cur.distM) {
                    byRoad.set(e.nameId, { edge: e, distM: best.d, point: best.p, alongM });
                }
            }
        }
        return [...byRoad.values()].sort((x, y) => x.distM - y.distM).slice(0, k);
    }
    /**
     * Split an edge at a point and return the temporary node sitting there.
     *
     * The original edge is left in place, so through traffic is unaffected and
     * the two halves are simply extra ways to enter and leave at the snap point.
     * Ids are negative so they cannot collide with the global node ids the tiles
     * carry.
     */
    splitAt(cand) {
        const id = this.nextVirtual--;
        this.coords.set(id, cand.point);
        const e = cand.edge;
        const behind = Math.max(0.01, cand.alongM);
        const ahead = Math.max(0.01, e.lengthM - cand.alongM);
        const half = (from, to, lengthM) => ({
            from, to, classId: e.classId, oneway: e.oneway,
            maxspeedKph: e.maxspeedKph, speedMps: e.speedMps, lengthM,
            nameId: e.nameId, shape: [],
        });
        const first = half(e.from, id, behind);
        const second = half(id, e.to, ahead);
        this.link(first.from, first);
        if (!first.oneway)
            this.link(first.to, first);
        this.link(second.from, second);
        if (!second.oneway)
            this.link(second.to, second);
        // Leaving the split point forward is `second`, already linked at its own
        // `from`. Leaving it backward along `first` is only legal when the edge is
        // two-way, which the `!oneway` link above is exactly what arranges — so
        // there is nothing further to add here, and adding it would offer the
        // router a one-way edge against its own direction.
        return id;
    }
}
/**
 * A*, over a subgraph already in memory.
 *
 * The heuristic is straight-line time at 120 km/h — the fastest anything here
 * travels — so it never exceeds the true remaining cost and the search stays
 * admissible. An inadmissible heuristic would be faster and would sometimes
 * return a route that is not the best one, which is the kind of wrong that
 * nobody notices until they know the city better than the map.
 */
export function search(graph, start, goal) {
    if (start === goal)
        return null;
    const goalPos = graph.coords.get(goal);
    const startPos = graph.coords.get(start);
    if (!goalPos || !startPos)
        return null;
    const h = (node) => {
        const p = graph.coords.get(node);
        if (!p)
            return 0;
        return metres(p[0], p[1], goalPos[0], goalPos[1]) / 33.3;
    };
    const best = new Map([[start, 0]]);
    const cameEdge = new Map();
    const cameNode = new Map();
    const arrivedBy = new Map();
    const settled = new Set();
    const open = new Heap();
    open.push(start, h(start));
    while (open.size) {
        const node = open.pop();
        if (settled.has(node))
            continue;
        settled.add(node);
        if (node === goal)
            break;
        for (const e of graph.out.get(node) ?? []) {
            const next = e.from === node ? e.to : e.from;
            if (e.oneway && e.from !== node)
                continue;
            if (!graph.coords.has(next))
                continue;
            let cost = edgeSeconds(e);
            const prev = arrivedBy.get(node);
            // Charged on a change of road, not at every junction: going straight on
            // through a crossroads costs nothing, and charging it would make a
            // straight route look as expensive as a zigzag.
            if (prev && prev.nameId !== e.nameId)
                cost += JUNCTION_PENALTY_S;
            const tentative = (best.get(node) ?? Infinity) + cost;
            if (tentative < (best.get(next) ?? Infinity)) {
                best.set(next, tentative);
                cameEdge.set(next, e);
                cameNode.set(next, node);
                arrivedBy.set(next, e);
                open.push(next, tentative + h(next));
            }
        }
    }
    if (!settled.has(goal))
        return null;
    const legs = [];
    let cur = goal;
    while (cur !== start) {
        const e = cameEdge.get(cur);
        const from = cameNode.get(cur);
        if (e === undefined || from === undefined)
            return null;
        legs.push({ edge: e, from, to: cur });
        cur = from;
    }
    legs.reverse();
    const line = [];
    for (const leg of legs) {
        const a = graph.coords.get(leg.from);
        const b = graph.coords.get(leg.to);
        // Stored geometry always runs from the edge's own `from`; a leg driven
        // the other way has to be reversed or the drawn line zigzags.
        const forward = leg.edge.from === leg.from;
        const pts = [a, ...(forward
                ? leg.edge.shape
                : [...leg.edge.shape].reverse()), b];
        for (const p of pts) {
            const last = line[line.length - 1];
            if (!last || last[0] !== p[0] || last[1] !== p[1])
                line.push(p);
        }
    }
    return {
        legs,
        seconds: best.get(goal) ?? 0,
        metres: legs.reduce((s, l) => s + l.edge.lengthM, 0),
        line,
    };
}
export async function route(store, from, to, opts = {}) {
    const index = await store.load();
    const coarse = index.levels['coarse'];
    const fine = index.levels['fine'];
    if (!coarse || !fine) {
        // An index without both levels is a build that went wrong, and saying so
        // here is far cheaper than a route that silently comes back empty.
        throw new Error('index.json is missing a coarse or fine level');
    }
    const t0 = performance.now();
    // --- plan ---------------------------------------------------------------
    // The coarse level is seven tiles for the whole city, so the ones spanning
    // the journey's bounding box are fetched outright rather than discovered.
    // This is the one place a search could still escape its tiles, and the
    // fallback is simply to have fetched them all.
    const coarseKeys = [];
    const [cx0, cy0] = tileOf(Math.min(from[0], to[0]), Math.max(from[1], to[1]), coarse.zoom);
    const [cx1, cy1] = tileOf(Math.max(from[0], to[0]), Math.min(from[1], to[1]), coarse.zoom);
    for (let x = cx0 - 1; x <= cx1 + 1; x++) {
        for (let y = cy0 - 1; y <= cy1 + 1; y++)
            coarseKeys.push([x, y]);
    }
    const coarseTiles = await store.tiles('coarse', store.present('coarse', coarseKeys));
    const planGraph = new Subgraph();
    for (const tile of coarseTiles.values())
        planGraph.add(tile);
    // A generous snap radius, because the coarse level has no residential
    // streets and an address is rarely on an arterial.
    const planFrom = planGraph.nearest(from[0], from[1], 4000);
    const planTo = planGraph.nearest(to[0], to[1], 4000);
    const plan = planFrom !== null && planTo !== null
        ? search(planGraph, planFrom, planTo)
        : null;
    const planMs = performance.now() - t0;
    // --- corridor -----------------------------------------------------------
    const corridor = new Map();
    const want = (lon, lat) => {
        const [x, y] = tileOf(lon, lat, fine.zoom);
        corridor.set(`${x}/${y}`, [x, y]);
    };
    want(from[0], from[1]);
    want(to[0], to[1]);
    if (plan)
        for (const p of plan.line)
            want(p[0], p[1]);
    // **Which tiles are the journey, and which are its neighbourhood.**
    // Everything above is ground the plan actually crosses. The caller is told
    // the difference because the two mean different things to somebody
    // watching: one is where they are going and the other is insurance.
    const onPlan = new Set(corridor.keys());
    // The ends need their neighbourhood, since the plan only reaches as far as
    // the nearest arterial and the first and last few streets are not on it.
    //
    // **A DISC, not a square.** Ali, on watching it load: "no 5x5 thing." A
    // block of twenty-five tiles is a shape the ground does not have -- it is
    // the same square on every journey whatever the street layout, it reaches
    // 1.41 times further diagonally than it does along an axis for no reason
    // anybody could state, and it is instantly recognisable as an artefact of
    // the program rather than a fact about the city. A radius is the thing
    // actually meant: everything within so many tiles of the end.
    const blocks = opts.endBlocks ?? 2;
    const radius = opts.endRadius ?? blocks + 0.5;
    const reach = Math.ceil(radius);
    for (const [lon, lat] of [from, to]) {
        const [x, y] = tileOf(lon, lat, fine.zoom);
        for (let dx = -reach; dx <= reach; dx++) {
            for (let dy = -reach; dy <= reach; dy++) {
                if (Math.hypot(dx, dy) > radius)
                    continue;
                corridor.set(`${x + dx}/${y + dy}`, [x + dx, y + dy]);
            }
        }
    }
    const t1 = performance.now();
    const wanted = [...corridor.values()];
    opts.onCorridor?.(onPlan, wanted, plan ? plan.line : null);
    const fineTiles = await store.tiles('fine', store.present('fine', wanted));
    const graph = new Subgraph();
    for (const tile of fineTiles.values())
        graph.add(tile);
    // Snap onto the road rather than onto a vertex, and split there. E358
    // measured the vertex snap putting a driver 32.1 m from a road we have at
    // 2.6 m; the split costs one temporary node per end and no published
    // geometry at all. If nothing is within reach, fall back to the vertex snap
    // rather than refusing — a far snap is a worse answer, not no answer.
    const snapA = graph.nearestOnEdge(from[0], from[1], 500)[0];
    const snapB = graph.nearestOnEdge(to[0], to[1], 500)[0];
    const a = snapA ? graph.splitAt(snapA) : graph.nearest(from[0], from[1]);
    const b = snapB ? graph.splitAt(snapB) : graph.nearest(to[0], to[1]);
    const finalRoute = a !== null && b !== null ? search(graph, a, b) : null;
    const routeMs = performance.now() - t1;
    const s = store.stats();
    return {
        route: finalRoute,
        plan,
        graph,
        // The walk at each end. E354 names this as the real cost of trying more
        // than one candidate, and the distance past which "there is a route" is
        // the worse answer is Ali's to set — so it is reported, never hidden.
        walkStartM: snapA ? Math.round(snapA.distM * 10) / 10 : null,
        walkEndM: snapB ? Math.round(snapB.distM * 10) / 10 : null,
        corridor: wanted,
        stats: {
            coarseTiles: coarseTiles.size,
            fineTiles: fineTiles.size,
            corridorTiles: wanted.length,
            requests: s.requests,
            skipped: s.skipped,
            retries: s.retries,
            kilobytes: s.kilobytes,
            planMs: Math.round(planMs),
            routeMs: Math.round(routeMs),
        },
    };
}
