/**
 * Web Mercator, tile addressing, and the LPR1 routing-tile reader.
 *
 * A port of `lp_pipeline/webmap.py` and `app/lib/routing.dart`, not a new
 * implementation. Where the phone and the browser disagree about a route, the
 * first question is which of them is wrong, and having written the arithmetic
 * twice makes that question much harder to answer.
 *
 * This is also the whole of "layer three, projection" from the brief, and the
 * whole of the spatial index. The index is the URL: a tile id is computable
 * from a coordinate in six lines, so there is nothing to build and nothing to
 * keep in sync.
 */
export const TILE_MAGIC = 'LPR1';
export function tileOf(lon, lat, zoom) {
    const n = 2 ** zoom;
    const x = Math.floor(((lon + 180) / 360) * n);
    const rad = (Math.max(Math.min(lat, 85.05), -85.05) * Math.PI) / 180;
    const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
    return [x, y];
}
/**
 * Metres between two points.
 *
 * Equirectangular rather than haversine: over a city the error is under a
 * centimetre and this is called once per edge relaxation, where it is the
 * hottest arithmetic in the router.
 */
export function metres(aLon, aLat, bLon, bLat) {
    const k = 111320 * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
    const dx = (bLon - aLon) * k;
    const dy = (bLat - aLat) * 111132;
    return Math.hypot(dx, dy);
}
/**
 * Decode one routing tile.
 *
 * Little-endian throughout, matching the writer. Coordinates arrive as
 * integers scaled by 1e7 — about a centimetre, which is far finer than the
 * geometry deserves and costs four bytes instead of eight.
 */
export function decodeTile(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < 4; i++) {
        if (bytes[i] !== TILE_MAGIC.charCodeAt(i)) {
            throw new Error(`not a ${TILE_MAGIC} tile`);
        }
    }
    let off = 4;
    const nameCount = view.getUint16(off, true);
    off += 2;
    const names = [];
    const utf8 = new TextDecoder('utf-8');
    for (let i = 0; i < nameCount; i++) {
        const len = view.getUint16(off, true);
        off += 2;
        names.push(utf8.decode(bytes.subarray(off, off + len)));
        off += len;
    }
    const nodeCount = view.getUint32(off, true);
    off += 4;
    const nodes = new Map();
    for (let i = 0; i < nodeCount; i++) {
        const id = view.getUint32(off, true);
        const lon = view.getInt32(off + 4, true) / 1e7;
        const lat = view.getInt32(off + 8, true) / 1e7;
        off += 12;
        nodes.set(id, [lon, lat]);
    }
    const edgeCount = view.getUint32(off, true);
    off += 4;
    const edges = new Array(edgeCount);
    for (let i = 0; i < edgeCount; i++) {
        const from = view.getUint32(off, true);
        const to = view.getUint32(off + 4, true);
        const classId = view.getUint8(off + 8);
        const oneway = view.getUint8(off + 9) === 1;
        const maxspeedKph = view.getUint16(off + 10, true);
        const speedTenths = view.getUint16(off + 12, true);
        const lengthCm = view.getUint32(off + 14, true);
        const nameId = view.getUint16(off + 18, true);
        const shapeCount = view.getUint16(off + 20, true);
        off += 22;
        const shape = new Array(shapeCount);
        for (let s = 0; s < shapeCount; s++) {
            shape[s] = [
                view.getInt32(off, true) / 1e7,
                view.getInt32(off + 4, true) / 1e7,
            ];
            off += 8;
        }
        edges[i] = {
            from, to, classId, oneway, maxspeedKph,
            // Zero means nothing was observed. Walking pace makes the edge
            // unattractive without making it unusable, which matters when it is the
            // only way to a destination — the same rule the phone's router uses.
            speedMps: speedTenths > 5 ? speedTenths / 10 : 1.4,
            lengthM: lengthCm / 100,
            nameId,
            shape,
        };
    }
    return { nodes, edges, names };
}
/** Seconds to traverse an edge, from observed speed. */
export function edgeSeconds(e) {
    return e.lengthM / e.speedMps;
}
/**
 * Seconds lost at a junction.
 *
 * Without it a route with twenty turns and one with two look identical at
 * equal length, and the twenty-turn one usually wins on a few metres. Same
 * value as the pipeline's `JUNCTION_PENALTY_S` and the phone's.
 */
export const JUNCTION_PENALTY_S = 8;
