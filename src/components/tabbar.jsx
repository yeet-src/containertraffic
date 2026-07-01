// Vertical nav rail — the left column, full body height. Brand chip at the top,
// then the views stacked. The active view is highlighted: BLUE when the rail is
// the focused region, dark slate-teal when focus has moved into the list. Arrow
// keys (and clicks) drive it; there are no number shortcuts.
import { Box, Text } from "yeet:tui";
import { b, t } from "@/lib/format.js";
import { C } from "@/lib/theme.js";

// Views in order — the keys main.jsx navigates and routes to.
export const TABS = [
  { id: "containers", label: "Containers" },
  { id: "routes", label: "Routes" },
  { id: "live", label: "Notable" },
  { id: "report", label: "Report" },
];

// One stacked nav row (fixed width = the rail width passed in).
const navRow = (tab, isActive, railFocused, w) => {
  const label = tab.label.toUpperCase();
  const pad = (s) => (" " + s + " ".repeat(w)).slice(0, w);
  if (isActive) {
    // Blue when the rail is focused, dark accent when the list has focus.
    const bg = railFocused ? C.focusBg : C.railAccent;
    return (
      <Box height="1" direction="row" bg={bg}>
        <Text break="none">{b(C.textBold, pad(label))}</Text>
      </Box>
    );
  }
  return (
    <Box height="1" direction="row">
      <Text break="none">{t(C.label, pad(label))}</Text>
    </Box>
  );
};

export default ({ view, width, railFocused }) => (
  <Box direction="column" width={`${width}`} height="1fr" bg={C.rail} overflow="hidden">
    {/* brand chip */}
    <Box height="1" direction="row" bg={C.railAccent}>
      <Text break="none">{b(C.textBold, " ▌ctraffic")}</Text>
    </Box>
    <Box height="1"><Text> </Text></Box>
    {() => {
      const cur = view.get();
      return TABS.map((tab) => navRow(tab, tab.id === cur, railFocused, width));
    }}
  </Box>
);
