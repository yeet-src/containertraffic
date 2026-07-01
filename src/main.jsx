/* containertraffic — top for your containers' HTTP traffic.
 *
 * A live, zero-config view of every container's HTTP, attributed by cgroup
 * straight from the kernel — no sidecar, no app changes. It frames what it sees
 * the way an on-call engineer thinks, the RED method as the three ways a
 * service gets sick:
 *
 *   BROKEN     — errors (4xx/5xx share)        [E]
 *   OVERLOADED — request rate / saturation     [R]
 *   SLOW       — tail latency (p95 / p99)       [D]   ← never an average
 *
 * Layout: a three-column master/detail shell —
 *   [ vertical tab rail | list (active tab) | detail of the selected row ].
 * The detail pane tracks the cursor live as you scroll; the container detail
 * also tails that container's logs. A full-width status strip sits on top.
 *
 * Tabs: Containers (the top) · Routes · Notable (errors+slow triage) · Report
 * (ranked findings + evidence). Caveats: HTTP/1.x only; TLS captured on the
 * host libssl only (see README).
 */
import { Box, mount, signal } from "yeet:tui";
import { containers, feed, routes, reset, setSlowMs, slowMs, stats } from "@/probes/containertraffic.js";
import { closeLogs, logLines, logStatus, openLogs } from "@/probes/logs.js";
import { firstListRow, layoutFor, RAIL_FIRST_TAB_ROW } from "@/lib/layout.js";
import TabBar, { TABS } from "@/components/tabbar.jsx";
import TitleBar from "@/components/titlebar.jsx";
import Report, { reportFindings } from "@/components/report.jsx";
import Containers from "@/components/containers.jsx";
import Routes from "@/components/routes.jsx";
import Feed, { feedWindow } from "@/components/feed.jsx";
import Detail from "@/components/detail.jsx";
import Footer from "@/components/footer.jsx";

const view = signal("containers"); // which view the rail has selected
// Focus region: "rail" (navigating the left nav) or "list" (navigating rows in
// the middle). Arrows drive whichever region is focused; Right enters the list,
// Left returns to the rail. The focused region's highlight is blue; the list's
// resting (unfocused) selection is dark.
const focus = signal("rail");

// Per-view row selection. Sorted lists (containers/routes/report) select by
// index; the Notable feed selects by stable `seq` (rows prepend, so an index
// drifts).
const sel = {
  containers: signal(0),
  routes: signal(0),
  live: signal(null),
  report: signal(0),
};

// The Notable feed scrolls: `feedTop` is the seq of the row at the top of its
// visible window. The feed resolves/persists it; move() and hitTest read it to
// keep keyboard, mouse, and render in agreement.
const feedTop = signal(null);

// A findings signal recomputed when its inputs change — so the Report list and
// its evidence pane agree and re-render together.
const findings = signal([]);

const order = TABS.map((t) => t.id);

// Rows for the active view, as a plain array (feed wraps its rows).
const rowsFor = (v) => {
  if (v === "containers") return containers.get();
  if (v === "routes") return routes.get();
  if (v === "live") return feed.get().rows;
  if (v === "report") return findings.get();
  return [];
};

// When the Containers selection changes we point the log stream at the newly
// selected container, so the detail pane's log strip follows the cursor.
const syncContainerLogs = () => {
  const rows = containers.get();
  const r = rows[sel.containers.get()];
  if (r) openLogs(r.name); else closeLogs();
};

const move = (d) => {
  const v = view.get();
  const rows = rowsFor(v);
  if (!rows.length) return;
  if (v === "live") {
    const cur = sel.live.get();
    let i = cur == null ? 0 : rows.findIndex((r) => r.seq === cur);
    if (i < 0) i = 0;
    i = Math.max(0, Math.min(rows.length - 1, i + d));
    sel.live.set(rows[i].seq);
    return;
  }
  const s = sel[v];
  s.set(Math.max(0, Math.min(rows.length - 1, s.get() + d)));
  if (v === "containers") syncContainerLogs();
};

// Switch the active view (rail navigation). Clamps at the ends rather than
// wrapping, so up/down on the rail feels like a list, not a carousel.
const railMove = (d) => {
  const i = order.indexOf(view.get());
  const ni = Math.max(0, Math.min(order.length - 1, i + d));
  setView(order[ni]);
};
const setView = (id) => {
  if (!id) return;
  view.set(id);
  if (id === "containers") syncContainerLogs();
  else closeLogs();
};

// Region transitions. Right enters the list (its top/selected row goes blue);
// Left returns to the rail.
const enterList = () => {
  const v = view.get();
  const rows = rowsFor(v);
  if (!rows.length) return; // nothing to focus
  // Seed a selection so the blue highlight shows immediately. The feed selects
  // by seq and may be unset; point it at the top row.
  if (v === "live" && sel.live.get() == null) sel.live.set(rows[0].seq);
  if (v === "containers") syncContainerLogs();
  focus.set("list");
};
const exitToRail = () => focus.set("rail");

// Wrap every handler so it NEVER returns a value to the runtime (a returned
// Promise/object triggers "Cannot convert Promise to JSON") and never throws
// onto the screen.
const onKey = (fn) => {
  const safe = (e) => { try { fn(e); } catch {} };
  try { if (typeof tty !== "undefined" && tty.on) tty.on("keydown", safe); } catch {}
};

// Defer exit a tick — calling yeet.exit() inside the listener tears the isolate
// down mid-dispatch and the runtime logs a spurious "listener threw".
const exit = () => setTimeout(() => yeet.exit(), 0);

// Handlers must NOT return a value: some actions (openLogs/closeLogs) bubble a
// graph subscribe ticket or unsubscribe Promise, and the runtime tries to
// JSON-serialize a listener's return value ("Cannot convert Promise to JSON").
// So we bare-call the action and let the arrow fall through to undefined.
// Navigation is arrows + mouse. Two regions:
//   rail  — ↑/↓ switch the active view (live); → enters the list.
//   list  — ↑/↓ move the row selection; ← returns to the rail.
// q quits; +/- tune the slow floor; r resets. (No tab bar, no number keys.)
onKey((e) => {
  const code = e.code;
  const k = (e.key ?? "").toLowerCase();
  if (code === "Escape" || k === "q") { exit(); return; }
  if (k === "r") { reset(); return; }
  if (k === "+" || k === "=") { setSlowMs(slowMs + 50); return; }
  if (k === "-" || k === "_") { setSlowMs(Math.max(1, slowMs - 50)); return; }

  const up = code === "ArrowUp" || k === "k";
  const down = code === "ArrowDown" || k === "j";
  const left = code === "ArrowLeft" || k === "h";
  const right = code === "ArrowRight" || k === "l";

  if (focus.get() === "rail") {
    if (up) { railMove(-1); return; }
    if (down) { railMove(1); return; }
    if (right) { enterList(); return; }
  } else { // list focused
    if (up) { move(-1); return; }
    if (down) { move(1); return; }
    if (left) { exitToRail(); return; }
  }
});

// Mouse: click a rail item to switch view; click a list row to select it and
// focus the list. Coordinates are 0-indexed against the screen.
const hitTest = (x, y) => {
  const sz = (typeof tty !== "undefined" && tty.size) ? tty.size() : { rows: 24, cols: 80 };
  const lay = layoutFor({ cols: sz.cols, rows: sz.rows });

  if (x < lay.rail) {
    // Rail click → select the view under the cursor (live switch, focus rail).
    const i = y - RAIL_FIRST_TAB_ROW;
    if (i >= 0 && i < order.length) { setView(order[i]); focus.set("rail"); }
    return;
  }
  if (x < lay.rail + lay.list) {
    // List click → select that row and focus the list. `vis` is the visible-row
    // offset under the cursor; map it to the real row index. The Notable feed
    // windows its rows, so add its anchor (other views render from index 0).
    const v = view.get();
    const vis = y - firstListRow(v);
    if (vis < 0) return;
    const rows = rowsFor(v);
    if (v === "live") {
      // Map the visible-row offset through the feed's current window.
      const win = feedWindow(rows, sel.live.get(), feedTop.get(), lay.maxRows);
      const idx = win.start + vis;
      if (idx < 0 || idx >= rows.length) return;
      sel.live.set(rows[idx].seq);
    } else {
      if (vis >= rows.length) return;
      sel[v].set(vis);
      if (v === "containers") syncContainerLogs();
    }
    focus.set("list");
  }
  // Clicks in the detail pane do nothing (it mirrors the selection).
};

const onMouse = (e) => { if (e.button === 0) hitTest(e.clientX, e.clientY); };
try { if (typeof tty !== "undefined") { tty.enableMouse?.(); tty.on?.("mousedown", (e) => { try { onMouse(e); } catch {} }); } } catch {}

// Ctrl-C confirm: a left-open monitor shouldn't die on a reflexive ^C.
let armed = false;
onKey((e) => {
  if (!(e.ctrlKey && (e.key === "c" || e.code === "KeyC"))) return;
  if (typeof e.preventDefault === "function") e.preventDefault();
  if (armed) return exit();
  armed = true;
  setTimeout(() => { armed = false; }, 1500);
});

// Keep the Report findings fresh, and start the container log stream once data
// is flowing. A light timer is enough (findings are cheap; the lists re-render
// from their own signals).
setInterval(() => {
  findings.set(reportFindings(containers.get(), routes.get()));
}, 1000);
setTimeout(syncContainerLogs, 800); // first selection -> first log target

const Root = (size) => (
  <Box direction="column">
    <TitleBar stats={stats} />
    <Box height="1fr" direction="row" overflow="hidden">
      {() => {
        const lay = layoutFor(size.get());
        const v = view.get();

        // listFocused → the middle's selected row is blue; otherwise dark.
        const listFocused = focus.get() === "list";
        const list =
          v === "report" ? <Report findings={findings} selected={sel.report} focused={listFocused} maxRows={lay.maxRows} />
          : v === "routes" ? <Routes rows={routes} selected={sel.routes} focused={listFocused} maxRows={lay.maxRows} />
          : v === "live" ? <Feed feed={feed} selected={sel.live} top={feedTop} focused={listFocused} maxRows={lay.maxRows} />
          : <Containers rows={containers} selected={sel.containers} focused={listFocused} maxRows={lay.maxRows} />;

        const cols = [
          <TabBar view={view} width={lay.rail} railFocused={focus.get() === "rail"} />,
          <Box width={`${lay.list}`} height="1fr" overflow="hidden">{list}</Box>,
        ];
        if (!lay.narrow) {
          cols.push(
            <Box width={`${lay.detail}`} height="1fr" overflow="hidden">
              <Detail
                view={view}
                containers={containers}
                routes={routes}
                feed={feed}
                sel={sel}
                logLines={logLines}
                logStatus={logStatus}
                maxRows={lay.maxRows}
              />
            </Box>,
          );
        }
        return cols;
      }}
    </Box>
    <Footer />
  </Box>
);

mount(Root);
await new Promise(() => {}); // keep the script alive; the TUI owns the screen
