/* containertop — top for your containers' HTTP traffic.
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
import { containers, feed, routes, reset, setSlowMs, slowMs, stats } from "@/probes/containertop.js";
import { closeLogs, logLines, logStatus, openLogs } from "@/probes/logs.js";
import { layoutFor } from "@/lib/layout.js";
import TabBar, { TABS } from "@/components/tabbar.jsx";
import TitleBar from "@/components/titlebar.jsx";
import Report, { reportFindings } from "@/components/report.jsx";
import Containers from "@/components/containers.jsx";
import Routes from "@/components/routes.jsx";
import Feed from "@/components/feed.jsx";
import Detail from "@/components/detail.jsx";
import Footer from "@/components/footer.jsx";

const view = signal("containers"); // opens on the top

// Per-tab selection. Sorted lists (containers/routes/report) select by index;
// the Notable feed selects by stable `seq` (rows prepend, so an index drifts).
const sel = {
  containers: signal(0),
  routes: signal(0),
  live: signal(null),
  report: signal(0),
};

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

const cycle = (d) => {
  const i = order.indexOf(view.get());
  const next = order[(i + d + order.length) % order.length];
  view.set(next);
  if (next === "containers") syncContainerLogs();
  else closeLogs();
};
const jump = (id) => {
  if (!id) return;
  view.set(id);
  if (id === "containers") syncContainerLogs();
  else closeLogs();
};

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
onKey((e) => {
  const code = e.code;
  const k = (e.key ?? "").toLowerCase();
  if (code === "Escape" || k === "q") { exit(); return; }
  if (code === "Tab" || k === "tab") { cycle(e.shiftKey ? -1 : 1); return; }
  if (k >= "1" && k <= "9") { jump(order[Number(k) - 1]); return; }
  if (k === "r") { reset(); return; }
  if (k === "+" || k === "=") { setSlowMs(slowMs + 50); return; }
  if (k === "-" || k === "_") { setSlowMs(Math.max(1, slowMs - 50)); return; }
  if (code === "ArrowUp" || k === "k") { move(-1); return; }
  if (code === "ArrowDown" || k === "j") { move(1); return; }
});

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

        const list =
          v === "report" ? <Report findings={findings} selected={sel.report} maxRows={lay.maxRows} />
          : v === "routes" ? <Routes rows={routes} selected={sel.routes} maxRows={lay.maxRows} />
          : v === "live" ? <Feed feed={feed} selected={sel.live} maxRows={lay.maxRows} />
          : <Containers rows={containers} selected={sel.containers} maxRows={lay.maxRows} />;

        const cols = [
          <TabBar view={view} width={lay.rail} />,
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
