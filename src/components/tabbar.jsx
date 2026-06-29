// Vertical tab rail — the left column, full body height. Brand chip at the top,
// then the tabs stacked; the active tab is a bright slate-teal tile with its
// number in cyan, inactive tabs recede. containertraffic's own chrome (the series'
// other scripts use a horizontal top bar — this reads as a different tool).
import { Box, Text, idx } from "yeet:tui";
import { b, t } from "@/lib/format.js";
import { C } from "@/lib/theme.js";

const ACTIVE_BG = C.railAccent;
const ACTIVE_FG = C.textBold;
const NUMC = idx(81); // bright cyan for the active number

// Tabs in cycle order — must match the keys in main.jsx's VIEWS / cycle.
export const TABS = [
  { id: "containers", label: "Containers" },
  { id: "routes", label: "Routes" },
  { id: "live", label: "Notable" },
  { id: "report", label: "Report" },
];

// One stacked tab row (fixed width = the rail width passed in).
const tabRow = (tab, n, isActive, w) => {
  const label = tab.label.toUpperCase();
  // The number prefix " N " takes 3 cols; the label fills the rest of the rail.
  const lw = Math.max(1, w - 3);
  const labelPad = (label + " ".repeat(lw)).slice(0, lw);
  if (isActive) {
    return (
      <Box height="1" direction="row" bg={ACTIVE_BG}>
        <Text break="none">{[b(NUMC, ` ${n} `), b(ACTIVE_FG, labelPad)]}</Text>
      </Box>
    );
  }
  return (
    <Box height="1" direction="row">
      <Text break="none">{[t(C.dim, ` ${n} `), t(C.label, labelPad)]}</Text>
    </Box>
  );
};

export default ({ view, width }) => (
  <Box direction="column" width={`${width}`} height="1fr" bg={C.rail} overflow="hidden">
    {/* brand chip */}
    <Box height="1" direction="row" bg={C.railAccent}>
      <Text break="none">{b(C.textBold, " ▌ctop")}</Text>
    </Box>
    <Box height="1"><Text> </Text></Box>
    {() => {
      const cur = view.get();
      return TABS.map((tab, i) => tabRow(tab, i + 1, tab.id === cur, width));
    }}
  </Box>
);
