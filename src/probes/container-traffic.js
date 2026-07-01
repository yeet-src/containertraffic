// Data layer — the ONLY BPF-aware module besides probe.js. Subscribes to the
// http_event ring buffer ONCE and rolls every request into the shapes the
// views read. Many views, one subscription (the redissnoop refcount pattern):
// each published signal is a from() that refcounts the shared ring sub up on
// first watch and tears it down on last unwatch. A window timer republishes
// the rolled-up snapshots, so we re-render once per frame, not per event.
import { RingBuf } from "yeet:bpf";
import { from } from "yeet:tui";
import { _ } from "yeet:helpers";
import { control } from "@/probes/probe.js";
import { nameFor, startContainerResolver } from "@/lib/containers.js";

const WINDOW_MS = 1000;
const ring = new RingBuf(control, "events");

// kernel char[] -> JS string (trim at first NUL); handles string or byte array.
const cstr = (c) => {
  if (typeof c === "string") return c.replace(/\0.*$/s, "");
  if (!c) return "";
  let s = "";
  for (const b of c) { if (b === 0) break; s += String.fromCharCode(b); }
  return s;
};

// Collapse a concrete path to a route pattern so /users/42 and /users/99 don't
// explode cardinality. Numeric, hex, and uuid-ish segments become {id}; query
// strings are dropped. Pure string work — see lib/format if reused elsewhere.
const routeOf = (path) => {
  let p = (path || "/").split("?")[0];
  const segs = p.split("/").map((s) => {
    if (!s) return s;
    if (/^\d+$/.test(s)) return "{id}";
    if (/^[0-9a-f]{8,}$/i.test(s)) return "{id}";
    if (/^[0-9a-f-]{16,}$/i.test(s)) return "{uuid}";
    return s;
  });
  p = segs.join("/") || "/";
  return p.length > 48 ? p.slice(0, 47) + "…" : p;
};

// Duration tracking follows the RED method: percentiles, not averages, so a
// few slow requests don't hide behind a healthy mean. We keep a bounded
// reservoir of recent latency samples per aggregate and compute p50/p95/p99
// from it on publish. RES_MAX caps memory (and keeps the percentile recent —
// it's the last RES_MAX requests, which is what you want on a live top).
const RES_MAX = 512;

// Append a latency sample to a reservoir, capped at RES_MAX as a ring (the
// `_w` write cursor lives on the array). Keeps the most recent RES_MAX
// samples — recency is the right bias for a live RED dashboard.
const pushSample = (res, ms) => {
  if (res.length < RES_MAX) { res.push(ms); return; }
  res._w = ((res._w || 0) + 1) % RES_MAX;
  res[res._w] = ms;
};

// p50/p95/p99 from a sample array. Copy-and-sort on publish only (once per
// window, per visible aggregate) — fine for RES_MAX samples.
const pct = (res, q) => {
  if (!res.length) return 0;
  const a = res.slice().sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.floor(q * a.length));
  return a[i];
};
export const percentiles = (res) => ({
  p50: pct(res, 0.5),
  p95: pct(res, 0.95),
  p99: pct(res, 0.99),
});

// --- aggregation state (module-level; views read signals only) ------------
// Per-container roll-up. `routes` is a nested map: route pattern -> counters,
// used by the Containers drill-down. RED metrics: count (Rate basis), errs
// (Errors), and `lat` reservoir (Duration percentiles).
const makeAgg = () => ({
  count: 0,
  errs: 0, // status >= 400
  lat: [], // latency reservoir (ms) for percentiles
  latMax: 0,
  tls: 0,
  wire: 0,
  bytes: 0, // req + resp
  routes: new Map(), // route -> { count, errs, lat:[], latMax }
  methods: new Map(), // method -> count
  statuses: new Map(), // status -> count
});

const byContainer = new Map(); // name -> agg
const byRoute = new Map(); // global route -> { count, errs, latSum, latMax, containers:Set }

// Live request feed — a bounded ring of the most recent individual requests
// (newest first), for the "Live" tab. Pure UI on the same event stream; no
// extra ring-buffer subscription. FEED_MAX caps memory and is plenty for a
// scrollback that fits any screen.
const FEED_MAX = 500;
const feedBuf = [];

// The Notable feed only keeps requests worth a human's attention: errors
// (status >= 400) and slow requests (latency >= slowMs). Everything else is
// counted as "elided" so the tab is honest about what it isn't showing. The
// slow floor is tunable live with +/- from the UI.
export let slowMs = 200;
export function setSlowMs(ms) { slowMs = Math.max(1, ms); }
let elidedTotal = 0; // normal (uninteresting) requests dropped, cumulative

let seq = 0, rateMark = 0, curRate = 0;
let totalTls = 0, totalWire = 0, totalErrs = 0;

// Millisecond clock. The runtime has no Date.now()/performance.now(), so we
// advance a counter on a fast ticker and stamp each notable event with it —
// giving the feed mm:ss.mmm ordering at ~CLOCK_TICK resolution. The ticker
// runs only while the data layer is bound (started in bind(), cleared on the
// last unbind).
const CLOCK_TICK = 25; // ms
let clockMs = 0;
let clockTimer = null;

// Per-aggregate windowed rate (req/s) — RED's R. We snapshot each aggregate's
// cumulative count at the close of every rate window and divide the delta by
// the elapsed seconds. Keyed the same way as the aggregate maps.
const rateWindowSec = WINDOW_MS / 1000;
const prevCount = { container: new Map(), route: new Map() };
const curRateOf = { container: new Map(), route: new Map() };

function rollRates() {
  for (const [name, a] of byContainer) {
    const prev = prevCount.container.get(name) || 0;
    curRateOf.container.set(name, (a.count - prev) / rateWindowSec);
    prevCount.container.set(name, a.count);
  }
  for (const [route, g] of byRoute) {
    const prev = prevCount.route.get(route) || 0;
    curRateOf.route.set(route, (g.count - prev) / rateWindowSec);
    prevCount.route.set(route, g.count);
  }
}

function record(e) {
  const name = nameFor(cstr(e.cgroup));
  const method = cstr(e.method) || "?";
  const route = routeOf(cstr(e.path));
  const status = Number(e.status) || 0;
  const lat = Number(e.lat_ms) || 0;
  const bytes = (Number(e.req_bytes) || 0) + (Number(e.resp_bytes) || 0);
  const isTls = Number(e.source) === 1;
  const isErr = status >= 400;

  seq++;
  if (isTls) totalTls++; else totalWire++;
  if (isErr) totalErrs++;

  // Per container
  let c = byContainer.get(name);
  if (!c) { c = makeAgg(); byContainer.set(name, c); }
  c.count++;
  c.bytes += bytes;
  pushSample(c.lat, lat);
  if (lat > c.latMax) c.latMax = lat;
  if (isTls) c.tls++; else c.wire++;
  if (isErr) c.errs++;
  c.methods.set(method, (c.methods.get(method) || 0) + 1);
  if (status) c.statuses.set(status, (c.statuses.get(status) || 0) + 1);

  let r = c.routes.get(route);
  if (!r) { r = { count: 0, errs: 0, lat: [], latMax: 0 }; c.routes.set(route, r); }
  r.count++; pushSample(r.lat, lat); if (lat > r.latMax) r.latMax = lat; if (isErr) r.errs++;

  // Global routes
  let g = byRoute.get(route);
  if (!g) { g = { count: 0, errs: 0, lat: [], latMax: 0, containers: new Set() }; byRoute.set(route, g); }
  g.count++; pushSample(g.lat, lat); if (lat > g.latMax) g.latMax = lat; if (isErr) g.errs++;
  g.containers.add(name);

  // Notable feed: only requests worth a human's attention earn a row — an
  // error, or a slow one. Healthy fast requests are counted as elided (the
  // tops already summarize those). `reason` drives the row's tag/color; `t` is
  // the seconds-since-start tick (the runtime has no Date.now()).
  const isSlow = lat >= slowMs;
  if (isErr || isSlow) {
    feedBuf.unshift({
      seq, t: clockMs, name, method,
      path: cstr(e.path) || "/", status, lat, tls: isTls,
      reqBytes: Number(e.req_bytes) || 0,
      respBytes: Number(e.resp_bytes) || 0,
      reason: isErr ? "error" : "slow", // error wins when both
    });
    if (feedBuf.length > FEED_MAX) feedBuf.pop();
  } else {
    elidedTotal++;
  }
}

// --- published signals ----------------------------------------------------
export const containers = from((s) => bind(s, "containers"), []);
export const routes = from((s) => bind(s, "routes"), []);
export const feed = from((s) => bind(s, "feed"), { rows: [], elided: 0, slowMs });
export const stats = from((s) => bind(s, "stats"), { rate: 0, total: 0, tls: 0, wire: 0, errs: 0, containers: 0 });

const publishers = { containers: null, routes: null, feed: null, stats: null };
let sub = null, refs = 0;

const topRoutes = (map) =>
  [...map.entries()]
    .map(([route, r]) => {
      const p = percentiles(r.lat);
      return {
        route,
        count: r.count,
        errs: r.errs,
        errRate: r.count ? (r.errs / r.count) * 100 : 0,
        p50: p.p50, p95: p.p95, p99: p.p99,
        maxLat: r.latMax,
      };
    })
    .sort((a, b) => b.count - a.count);

function recompute() {
  const total = seq || 1;

  publishers.containers?.set(
    [...byContainer.entries()]
      .map(([name, a]) => {
        const p = percentiles(a.lat);
        return {
          name,
          count: a.count,
          rate: curRateOf.container.get(name) || 0, // RED: R
          share: (a.count / total) * 100,
          errs: a.errs,
          errRate: a.count ? (a.errs / a.count) * 100 : 0, // RED: E
          p50: p.p50, p95: p.p95, p99: p.p99, // RED: D (percentiles)
          maxLat: a.latMax,
          tls: a.tls,
          wire: a.wire,
          encShare: a.count ? (a.tls / a.count) * 100 : 0,
          bytes: a.bytes,
          // drill-down payloads
          routes: topRoutes(a.routes).slice(0, 8),
          methods: [...a.methods.entries()].sort((x, y) => y[1] - x[1]),
          statuses: [...a.statuses.entries()].sort((x, y) => y[1] - x[1]),
        };
      })
      .sort((a, b) => b.count - a.count),
  );

  publishers.routes?.set(
    [...byRoute.entries()]
      .map(([route, r]) => {
        const p = percentiles(r.lat);
        return {
          route,
          count: r.count,
          rate: curRateOf.route.get(route) || 0, // RED: R
          share: (r.count / total) * 100,
          errs: r.errs,
          errRate: r.count ? (r.errs / r.count) * 100 : 0, // RED: E
          p50: p.p50, p95: p.p95, p99: p.p99, // RED: D
          maxLat: r.latMax,
          containers: [...r.containers],
        };
      })
      .sort((a, b) => b.count - a.count),
  );

  // Publish a snapshot of the notable feed (newest first) + how many normal
  // requests were elided + the current slow floor (for the header).
  publishers.feed?.set({ rows: feedBuf.slice(0, FEED_MAX), elided: elidedTotal, slowMs });

  publishers.stats?.set({
    rate: curRate,
    total: seq,
    tls: totalTls,
    wire: totalWire,
    errs: totalErrs,
    containers: byContainer.size,
  });
}

function bind(state, which) {
  publishers[which] = state;
  refs++;
  if (!sub) {
    startContainerResolver(); // begin polling docker so attribution is live
    sub = ring.subscribe((w) => {
      const e = w?.http_event ?? w;
      if (!e) return;
      record(e);
    });
  }
  if (!clockTimer) clockTimer = setInterval(() => { clockMs += CLOCK_TICK; }, CLOCK_TICK);
  const h = setInterval(() => {
    if (which === "stats") {
      curRate = (seq - rateMark) / (WINDOW_MS / 1000);
      rateMark = seq;
      rollRates(); // refresh per-container/route req/s for the RED views
    }
    recompute();
  }, which === "stats" ? WINDOW_MS : 500);
  return () => {
    clearInterval(h);
    publishers[which] = null;
    if (--refs === 0 && sub) {
      sub.then(_.unsubscribe()); sub = null;
      if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    }
  };
}

// Clear counts so the user can profile one workload from zero.
export function reset() {
  byContainer.clear();
  byRoute.clear();
  feedBuf.length = 0;
  elidedTotal = 0;
  seq = 0; rateMark = 0; curRate = 0;
  totalTls = 0; totalWire = 0; totalErrs = 0;
  recompute();
}
