// The opinionated Report — what you're actually looking for, ranked. This is
// what makes containertraffic a TOOL, not a readout.
//
// The lens is the RED method, but stated the way an on-call engineer thinks:
// the three ways a service gets sick.
//
//   BROKEN     — Errors. 4xx/5xx share is high. The thing is returning
//                failures to users right now. (RED: E)
//   OVERLOADED — Rate. Request rate is high / spiking — demand is the story,
//                and it's where capacity or a retry storm shows up. (RED: R)
//   SLOW       — Duration. Tail latency (p99) is high even if the average
//                looks fine. Users feel the tail. (RED: D)
//
// analyze() turns the live container + route aggregates into a sorted list of
// findings, each with a severity, a category (broken/overloaded/slow/ok), and
// a one-line "so what". Pure: aggregates in, findings out. No signals, no BPF.

// Tunable thresholds. Deliberately conservative defaults; a v2 could expose
// these as flags / SLA inputs.
const TH = {
  errWarn: 2, // % errors -> watch
  errBad: 10, // % errors -> broken
  p99Warn: 300, // ms p99 -> watch
  p99Bad: 1000, // ms p99 -> slow
  hotShare: 40, // % of total traffic from one container -> overloaded-ish
  spikeRate: 200, // req/s on a single container -> high demand
};

// Severity ranks so the most urgent finding sorts to the top.
const SEV = { crit: 3, warn: 2, info: 1, ok: 0 };

// Category → headline verb, used by the report view for the colored tag.
export const CATEGORY = {
  broken: "BROKEN",
  overloaded: "OVERLOADED",
  slow: "SLOW",
  ok: "HEALTHY",
};

const finding = (sev, category, subject, text) => ({ sev, rank: SEV[sev], category, subject, text });

// Build the ranked findings list from the live container + route arrays
// (already projected by the data layer: {name,rate,errRate,p99,share,...}).
export function analyze(containers, routes) {
  const out = [];

  if (!containers.length) {
    return [finding("info", "ok", "—", "No HTTP traffic observed yet. Generate some requests through a container.")];
  }

  // --- BROKEN: containers returning errors ---------------------------------
  for (const c of containers) {
    if (c.errRate >= TH.errBad) {
      out.push(finding("crit", "broken", c.name,
        `${c.errRate.toFixed(0)}% of requests are failing (${c.errs} of ${c.count}). Users are hitting errors.`));
    } else if (c.errRate >= TH.errWarn) {
      out.push(finding("warn", "broken", c.name,
        `${c.errRate.toFixed(0)}% error rate — above the ${TH.errWarn}% watch line.`));
    }
  }

  // --- SLOW: tail latency, not average -------------------------------------
  for (const c of containers) {
    if (c.p99 >= TH.p99Bad) {
      out.push(finding("crit", "slow", c.name,
        `p99 latency is ${Math.round(c.p99)}ms (p50 ${Math.round(c.p50)}ms). The slow tail is what users feel.`));
    } else if (c.p99 >= TH.p99Warn) {
      out.push(finding("warn", "slow", c.name,
        `p99 latency ${Math.round(c.p99)}ms — creeping up while p50 sits at ${Math.round(c.p50)}ms.`));
    }
  }

  // --- OVERLOADED: demand / concentration ----------------------------------
  for (const c of containers) {
    if (c.rate >= TH.spikeRate) {
      out.push(finding("warn", "overloaded", c.name,
        `handling ${c.rate.toFixed(0)} req/s right now — the busiest service; watch capacity and retries.`));
    } else if (c.share >= TH.hotShare && containers.length > 1) {
      out.push(finding("info", "overloaded", c.name,
        `${c.share.toFixed(0)}% of all observed HTTP traffic flows through this one container.`));
    }
  }

  // --- worst single route, for a concrete next click -----------------------
  const worstRoute = routes
    .filter((r) => r.count >= 5)
    .sort((a, b) => (b.errRate - a.errRate) || (b.p99 - a.p99))[0];
  if (worstRoute && (worstRoute.errRate >= TH.errWarn || worstRoute.p99 >= TH.p99Warn)) {
    const why = worstRoute.errRate >= TH.errWarn
      ? `${worstRoute.errRate.toFixed(0)}% errors`
      : `p99 ${Math.round(worstRoute.p99)}ms`;
    out.push(finding("warn", worstRoute.errRate >= TH.errWarn ? "broken" : "slow", worstRoute.route,
      `worst endpoint: ${why} across ${worstRoute.containers.join(", ")}.`));
  }

  // --- all clear -----------------------------------------------------------
  if (!out.length) {
    const busiest = containers[0];
    out.push(finding("ok", "ok", busiest.name,
      `Nothing sick: errors low, p99 within bounds. Busiest is ${busiest.name} at ${busiest.rate.toFixed(0)} req/s.`));
  }

  return out.sort((a, b) => b.rank - a.rank);
}
