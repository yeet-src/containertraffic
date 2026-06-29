// Notable list — a triage queue (errors + slow requests only) as the MIDDLE
// column. The full request detail for the highlighted row is in the detail
// pane. It selects by stable `seq` (rows prepend continuously, so an array
// index would drift) and anchors the view on the selection so it holds still
// while fresh rows arrive above it.
import { Box, Text } from "yeet:tui";
import { b, fmtBytes, fmtCount, fmtLat, lpad, pad, t } from "@/lib/format.js";
import { C } from "@/lib/theme.js";

const SLOW = C.slow;
const ERRC = C.broken;
const COL = { mark: 2, time: 9, name: 14, verb: 5, code: 5, lat: 7 };

const clock = (ms) => {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mmm = Math.floor(ms % 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(mmm).padStart(3, "0")}`;
};

const reasonColor = (r) => (r === "error" ? ERRC : SLOW);

const headerBar = (slowMs, elided) => (
  <Box height="1" direction="row" bg={C.headerBg}>
    <Text break="none">
      {[
        t(C.label, "  notable: "), b(ERRC, "err"), t(C.dim, " + "),
        b(SLOW, `slow≥${fmtLat(slowMs)}`), t(C.dim, " [+/-]  "),
        t(C.dim, `${fmtCount(elided)} elided`),
      ]}
    </Text>
  </Box>
);

const colHeader = () => (
  <Box height="1" direction="row">
    <Text break="none">
      {[
        t(C.label, pad("", COL.mark)),
        t(C.label, pad("time", COL.time)), " ",
        t(C.label, pad("container", COL.name)), " ",
        t(C.label, pad("verb", COL.verb)), " ",
        t(C.label, lpad("code", COL.code)), " ",
        t(C.label, lpad("lat", COL.lat)),
      ]}
    </Text>
  </Box>
);

const row = (r, isSel) => {
  const nameC = r.tls ? C.tls : C.wire;
  const code = r.status ? `${r.status}` : "—";
  return (
    <Box height="1" direction="row" bg={isSel ? C.selBg : undefined}>
      <Text break="none">
        {[
          t(reasonColor(r.reason), pad("", COL.mark)),
          t(C.dim, pad(clock(r.t), COL.time)), " ",
          b(nameC, pad(r.name, COL.name)), " ",
          t(C.name, pad(r.method, COL.verb)), " ",
          b(r.reason === "error" ? ERRC : C.ok, lpad(code, COL.code)), " ",
          t(r.reason === "slow" ? SLOW : C.dim, lpad(fmtLat(r.lat), COL.lat)),
        ]}
      </Text>
    </Box>
  );
};

export default ({ feed: feedSig, selected, maxRows }) => (
  <Box direction="column" height="1fr" overflow="hidden">
    {() => { const f = feedSig.get(); return headerBar(f.slowMs, f.elided); }}
    {colHeader()}
    <Box height="1fr" direction="column" overflow="hidden">
      {() => {
        const f = feedSig.get();
        const rows = f.rows;
        if (!rows.length) return [<Box height="1"><Text>{t(C.ok, "  ✓ nothing notable — no errors, nothing slow")}</Text></Box>];
        const selSeq = selected.get();
        let anchor = 0;
        if (selSeq != null) {
          const fi = rows.findIndex((r) => r.seq === selSeq);
          if (fi >= 0) anchor = Math.max(0, fi - 2);
        }
        const out = [];
        let used = 0;
        for (let i = anchor; i < rows.length && used < maxRows; i++) { out.push(row(rows[i], rows[i].seq === selSeq)); used++; }
        return out;
      }}
    </Box>
  </Box>
);

// --- detail pane content for the selected request -------------------------
const kvRow = (label, runs) => (
  <Box height="1" direction="row">
    <Text break="none">{[t(C.label, pad("  " + label, 10)), ...runs]}</Text>
  </Box>
);

export const feedDetail = (r) => {
  if (!r) return [<Box height="1"><Text>{t(C.dim, "  select a request (↑/↓)")}</Text></Box>];
  const out = [];

  out.push(<Box height="1" direction="row"><Text break="none">{[t(C.dim, "  "), b(reasonColor(r.reason), r.reason === "error" ? "BROKEN" : "SLOW")]}</Text></Box>);
  out.push(<Box height="1"><Text> </Text></Box>);

  out.push(kvRow("when", [t(C.text, clock(r.t))]));
  out.push(kvRow("from", [b(r.tls ? C.tls : C.wire, r.name)]));
  out.push(kvRow("request", [t(C.name, r.method), t(C.dim, " "), t(C.text, r.path)]));
  out.push(kvRow("status", [
    b(r.reason === "error" ? ERRC : C.ok, r.status ? `${r.status}` : "—"),
    t(C.dim, "   lat "), t(r.reason === "slow" ? SLOW : C.text, fmtLat(r.lat)),
  ]));
  out.push(kvRow("sent", [t(C.text, fmtBytes(r.reqBytes))]));
  out.push(kvRow("recv", [t(C.text, fmtBytes(r.respBytes))]));
  out.push(kvRow("via", [t(r.tls ? C.tls : C.wire, r.tls ? "encrypted (TLS)" : "plaintext (wire)")]));
  return out;
};
