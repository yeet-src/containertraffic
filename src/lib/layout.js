// Layout model — a three-column master/detail shell:
//
//   ┌──────┬─────────────────────┬──────────────────────┐
//   │ rail │  list (middle)      │  detail (right)       │
//   │ tabs │  the active view's  │  the selected row's   │
//   │ vert │  rows, selectable   │  detail, live         │
//   └──────┴─────────────────────┴──────────────────────┘
//
// A full-width TitleBar sits above this band and a full-width Footer below it.
// Pure: given {cols, rows} it hands each column its width and the body its
// visible-row budget. Components fill the numbers; they never guess their size.

const clamp = (lo, v, hi) => Math.max(lo, Math.min(hi, v));

const RAIL_W = 14;   // vertical tab rail — fits the longest tab label + air
const MIN_DETAIL = 30; // a detail pane narrower than this isn't worth showing
const MIN_LIST = 36;   // keep the list readable before we steal from it

export const layoutFor = ({ cols, rows }) => {
  // Body sits between the 1-row titlebar and the 1-row footer.
  const body = Math.max(3, rows - 2);
  const maxRows = Math.max(1, body - 2); // minus a column-header row + spacer

  const rail = RAIL_W;
  const rest = Math.max(0, cols - rail);

  // Detail takes ~42% of the non-rail width, clamped; the list gets the rest.
  // On a narrow terminal the detail pane drops out entirely (narrow mode) so
  // the list stays usable.
  let detail = clamp(MIN_DETAIL, Math.round(rest * 0.42), 64);
  let list = rest - detail;
  const narrow = list < MIN_LIST || rest < MIN_LIST + MIN_DETAIL;
  if (narrow) { list = rest; detail = 0; }

  return {
    maxRows,
    cols,
    rail,
    list,
    detail,
    narrow,                  // true → hide the detail pane, list spans the rest
    report: { width: clamp(20, list - 2, 120) }, // findings wrap to the list col
  };
};

// Screen-row geometry for mouse hit-testing. The titlebar occupies screen row
// 0, so the body starts at row 1. These offsets MUST track the components:
//   - rail (tabbar.jsx): brand chip (body row 0), spacer (1), tabs (2..5)
//   - list header: 1 row for most views, 2 rows for Notable (bar + col header)
// `firstListRow(view)` is the screen row of the first data row in the middle.
export const RAIL_FIRST_TAB_ROW = 1 + 2; // screen row of the first rail tab
export const firstListRow = (view) => (view === "live" ? 1 + 2 : 1 + 1);
