// Status rail — container-traffic's signature health strip, the RED triad made
// glanceable: BROKEN (errors), OVERLOADED (rate), plus the dual-source split.
// One row, tinted as a rail via its own bg.
import { Box, Text } from "yeet:tui";
import { b, fmtCount, fmtRate, t } from "@/lib/format.js";
import { tlsActive } from "@/probes/probe.js";
import { C } from "@/lib/theme.js";

// A small "▆ label value" cell in a meaning color — three styled runs.
const cell = (color, glyph, label, value) => [
  t(color, `${glyph} `), t(C.label, `${label} `), b(color, value),
];
const gap = t(C.dim, "   ");

export default ({ stats }) => (
  <Box height="1" direction="row" bg={C.rail}>
    <Text break="none">
      {() => {
        const { rate = 0, total = 0, errs = 0, tls = 0, wire = 0, containers = 0 } = stats.get();
        const errPct = total ? (errs / total) * 100 : 0;
        return [
          " ",
          t(C.label, "containers "), b(C.textBold, `${containers}`),
          gap,
          ...cell(C.overloaded, "▲", "overloaded", `${fmtRate(rate)}/s`),
          gap,
          ...(errs > 0
            ? cell(C.broken, "●", "broken", `${fmtCount(errs)} (${errPct.toFixed(0)}%)`)
            : [t(C.ok, "● "), t(C.label, "broken "), b(C.ok, "0")]),
          gap,
          // Dual-source split. The TLS path is scoped to the HOST libssl (the
          // uprobe API can't reach a container's own libssl), so "enc(host)"
          // when active, "enc(off)" if it didn't attach.
          t(C.tls, `${fmtCount(tls)} enc`),
          t(C.dim, tlsActive ? "(host) + " : "(off) + "),
          t(C.wire, `${fmtCount(wire)} plain`),
        ];
      }}
    </Text>
  </Box>
);
