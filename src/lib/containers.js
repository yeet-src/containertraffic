// cgroup name -> container identity. This is the one piece that makes this a
// CONTAINER top rather than a process top.
//
// The kernel tags each HTTP event with its leaf cgroup directory name. On
// cgroup v2 a container's leaf encodes its container id:
//   docker         "docker-<64hex>.scope"   (systemd cgroup driver)
//   docker/cgroupfs "<64hex>"                (cgroupfs driver)
//   containerd/k8s  "cri-containerd-<id>.scope", "crio-<id>.scope", etc.
// Bare-metal processes get leaves like "init.scope" / "user.slice" / a unit
// name — those don't match any container and bucket as "host". That bucket is
// honest: it's "HTTP we saw that isn't a tracked container", not a fabricated
// zero.
//
// We resolve by extracting a 64-hex (or short 12-hex) container id from the
// cgroup name and matching it against the daemon's container list. The graph
// has no cgroup field, so the id embedded in the cgroup name is the bridge —
// and it needs no privileged extra lookup.
import { signal } from "yeet:tui";

// container id (full or 12-char short) -> { name, image, short, state }
const byId = new Map();

export const containerCount = signal(0);

const pretty = (c) => {
  let n = c?.name ?? (c?.names && c.names[0]) ?? c?.id ?? "?";
  if (n.startsWith("/")) n = n.slice(1);
  return n;
};

// The real graph shape (verified in-VM): docker { list_containers { ... } }
// returning Container with id/name/image/state. No cgroup field exists, hence
// the id-in-cgroup-name bridge above.
const QUERY = `{
  docker {
    list_containers {
      id
      name
      names
      image
      state
    }
  }
}`;

// Pull a container id out of a leaf cgroup name. Returns "" if none — i.e. not
// a container (host task). Matches a 64-hex id anywhere in the string, or a
// "<driver>-<id>.scope" form; falls back to a bare long-hex leaf.
const idFromCgroup = (cg) => {
  if (!cg) return "";
  const m = cg.match(/([0-9a-f]{64})/i) || cg.match(/-([0-9a-f]{12,})\.scope/i) || cg.match(/^([0-9a-f]{12,})$/i);
  return m ? m[1] : "";
};

// cgroup leaves that mean "not a container" — kernel/root/init/login slices.
// Traffic under these is genuinely un-attributable host traffic.
const isHostLeaf = (cg) =>
  !cg ||
  cg === "" ||
  /^(init|user|system)\.slice$/.test(cg) ||
  /^(init|user@\d+|user-\d+)\.(scope|service|slice)$/.test(cg) ||
  cg === "/" ||
  cg === "init.scope";

// Strip the systemd suffix and any leading path so a scope leaf reads as a
// plain name: "checkout-api.scope" -> "checkout-api".
const cleanLeaf = (cg) => {
  let n = cg.split("/").filter(Boolean).pop() || cg;
  n = n.replace(/\.(scope|service|slice)$/, "");
  return n.length > 24 ? n.slice(0, 23) + "…" : n;
};

// Resolve a kernel cgroup name (string) to a container label.
//  1. If the leaf embeds a container id the docker graph knows, use that name.
//  2. Else if it's a real, named cgroup (a systemd scope, a container whose
//     name we couldn't look up), show the cleaned leaf — it IS the container.
//  3. Only genuinely unscoped kernel/login slices fall back to "host".
export function nameFor(cgroupName) {
  const id = idFromCgroup(cgroupName);
  if (id) {
    const hit = byId.get(id) || byId.get(id.slice(0, 12));
    if (hit) return hit.name;
    return id.slice(0, 12); // a container we couldn't name — show its short id
  }
  if (isHostLeaf(cgroupName)) return "host";
  return cleanLeaf(cgroupName);
}

export function metaFor(cgroupName) {
  const id = idFromCgroup(cgroupName);
  const hit = id && (byId.get(id) || byId.get(id.slice(0, 12)));
  return hit ?? { name: "host", image: "—", short: "—", state: "—" };
}

async function refresh() {
  let data;
  try {
    const res = await yeet.graph.query(QUERY);
    if (res.errors) return; // schema drift — keep the last good table
    data = res.data;
  } catch {
    return; // transient
  }
  const list = data?.docker?.list_containers ?? [];
  byId.clear();
  byDisplayName.clear();
  for (const c of list) {
    const id = c.id ?? "";
    if (!id) continue;
    const short = id.slice(0, 12);
    const name = pretty(c);
    const entry = { name, image: c.image ?? "—", short, state: c.state ?? "—" };
    byId.set(id, entry); // full id
    byId.set(short, entry); // and the short id, for either match form
    byDisplayName.set(name, name); // display name == docker container_name
  }
  containerCount.set(list.length);
}

// Is this display name a real Docker container the graph knows (so its logs
// are fetchable), as opposed to the "host" bucket or a non-docker cgroup
// scope? Returns the container_name to pass to docker_logs, or null.
const byDisplayName = new Map();
export function dockerNameOf(displayName) {
  if (!displayName || displayName === "host") return null;
  return byDisplayName.get(displayName) ?? null;
}

let started = false;
export function startContainerResolver() {
  if (started) return;
  started = true;
  refresh().catch(() => {});
  setInterval(() => refresh().catch(() => {}), 2000);
}
