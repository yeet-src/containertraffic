// Pure presentation helpers — strings and color, no signals or BPF.
// Imported by the components through the `@/` alias (resolved at bundle time).
import { face } from "yeet:tui";
import { C, heatColor } from "@/lib/theme.js";

// Styled-run helpers. A <Text>'s children are an array of styled runs built
// with face({...})(str) — the fg()/bold() combinators were removed from
// yeet:tui and the daemon doesn't render nested <Text>, so face() runs are the
// portable styling form. `t(color, s)` = colored run; `b(color, s)` = bold.
export const t = (color, s) => face({ fg: color })(s);
export const b = (color, s) => face({ fg: color, bold: true })(s);

export const pad = (s, n) => (String(s) + " ".repeat(n)).slice(0, n);
export const lpad = (s, n) => (" ".repeat(n) + String(s)).slice(-n);

// A rate as a short string: 12, 4.2K, 1.1M (per second).
export const fmtRate = (perSec) => {
  if (perSec < 1000) return `${Math.round(perSec)}`;
  if (perSec < 1e6) return `${(perSec / 1e3).toFixed(1)}K`;
  return `${(perSec / 1e6).toFixed(1)}M`;
};

// A count as a short string: 530, 1.2K, 3.4M.
export const fmtCount = (n) => {
  if (n < 1000) return `${n}`;
  if (n < 1e6) return `${(n / 1e3).toFixed(1)}K`;
  return `${(n / 1e6).toFixed(1)}M`;
};

// A latency in milliseconds as a short string: 4ms, 120ms, 2.3s.
export const fmtLat = (ms) => {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

// A byte count as B / KB / MB / GB.
export const fmtBytes = (b) => {
  if (b < 1024) return `${b}B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)}KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)}MB`;
  return `${(b / 1024 ** 3).toFixed(1)}GB`;
};

// A horizontal share bar (0..100 percent) of fixed width. The filled portion
// is heat-colored; the remainder is a DIM track (░) so the bar always has a
// crisp, fixed length and reads as a real gauge. Returns an ARRAY of styled
// runs (via face(), the runtime-computed face form) — callers spread it into a
// <Text>'s children.
const FULL = "█";
const PARTS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const TRACK = "░";
export const bar = (pct, width) => {
  const frac = Math.max(0, Math.min(1, pct / 100)) * width;
  const whole = Math.floor(frac);
  const rem = Math.floor((frac - whole) * 8);
  const filled = FULL.repeat(whole) + PARTS[rem];
  const track = TRACK.repeat(Math.max(0, width - filled.length));
  return [face({ fg: heatColor(pct) })(filled), face({ fg: C.dim })(track)];
};

// Word-wrap a string to `width` columns, returning an array of lines. Greedy;
// a word longer than the width is hard-split so nothing overflows. Used by the
// Report tab to wrap prose findings.
export const wrap = (text, width) => {
  const w = Math.max(1, width);
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/)) {
    if (!word) continue;
    if (word.length > w) {
      if (line) { lines.push(line); line = ""; }
      let rest = word;
      while (rest.length > w) { lines.push(rest.slice(0, w)); rest = rest.slice(w); }
      line = rest;
    } else if (!line) {
      line = word;
    } else if (line.length + 1 + word.length <= w) {
      line += " " + word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
};

// Ramp a 0..100 share onto cool→warm so a dominant entry reads hot.
export const shareColor = (pct) => heatColor(pct);

// Color an error rate (0..100) as a three-band gauge, so red stays reserved for
// a real problem (the taste rule) instead of firing at the first failed
// request: clean is quiet (dim, not a loud green), a low error share is amber
// (worth a glance), and only a meaningful share turns red (broken).
//   0%      → dim      (no signal — don't shout "healthy" in green)
//   <1%     → ok       (a stray failure; green reassurance)
//   1–5%    → overloaded(amber, climbing)
//   ≥5%     → broken   (red — this is the problem)
export const errColor = (pct) =>
  pct <= 0 ? C.dim : pct < 1 ? C.ok : pct < 5 ? C.overloaded : C.broken;

// Color an HTTP status code by class: 2xx green, 3xx plaintext-teal, 4xx amber
// (a client warning, not a page), 5xx red. 4xx uses the `overloaded` amber —
// NOT C.tls — so violet stays a single meaning (encrypted traffic) across the
// whole UI instead of doubling as "client error".
export const statusColor = (s) => {
  if (s >= 500) return C.broken;
  if (s >= 400) return C.overloaded;
  if (s >= 300) return C.wire;
  if (s >= 200) return C.ok;
  return C.dim;
};

// Source → row color. Encrypted (TLS) wins: any encrypted traffic colors the
// row pink (the encrypted story is the point); pure-plaintext rows are blue.
export const srcColor = (encShare) => (encShare > 0 ? C.tls : C.wire);

// Color a latency (ms) against the SAME slow floor the Notable tab tunes with
// +/-, so the whole UI agrees on what "slow" means. Below the floor a latency
// is ordinary chrome (dim); at or past it, it's the violet SLOW signal. The
// list renderers pass the live slowMs here instead of a hardcoded 1000ms —
// which had them disagreeing with the feed's own threshold (default 200ms).
export const latColor = (ms, slowMs) => (ms >= slowMs ? C.slow : C.dim);
