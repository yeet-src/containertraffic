// Report tab — ranked findings as the MIDDLE column (one selectable line per
// finding), with the highlighted finding's evidence in the detail pane.
import { Box, Text } from "yeet:tui";
import { analyze, CATEGORY } from "@/lib/report.js";
import { b, t, wrap } from "@/lib/format.js";
import { C } from "@/lib/theme.js";

const CAT_COLOR = { broken: C.broken, overloaded: C.overloaded, slow: C.slow, ok: C.ok };
const SEV_ICON = { crit: "●", warn: "▲", info: "•", ok: "✓" };

// Recompute findings from the live aggregates. Exported so the detail pane and
// the list render the same list.
export const reportFindings = (containers, routes) => analyze(containers, routes);

const tagRun = (category) => b(CAT_COLOR[category] ?? C.label, `[${CATEGORY[category] ?? "—"}]`.padEnd(12));

const findingRow = (f, isSel) => (
  <Box height="1" direction="row" bg={isSel ? C.selBg : undefined}>
    <Text break="none">
      {[
        t(CAT_COLOR[f.category] ?? C.label, ` ${SEV_ICON[f.sev] ?? "•"} `),
        tagRun(f.category), " ",
        b(C.textBold, f.subject),
      ]}
    </Text>
  </Box>
);

export default ({ findings: findingsSig, selected, maxRows }) => (
  <Box direction="column" height="1fr" overflow="hidden">
    <Box height="1" direction="row" bg={C.headerBg}>
      <Text break="none">
        {[
          t(C.label, "  3 ways sick: "),
          b(CAT_COLOR.broken, "broken"), t(C.dim, " · "),
          b(CAT_COLOR.overloaded, "overloaded"), t(C.dim, " · "),
          b(CAT_COLOR.slow, "slow"),
        ]}
      </Text>
    </Box>
    <Box height="1fr" direction="column" overflow="hidden">
      {() => {
        const findings = findingsSig.get();
        if (!findings.length) return [<Box height="1"><Text>{t(C.dim, "  analyzing…")}</Text></Box>];
        const sel = selected.get();
        const out = [];
        for (let i = 0; i < findings.length && i < maxRows; i++) out.push(findingRow(findings[i], i === sel));
        return out;
      }}
    </Box>
  </Box>
);

// --- evidence pane for the selected finding -------------------------------
export const findingDetail = (f, width) => {
  if (!f) return [<Box height="1"><Text>{t(C.dim, "  no finding selected")}</Text></Box>];
  const c = CAT_COLOR[f.category] ?? C.label;
  const out = [];

  out.push(<Box height="1" direction="row"><Text break="none">{[t(c, `  ${SEV_ICON[f.sev] ?? "•"} `), tagRun(f.category)]}</Text></Box>);
  out.push(<Box height="1" direction="row"><Text break="none">{[t(C.dim, "  "), b(C.textBold, f.subject)]}</Text></Box>);
  out.push(<Box height="1"><Text> </Text></Box>);

  for (const ln of wrap(f.text, Math.max(8, (width || 40) - 4))) {
    out.push(<Box height="1" direction="row"><Text break="none">{t(C.label, "  " + ln)}</Text></Box>);
  }
  return out;
};
