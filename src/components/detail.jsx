// Detail pane — the RIGHT column. Shows the highlighted row's detail for the
// active tab, updating live as the cursor moves (master/detail; no expand).
// It dispatches to each list's exported detail builder so the detail logic
// lives next to the data it knows. For containers it also tails live logs at
// the bottom, so "what is this service doing" and "what is it printing" sit
// together.
import { Box, Text } from "yeet:tui";
import { b, t } from "@/lib/format.js";
import { C } from "@/lib/theme.js";
import { containerDetail } from "@/components/containers.jsx";
import { routeDetail } from "@/components/routes.jsx";
import { feedDetail } from "@/components/feed.jsx";
import { findingDetail, reportFindings } from "@/components/report.jsx";

const title = (text) => (
  <Box height="1" direction="row" bg={C.headerBg}>
    <Text break="none">{b(C.label, `  ${text}`)}</Text>
  </Box>
);

// Live-logs strip for the container detail. `logLines` is [{stream,text}];
// shows the last `n` lines, stderr tinted. status reflects the stream state.
const logStrip = (lines, status, n) => {
  const out = [
    <Box height="1"><Text> </Text></Box>,
    <Box height="1" direction="row"><Text break="none">{[t(C.label, "  logs "), t(C.dim, status || "")]}</Text></Box>,
  ];
  if (!lines.length) {
    out.push(<Box height="1" direction="row"><Text break="none">{t(C.dim, "    (no log output yet)")}</Text></Box>);
    return out;
  }
  const shown = lines.slice(Math.max(0, lines.length - n));
  for (const l of shown) {
    const isErr = l.stream === "stderr";
    out.push(
      <Box height="1" direction="row">
        <Text break="none">{[t(isErr ? C.broken : C.dim, isErr ? "  ! " : "    "), t(isErr ? C.broken : C.text, l.text)]}</Text>
      </Box>,
    );
  }
  return out;
};

// props: view (string), the row signals, selection signals, and the log
// signals for the container case. maxRows budgets the pane height.
export default ({ view, containers, routes, feed, sel, logLines, logStatus, maxRows }) => (
  <Box direction="column" height="1fr" overflow="hidden" bg={C.rail}>
    {() => {
      const v = view.get();
      let head = "detail";
      let body = [];

      if (v === "containers") {
        head = "container detail";
        const rows = containers.get();
        const r = rows[sel.containers.get()];
        body = containerDetail(r);
        // append live logs (the L drill-down, now always-on in the pane)
        const used = body.length;
        const logBudget = Math.max(0, maxRows - used - 2);
        if (logBudget > 0) {
          body = body.concat(logStrip(logLines.get(), logStatus.get(), logBudget));
        }
      } else if (v === "routes") {
        head = "route detail";
        const rows = routes.get();
        body = routeDetail(rows[sel.routes.get()]);
      } else if (v === "live") {
        head = "request detail";
        const f = feed.get();
        const seq = sel.live.get();
        const r = seq == null ? null : f.rows.find((x) => x.seq === seq);
        body = feedDetail(r);
      } else if (v === "report") {
        head = "evidence";
        const findings = reportFindings(containers.get(), routes.get());
        body = findingDetail(findings[sel.report.get()], 40);
      }

      return [title(head), ...body.slice(0, maxRows)];
    }}
  </Box>
);
