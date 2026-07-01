// containertraffic's palette — its OWN visual identity, distinct from the other
// scripts in the series (no shared kit pinks/blues). Built around the tool's
// mental model, the three ways a service gets sick:
//
//     BROKEN = red      OVERLOADED = amber      SLOW = violet      ok = green
//
// Chrome is a cool SLATE (not the kit's near-black), so the tool reads as a
// calm console with the RED triad as the only loud colors. Discipline kept
// from the kit: dim chrome recedes, data is bright, strong color = meaning.
import { idx } from "yeet:tui";

// The signature triad — exported on their own so components/report share one
// source of truth for broken/overloaded/slow coloring.
export const BROKEN = idx(203); // red
export const OVERLOADED = idx(214); // amber
export const SLOW = idx(135); // violet
export const OK = idx(78); // green

export const C = {
  // Surfaces — cool slate, a touch lighter and bluer than the kit's black.
  rail: idx(237),        // header/footer rail bg (slate)
  railAccent: idx(24),   // brand chip / active-tab base (deep slate-teal)
  headerBg: idx(238),    // column-header row bg
  selBg: idx(240),       // selected row, RESTING (region not focused) — dark slate
  focusBg: idx(25),      // selected row / rail item, FOCUSED — blue highlight
  // Chrome / text
  dim: idx(243),         // separators, faint chrome (slate-gray)
  label: idx(248),       // column labels, hints
  text: idx(253),        // primary data text (bright)
  textBold: idx(231),    // emphasized data (white)
  name: idx(252),        // container / route / verb names
  // Meaning — the RED triad + the dual-source pair.
  broken: BROKEN,
  overloaded: OVERLOADED,
  slow: SLOW,
  ok: OK,
  warn: BROKEN,          // legacy alias used by errColor etc.
  tls: idx(141),         // encrypted accent (soft violet — distinct from slow)
  wire: idx(73),         // plaintext (muted teal)
  // Share/heat ramp: green -> amber -> red (health gradient, not a rainbow).
  heat: [78, 114, 150, 220, 214, 208, 203, 196].map(idx),
};

export { idx };

// Heat color for a 0..100 share (cool/healthy -> hot).
export const heatColor = (pct) => {
  const r = C.heat;
  return r[Math.min(r.length - 1, Math.max(0, Math.floor((pct / 100) * r.length)))];
};
