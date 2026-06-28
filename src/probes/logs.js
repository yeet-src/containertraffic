// Container logs — the stdout/stderr drill-down. Unlike everything else here
// this is NOT BPF: it streams the daemon's docker_logs subscription for one
// chosen container. Lives in probes/ because it's an external data source the
// components shouldn't know the shape of; it exposes a plain signal.
//
// Logs only exist for real Docker containers, so this is gated by
// dockerNameOf() in the UI — the "host" bucket and non-docker cgroup scopes
// have nothing to show.
import { signal } from "yeet:tui";
import { dockerNameOf } from "@/lib/containers.js";

const MAX_LINES = 500;

// The container whose logs we're tailing (display name), and the lines.
export const logTarget = signal(null);
export const logLines = signal([]); // [{ stream, text }]  newest last
export const logStatus = signal(""); // "", "streaming", "no logs for <x>", error

// docker_logs is a Subscription returning a LogOutput union (stdout | stderr |
// console), each carrying { message }. follow:true keeps it live; tail seeds
// recent history. tail is a STRING in this schema (not Int).
const query = (name) => `subscription {
  docker_logs(container_name: "${name}", opts: { follow: true, stdout: true, stderr: true, tail: "200" }) {
    __typename
    ... on stdout { message }
    ... on stderr { message }
    ... on console { message }
  }
}`;

let ticket = null;
let buf = [];

function teardown() {
  if (ticket) {
    yeet.graph.unsubscribe(ticket).catch(() => {});
    ticket = null;
  }
  buf = [];
}

// Point the log stream at a container (by display name), or null to stop.
export function openLogs(displayName) {
  teardown();
  logTarget.set(displayName);
  logLines.set([]);

  if (!displayName) { logStatus.set(""); return; }

  const dockerName = dockerNameOf(displayName);
  if (!dockerName) {
    logStatus.set(`${displayName}: not a Docker container — no logs`);
    return;
  }

  logStatus.set(`streaming ${displayName}…`);
  try {
    ticket = yeet.graph.subscribe(query(dockerName), (r) => {
      const node = (r?.data ?? r)?.docker_logs;
      if (!node) {
        if (r?.__error) logStatus.set(`logs error: ${String(r.__error).slice(0, 60)}`);
        return;
      }
      const stream = node.__typename || "stdout";
      // A message may carry several newline-separated lines; split them.
      for (const raw of String(node.message ?? "").split("\n")) {
        if (raw === "") continue;
        buf.push({ stream, text: raw });
      }
      if (buf.length > MAX_LINES) buf = buf.slice(-MAX_LINES);
      logLines.set(buf.slice());
    });
  } catch (e) {
    logStatus.set(`logs failed: ${e?.message ?? e}`);
  }
}

export function closeLogs() { openLogs(null); }
