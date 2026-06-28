// Key-hint rail — uses the shared theme (not hardcoded kit colors) so it
// matches containertop's slate identity. Each shortcut is a keycap on a slate
// tile then a dim label.
import { Box, Text, face } from "yeet:tui";
import { t } from "@/lib/format.js";
import { C } from "@/lib/theme.js";

// A keycap (bold light text on a slate tile) + a dim label, as styled runs.
const hint = (keys, label) => [
  face({ fg: C.textBold, bg: C.selBg, bold: true })(` ${keys} `),
  t(C.label, ` ${label}   `),
];

export default () => (
  <Box height="1" direction="row" bg={C.rail}>
    <Text break="none">
      {[
        " ",
        ...hint("1-4", "tab"),
        ...hint("↑↓", "select"),
        ...hint("+/-", "slow floor"),
        ...hint("r", "reset"),
        ...hint("q", "quit"),
      ]}
    </Text>
  </Box>
);
