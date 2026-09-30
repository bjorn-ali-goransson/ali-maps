// What is allowed on screen, and when.
//
// **This is the whole of the tile engine's decision-making, and it is pure.**
// No canvas, no DOM, no clock of its own -- `now` is passed in. The renderer
// supplies geometry (which tiles a view needs) and does the drawing; this
// decides what may be drawn and at what opacity, and nothing else.
//
// Ali asked for the rewrite and named the model: *"when zooming out to a new
// layer, then that layer will form a new queue. And all of those initial
// tiles must be loaded before that layer is allowed to be rendered and it's
// supposed to be fading in. When you pan, we will queue other tiles. That
// queue will not be blocking but rather streaming."*
//
// What it replaced had grown to 686 lines, eighteen functions, six per-level
// state fields, twenty-one per-tile fields and eight independent conditions
// gating a draw -- with THREE separate answers to "what do I show when the
// wanted thing is not ready". Every bug in the four rounds before this one
// was in the seams between them and not in any single rule: a gate that
// returned before recording the state another pass read, a fallback that
// reported success on a patch so the pass below it never ran, an ancestor
// walk that climbed coarser when a zoom out needs finer, a dissolve with
// nothing to dissolve from, and a coverage pass that was wrong unbounded and
// wrong bounded. Six bugs, no wrong rules.
//
// ## The model
//
// A **layer** is one (level, octave). It has three states and no others:
//
//   * `building` -- nothing of it is drawn.
//   * `live`     -- drawn, fading in once over whatever it replaced.
//   * `retired`  -- drawn UNDERNEATH its replacement until that fade ends.
//
// Two queues, and **which one a tile joins is decided once, when it is first
// asked for**, rather than re-derived every frame from the current zoom --
// which is the thing that kept going wrong:
//
//   * the **blocking** set is the tiles the view needed when the layer was
//     created. The layer goes live when every one of them is done, and not
//     before. That is a zoom.
//   * anything wanted afterwards joins the **streaming** set. It is drawn the
//     moment it lands, fading in on its own, and it gates nothing. That is a
//     pan.
//
// ## The one rule that replaces six conditions
//
// **A live layer is never taken away until another is live.** Not when the
// zoom changes, not when its octave is stale, not when its tiles are the
// wrong size for the view -- only when a replacement has actually arrived.
// Ali's sentence, *"we should not fade out any tiles unless new tiles have
// taken their place"*, stated once and structurally instead of six times as
// conditions that disagreed with each other.
//
// A building layer, by contrast, is free: it may be abandoned at any moment,
// because nothing of it is on screen.

export const BUILDING = 'building';
export const LIVE = 'live';
export const RETIRED = 'retired';

/** Cubic in-out. Ali: "all fading should have easing". */
export const ease = (t) => (t < 0.5
  ? 4 * t * t * t
  : 1 - Math.pow(-2 * t + 2, 3) / 2);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class LayerSet {
  /**
   * @param {object} [opts]
   * @param {number} [opts.fadeMs]      how long a new layer takes to arrive
   * @param {number} [opts.tileFadeMs]  how long one streamed tile takes
   * @param {number} [opts.maxRetired]  retired layers kept per level
   */
  constructor(opts = {}) {
    this.fadeMs = opts.fadeMs ?? 420;
    this.tileFadeMs = opts.tileFadeMs ?? 200;
    // **Two, at Ali's call.** One is what the model needs: a retired layer
    // exists only for the length of a fade, and a fade only starts when a
    // replacement is live, so the case that looks like it needs more -- a
    // flick across four octaves -- does not, since those intermediate layers
    // never go live and the layer from before the flick is still LIVE. The
    // second is slack for a zoom that reverses mid-fade, and it costs one
    // layer of canvas.
    this.maxRetired = opts.maxRetired ?? 2;
    /** @type {Map<string, object>} every layer, by `level|oct`. */
    this.layers = new Map();
    /** @type {Map<string, object>} per level: live, building, retired[]. */
    this.levels = new Map();
  }

  // ------------------------------------------------------------- internals

  _level(name) {
    let L = this.levels.get(name);
    if (!L) this.levels.set(name, (L = { live: null, building: null, retired: [] }));
    return L;
  }

  _layer(name, oct) {
    return this.layers.get(`${name}|${oct}`);
  }

  _make(name, oct, keys, now) {
    const layer = {
      id: `${name}|${oct}`,
      level: name,
      oct,
      state: BUILDING,
      blocking: new Set(keys),
      streaming: new Set(),
      done: new Map(),                 // key -> the time it finished
      liveAt: 0,
      retiredAt: 0,
      bornAt: now,
    };
    this.layers.set(layer.id, layer);
    return layer;
  }

  _forget(layer) {
    this.layers.delete(layer.id);
    const L = this._level(layer.level);
    if (L.live === layer) L.live = null;
    if (L.building === layer) L.building = null;
    L.retired = L.retired.filter((x) => x !== layer);
  }

  // ------------------------------------------------------------------- api

  /**
   * Say what the view needs from a level right now.
   *
   * Returns the tiles that are not yet done, split by queue, in the order
   * they should be worked on: blocking first, because a layer cannot appear
   * until all of them are in.
   */
  want(name, oct, keys, now) {
    const L = this._level(name);
    let layer = this._layer(name, oct);

    if (!layer) {
      // **A building layer for a different octave is abandoned, not kept.**
      // Nothing of it is on screen, so there is nothing to protect, and
      // keeping it would mean a fast zoom accumulates half-built layers that
      // each take a share of the rasterising budget.
      if (L.building && L.building.oct !== oct) {
        this._forget(L.building);
        L.building = null;
      }
      if (L.live && L.live.oct === oct) {
        layer = L.live;                       // back at a live octave
      } else {
        layer = this._make(name, oct, keys, now);
        L.building = layer;
      }
    }

    if (layer.state === LIVE || layer.state === RETIRED) {
      // Live already: anything new is a pan, and a pan never blocks.
      for (const k of keys) {
        if (!layer.blocking.has(k) && !layer.done.has(k)) layer.streaming.add(k);
      }
    } else {
      // Still building. Tiles the view has drifted onto since it was created
      // join the STREAMING set, not the blocking one: a pan during a zoom
      // must not push the reveal further away every time the finger moves.
      for (const k of keys) {
        if (!layer.blocking.has(k) && !layer.done.has(k)) layer.streaming.add(k);
      }
    }

    const pending = (set) => [...set].filter((k) => !layer.done.has(k));
    return {
      layer: layer.id,
      state: layer.state,
      blocking: layer.state === BUILDING ? pending(layer.blocking) : [],
      streaming: pending(layer.streaming),
    };
  }

  /** A tile finished rasterising. */
  tileDone(name, oct, key, now) {
    const layer = this._layer(name, oct);
    if (!layer) return false;
    layer.done.set(key, now);
    layer.streaming.delete(key);
    return this._promote(layer, now);
  }

  /**
   * A layer goes live on its FIRST tile, and the rest stream in over it.
   *
   * **Ali retracted the blocking rule, 2026-09-27**: *"the tile engine is very
   * unstable. Lets retract the rule 'dont fade out until the new layer is
   * fully loaded'."* This is where that rule lived -- one line, refusing to
   * promote until every blocking key had landed.
   *
   * What it bought was a clean single-clock arrival; what it cost is what Ali
   * has been looking at. Twenty-five tiles have to be rasterised before ANY of
   * them is allowed on the glass, so a zoom on a slow connection shows the old
   * octave, frozen, for as long as the slowest tile takes -- and if one tile is
   * late or a refresh is orphaned, the layer never arrives at all. **A gate
   * that holds back finished work is only as good as its worst tile.**
   *
   * So the gate is gone. A finished tile is drawn as soon as it exists, fading
   * in on its own (`plan` already gives a streamed tile its own alpha), and
   * the tiles that had not landed when the layer went live are MOVED into the
   * streaming set so they get that treatment rather than popping in at full
   * strength.
   *
   * The one rule that stays is the other half, and it is the half that stops a
   * black screen: **a live layer is never taken away until another is live**,
   * and the layer it replaces is held underneath until the replacement has
   * nothing left to stream.
   */
  _promote(layer, now) {
    if (layer.state !== BUILDING) return false;
    if (!layer.done.size) return false;      // nothing to show is not a layer

    // Whatever has not arrived yet is now late, not blocking: it lands on a
    // layer that is already on screen, which is exactly what streaming means.
    for (const k of [...layer.blocking]) {
      if (!layer.done.has(k)) {
        layer.blocking.delete(k);
        layer.streaming.add(k);
      }
    }

    const L = this._level(layer.level);
    const old = L.live;
    layer.state = LIVE;
    // **No fade when there is nothing to fade from.** A dissolve over an
    // empty screen is a fade up from black, which is the flash this engine
    // exists to avoid -- and it is how the flash came back the last time,
    // through the door marked "fix the flash".
    layer.liveAt = old ? now : now - this.fadeMs;
    L.live = layer;
    if (L.building === layer) L.building = null;

    if (old && old !== layer) {
      old.state = RETIRED;
      old.retiredAt = now;
      L.retired.unshift(old);
      while (L.retired.length > this.maxRetired) {
        this._forget(L.retired.pop());
      }
    }
    return true;
  }

  /**
   * What to draw for a level, back to front, or null if it has nothing.
   *
   * `backdrop` is what is underneath and on its way out; `front` is the live
   * layer. Tiles carry their own alpha so a streamed one can fade in while
   * the rest of the layer sits at full strength.
   */
  plan(name, now, covered = true) {
    const L = this.levels.get(name);
    if (!L || !L.live) return null;
    const live = L.live;
    const t = clamp01((now - live.liveAt) / this.fadeMs);
    const frontAlpha = ease(t);

    // **A retired layer is held until its replacement COVERS THE VIEW**, not
    // merely until the fade clock runs out. With the blocking gate gone a
    // layer goes live on one tile of twenty-five, so dropping the backdrop on
    // the timer punches twenty-four holes in the map -- the blackout this
    // engine was rewritten to remove, arriving through the door marked "show
    // tiles sooner". Measured across the z9.36 boundary, twelve consecutive
    // frames at 35-45% of the settled ink with nothing underneath them,
    // because at the coarsest level there is no coarser level to fall back to
    // and the octave being left is the only picture of that ground in hand.
    //
    // `covered` comes from the painter, which is the only thing that knows
    // what the view needs; this module deliberately has no viewport. Nothing
    // is WITHHELD by it -- the new tiles are drawn the moment they exist, on
    // top -- so the rule Ali retracted stays retracted. This is the other
    // half, which was never the complaint: do not throw away a picture until
    // there is one to put in its place.
    if (t >= 1 && covered && L.retired.length) {
      for (const r of L.retired.splice(0)) this._forget(r);
    }

    const tilesOf = (layer, fade) => [...layer.done.entries()].map(
      ([key, at]) => ({
        key,
        oct: layer.oct,
        // A tile that arrived with its layer has no fade of its own -- the
        // layer's fade is its fade. A streamed one has landed on a layer
        // already on screen, so it fades alone.
        alpha: fade && !layer.blocking.has(key)
          ? ease(clamp01((now - at) / this.tileFadeMs))
          : 1,
      }));

    return {
      backdrop: L.retired.map((r) => ({
        oct: r.oct,
        alpha: 1,                 // held, not faded out: see `fading` below
        tiles: tilesOf(r, false),
      })),
      front: { oct: live.oct, alpha: frontAlpha, tiles: tilesOf(live, true) },
      fading: t < 1,
    };
  }

  /**
   * A finished tile's pixels were thrown away by the cache.
   *
   * **Without this, an evicted tile is a permanent hole.** Ali, after zooming
   * in and back out: every empty square said "waiting, never started, NOT IN
   * QUEUE" with the cache at 109/110 MB. The cache had dropped the tiles, but
   * the layer still listed them as done, so `want` never asked for them
   * again -- and the fresh, empty record made in their place was never
   * queued by anyone. Forgetting the key makes `want` return it as streaming
   * the next time the view needs it.
   */
  tileLost(name, oct, key) {
    const layer = this._layer(name, oct);
    if (!layer) return false;
    // A live layer only ever asks for STREAMING keys, and promotion left the
    // tiles that were already done in `blocking`. Left there, a lost one is
    // pending in a set nobody reads: measured, `wide|13|902|-530` stuck at
    // "blocking, not done" on a live layer for as long as the page was open.
    if (layer.state !== BUILDING) layer.blocking.delete(key);
    return layer.done.delete(key);
  }

  /** Every layer this level is holding, for eviction and for tests. */
  held(name) {
    const L = this.levels.get(name);
    if (!L) return [];
    return [L.live, L.building, ...L.retired].filter(Boolean);
  }

  /** Every tile key the set is relying on right now. */
  liveKeys() {
    const out = new Set();
    for (const layer of this.layers.values()) {
      for (const k of layer.done.keys()) out.add(`${layer.id}|${k}`);
    }
    return out;
  }

  /** Drop everything, for a theme change or a flavour change. */
  clear() {
    this.layers.clear();
    this.levels.clear();
  }
}
