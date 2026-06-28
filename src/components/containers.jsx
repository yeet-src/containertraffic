// Containers list — the headline "top" as the MIDDLE column of the master/
// detail layout. A compact, selectable list ranked by request rate through the
// RED lens (rate / err% / p99). The full breakdown for the highlighted row
// lives in the detail pane (see containerDetail below), which tracks the
// selection as you scroll — no inline expansion.
//
// Styling: a <Text> holds an array of styled runs built with face({...})(str)
// — the runtime-computed face form (the named fg()/bold() combinators were
// removed from yeet:tui, and nested <Text> isn't rendered by the daemon).
import { Box, Text } from "yeet:tui";
import { b, bar, errColor, fmtBytes, fmtCount, fmtLat, fmtRate, lpad, pad, statusColor, t } from "@/lib/format.js";
import { C } from "@/lib/theme.js";

const SLOW = C.slow;
const BAR_W = 10;
const COL = { mark: 2, name: 16, rate: 7, bar: BAR_W, err: 6, p99: 7 };

const headerRow = () => (
  <Box height="1" direction="row" bg={C.headerBg}>
    <Text break="none">
      {[
        t(C.label, pad("  container", COL.mark + COL.name)), " ",
        t(C.label, lpad("req/s", COL.rate)), " ",
        t(C.label, pad("", COL.bar)), " ",
        t(C.label, lpad("err%", COL.err)), " ",
        t(C.label, lpad("p99", COL.p99)),
      ]}
    </Text>
  </Box>
);

const row = (r, isSel, maxRate) => {
  const c = r.encShare > 0 ? C.tls : C.wire; // pink if seen encrypted, else blue
  const ratePct = maxRate > 0 ? (r.rate / maxRate) * 100 : 0;
  return (
    <Box height="1" direction="row" bg={isSel ? C.selBg : undefined}>
      <Text break="none">
        {[
          t(isSel ? C.textBold : C.dim, pad(isSel ? "▸" : " ", COL.mark)),
          b(c, pad(r.name, COL.name)), " ",
          t(C.textBold, lpad(fmtRate(r.rate), COL.rate)), " ",
          ...bar(ratePct, COL.bar), " ",
          t(errColor(r.errRate), lpad(r.errRate > 0 ? `${r.errRate.toFixed(0)}%` : "·", COL.err)), " ",
          t(r.p99 >= 1000 ? SLOW : C.dim, lpad(fmtLat(r.p99), COL.p99)),
        ]}
      </Text>
    </Box>
  );
};

export default ({ rows: rowsSig, selected, maxRows }) => (
  <Box direction="column" height="1fr" overflow="hidden">
    {headerRow()}
    <Box height="1fr" direction="column" overflow="hidden">
      {() => {
        const rows = rowsSig.get();
        if (!rows.length) return [<Box height="1"><Text>{t(C.dim, "  waiting for HTTP traffic…")}</Text></Box>];
        const sel = selected.get();
        const maxRate = rows.reduce((m, r) => Math.max(m, r.rate), 0);
        const out = [];
        for (let i = 0; i < rows.length && i < maxRows; i++) out.push(row(rows[i], i === sel, maxRate));
        return out;
      }}
    </Box>
  </Box>
);

// --- detail pane content for the selected container -----------------------
const kvRow = (label, runs) => (
  <Box height="1" direction="row">
    <Text break="none">{[t(C.label, pad("  " + label, 12)), ...runs]}</Text>
  </Box>
);

export const containerDetail = (r) => {
  if (!r) return [<Box height="1"><Text>{t(C.dim, "  no container selected")}</Text></Box>];
  const out = [];

  out.push(<Box height="1" direction="row"><Text break="none">{[t(C.dim, "  "), b(r.encShare > 0 ? C.tls : C.wire, r.name)]}</Text></Box>);
  out.push(<Box height="1"><Text> </Text></Box>);

  out.push(kvRow("rate", [t(C.overloaded, `${fmtRate(r.rate)}/s`), t(C.dim, `  (${fmtCount(r.count)} total)`)]));
  out.push(kvRow("errors", [t(errColor(r.errRate), `${r.errRate.toFixed(1)}%`), t(C.dim, `  ${fmtCount(r.errs)} failed`)]));
  out.push(kvRow("latency", [
    t(C.text, `p50 ${fmtLat(r.p50)}`), t(C.dim, "  "),
    t(C.text, `p95 ${fmtLat(r.p95)}`), t(C.dim, "  "),
    t(r.p99 >= 1000 ? C.slow : C.text, `p99 ${fmtLat(r.p99)}`),
  ]));
  out.push(kvRow("traffic", [
    t(C.text, fmtBytes(r.bytes)), t(C.dim, "   "),
    t(C.tls, `${fmtCount(r.tls)} enc`), t(C.dim, " / "), t(C.wire, `${fmtCount(r.wire)} plain`),
  ]));

  if (r.methods?.length) {
    out.push(kvRow("methods", r.methods.flatMap(([m, n], i) => [
      i ? t(C.dim, "  ") : "", t(C.name, m), t(C.dim, ` ${fmtCount(n)}`),
    ])));
  }
  if (r.statuses?.length) {
    out.push(kvRow("status", r.statuses.flatMap(([s, n], i) => [
      i ? t(C.dim, "  ") : "", t(statusColor(s), `${s}`), t(C.dim, ` ${fmtCount(n)}`),
    ])));
  }

  out.push(<Box height="1"><Text> </Text></Box>);
  out.push(<Box height="1" direction="row"><Text break="none">{t(C.label, "  top routes")}</Text></Box>);
  for (const rt of r.routes ?? []) {
    out.push(
      <Box height="1" direction="row">
        <Text break="none">
          {[
            t(C.dim, "    "),
            t(C.name, pad(rt.route, 22)), " ",
            t(C.text, lpad(fmtCount(rt.count), 6)), " ",
            t(errColor(rt.errRate), lpad(rt.errRate > 0 ? `${rt.errRate.toFixed(0)}%` : "", 5)), " ",
            t(C.dim, lpad(fmtLat(rt.p99), 7)),
          ]}
        </Text>
      </Box>,
    );
  }
  return out;
};
