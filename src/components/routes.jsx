// Routes list — every route pattern across all containers (path ids collapsed
// to {id}), ranked by volume, as the MIDDLE column. The detail pane shows which
// containers serve the highlighted route plus its full percentiles.
import { Box, Text } from "yeet:tui";
import { b, bar, errColor, fmtCount, fmtLat, fmtRate, lpad, pad, t } from "@/lib/format.js";
import { C } from "@/lib/theme.js";

const SLOW = C.slow;
const BAR_W = 10;
const COL = { mark: 2, route: 22, rate: 7, bar: BAR_W, err: 6, p99: 7 };

const headerRow = () => (
  <Box height="1" direction="row" bg={C.headerBg}>
    <Text break="none">
      {[
        t(C.label, pad("  route", COL.mark + COL.route)), " ",
        t(C.label, lpad("req/s", COL.rate)), " ",
        t(C.label, pad("", COL.bar)), " ",
        t(C.label, lpad("err%", COL.err)), " ",
        t(C.label, lpad("p99", COL.p99)),
      ]}
    </Text>
  </Box>
);

const row = (r, isSel, maxRate) => {
  const ratePct = maxRate > 0 ? (r.rate / maxRate) * 100 : 0;
  return (
    <Box height="1" direction="row" bg={isSel ? C.selBg : undefined}>
      <Text break="none">
        {[
          t(isSel ? C.textBold : C.dim, pad(isSel ? "▸" : " ", COL.mark)),
          b(C.name, pad(r.route, COL.route)), " ",
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

// --- detail pane content for the selected route ---------------------------
const kvRow = (label, runs) => (
  <Box height="1" direction="row">
    <Text break="none">{[t(C.label, pad("  " + label, 12)), ...runs]}</Text>
  </Box>
);

export const routeDetail = (r) => {
  if (!r) return [<Box height="1"><Text>{t(C.dim, "  no route selected")}</Text></Box>];
  const out = [];

  out.push(<Box height="1" direction="row"><Text break="none">{[t(C.dim, "  "), b(C.name, r.route)]}</Text></Box>);
  out.push(<Box height="1"><Text> </Text></Box>);

  out.push(kvRow("rate", [t(C.overloaded, `${fmtRate(r.rate)}/s`), t(C.dim, `  (${fmtCount(r.count)} total)`)]));
  out.push(kvRow("errors", [t(errColor(r.errRate), `${r.errRate.toFixed(1)}%`), t(C.dim, `  ${fmtCount(r.errs)} failed`)]));
  out.push(kvRow("latency", [
    t(C.text, `p50 ${fmtLat(r.p50)}`), t(C.dim, "  "),
    t(C.text, `p95 ${fmtLat(r.p95)}`), t(C.dim, "  "),
    t(r.p99 >= 1000 ? C.slow : C.text, `p99 ${fmtLat(r.p99)}`),
  ]));

  out.push(<Box height="1"><Text> </Text></Box>);
  out.push(<Box height="1" direction="row"><Text break="none">{t(C.label, "  served by")}</Text></Box>);
  for (const name of r.containers ?? []) {
    out.push(<Box height="1" direction="row"><Text break="none">{[t(C.dim, "    "), t(C.text, name)]}</Text></Box>);
  }
  return out;
};
