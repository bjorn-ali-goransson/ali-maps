/**
 * Fetching routing tiles from object storage, and not fetching them twice.
 *
 * There is no server here. A tile is a static file behind a CDN, so the only
 * things this has to get right are the ones a server would otherwise handle:
 * not issuing the same request twice, not holding the whole city in memory,
 * and knowing the difference between a tile that is missing and a request that
 * failed.
 *
 * That last one is not a nicety. The first version treated both as "absent",
 * and the first real measurement against a real HTTP server showed what that
 * costs: a 35 km cross-town journey asked for 57 corridor tiles, 23 of the
 * fetches failed under load, every one was recorded as empty desert, and the
 * router — given a graph with holes in it and no way to know — reported no
 * route at all. The server's log had served all but seven. A silent hole in
 * the graph is the worst failure this design can have, because it looks
 * exactly like a correct answer about a city where you cannot get there from
 * here.
 */
import { decodeTile, tileOf } from './tiles.js';
/** A tile that exists and could not be fetched. Never silently swallowed. */
export class TileFetchError extends Error {
    constructor(key, attempts, cause) {
        super(`tile ${key} failed after ${attempts} attempts: ${String(cause)}`);
        this.key = key;
        this.attempts = attempts;
        this.cause = cause;
        this.name = 'TileFetchError';
    }
}
export class TileStore {
    constructor(opts) {
        this.cache = new Map();
        /**
         * Requests already in flight, so two searches wanting the same tile make
         * one request. Without this a corridor and its neighbour routinely fetch
         * the same boundary tile twice, and the CDN is not the thing being
         * protected — the round trip is.
         */
        this.inFlight = new Map();
        /**
         * Which tiles exist, straight from the index.
         *
         * The export already lists every tile it wrote, so a tile outside that list
         * is known-absent before any request is made. This is not an optimisation of
         * the 404 — it is the removal of it. In the first measured run, 30 of 66
         * requests were for tiles the index could have said were not there.
         */
        this.exists = new Map();
        this.active = 0;
        this.queue = [];
        this.index = null;
        this.bytesFetched = 0;
        this.requests = 0;
        this.retries = 0;
        /** Requests not made, because the index said there was nothing to fetch. */
        this.skipped = 0;
        this.base = opts.baseUrl.replace(/\/$/, '');
        this.maxTiles = opts.maxTiles ?? 256;
        this.concurrency = opts.concurrency ?? 6;
        this.attempts = opts.attempts ?? 3;
        this.onTile = opts.onTile;
    }
    async load() {
        if (this.index)
            return this.index;
        const res = await fetch(`${this.base}/index.json`);
        if (!res.ok)
            throw new Error(`no index.json at ${this.base}`);
        const index = (await res.json());
        for (const [level, info] of Object.entries(index.levels)) {
            this.exists.set(level, new Set(info.tiles.map(([x, y]) => `${x}/${y}`)));
        }
        this.index = index;
        return index;
    }
    key(level, x, y) {
        return `${level}/${x}/${y}`;
    }
    url(level, x, y) {
        const info = this.index?.levels[level];
        if (!info)
            throw new Error(`unknown level ${level}`);
        return `${this.base}/${info.path
            .replace('{x}', String(x))
            .replace('{y}', String(y))}`;
    }
    /** Run `job` once a slot is free. */
    async slot(job) {
        if (this.active >= this.concurrency) {
            await new Promise((resolve) => this.queue.push(resolve));
        }
        this.active += 1;
        try {
            return await job();
        }
        finally {
            this.active -= 1;
            this.queue.shift()?.();
        }
    }
    /**
     * One tile, from cache or from storage.
     *
     * Null means the tile genuinely is not there — the index did not list it, or
     * storage returned 404. Anything else throws, because the caller is building
     * a graph and needs to know it is incomplete.
     */
    async tile(level, x, y) {
        const key = this.key(level, x, y);
        const hit = this.cache.get(key);
        if (hit) {
            // Refresh recency: Map preserves insertion order, so deleting and
            // re-setting is the whole of the LRU.
            this.cache.delete(key);
            this.cache.set(key, hit);
            return hit;
        }
        const known = this.exists.get(level);
        if (known && !known.has(`${x}/${y}`)) {
            this.skipped += 1;
            return null;
        }
        const flying = this.inFlight.get(key);
        if (flying)
            return flying;
        const job = this.slot(async () => {
            let lastError = null;
            for (let attempt = 1; attempt <= this.attempts; attempt++) {
                try {
                    this.requests += 1;
                    const res = await fetch(this.url(level, x, y));
                    // A 404 is an answer, not a failure: it is storage saying the tile
                    // was never written. Retrying it would only be slower.
                    if (res.status === 404)
                        return null;
                    if (!res.ok)
                        throw new Error(`HTTP ${res.status}`);
                    const buf = await res.arrayBuffer();
                    const tile = decodeTile(buf);
                    this.bytesFetched += buf.byteLength;
                    this.cache.set(key, tile);
                    try {
                        this.onTile?.(level, x, y, buf.byteLength);
                    }
                    catch { /* a
                      decoration must never break a fetch */
                    }
                    while (this.cache.size > this.maxTiles) {
                        const oldest = this.cache.keys().next().value;
                        if (oldest === undefined)
                            break;
                        this.cache.delete(oldest);
                    }
                    return tile;
                }
                catch (err) {
                    lastError = err;
                    if (attempt < this.attempts) {
                        this.retries += 1;
                        // Backing off at all is the point; the exact curve is not load
                        // bearing, and a dropped socket clears in tens of milliseconds.
                        await new Promise((r) => setTimeout(r, 40 * 2 ** (attempt - 1)));
                    }
                }
            }
            throw new TileFetchError(key, this.attempts, lastError);
        }).finally(() => {
            this.inFlight.delete(key);
        });
        this.inFlight.set(key, job);
        return job;
    }
    /**
     * Several tiles at once.
     *
     * The corridor is known before the fine search starts, so its tiles are
     * fetched together rather than discovered one round trip at a time. This is
     * the practical payoff of planning first — but "together" means six at a
     * time, not fifty-seven: handing the whole corridor to the connection pool
     * at once is how the silent holes got in.
     */
    async tiles(level, keys) {
        const got = await Promise.all(keys.map(([x, y]) => this.tile(level, x, y).then((t) => [this.key(level, x, y), t])));
        const out = new Map();
        for (const [key, tile] of got)
            if (tile)
                out.set(key, tile);
        return out;
    }
    tileFor(lon, lat, level) {
        const info = this.index?.levels[level];
        if (!info)
            throw new Error(`unknown level ${level}`);
        return tileOf(lon, lat, info.zoom);
    }
    /** Which of these tiles the index says exist. */
    present(level, keys) {
        const known = this.exists.get(level);
        if (!known)
            return keys;
        return keys.filter(([x, y]) => known.has(`${x}/${y}`));
    }
    stats() {
        return {
            cached: this.cache.size,
            requests: this.requests,
            retries: this.retries,
            skipped: this.skipped,
            kilobytes: Math.round(this.bytesFetched / 1024),
        };
    }
}
