# Running the containertraffic demo

A reproducible scene for screenshots / the README GIF: four containers running
a deliberately mixed HTTP workload so all three RED stories show at once — and,
because they're real Docker containers, attribution resolves them by **name**
and the detail pane's live log tail works.

What you'll see:

| Container      | Profile                              | Story it tells          |
|----------------|--------------------------------------|-------------------------|
| `web-frontend` | high volume, healthy, fast           | baseline / OVERLOADED (most traffic) |
| `checkout-api` | a slow `/checkout` route (200-500ms) | **SLOW** (high p95/p99) |
| `auth-svc`     | `/flaky` (500s) + `/missing` (404s)  | **BROKEN** (high err%)  |
| `payments-gw`  | `/charge` `/refund` + outbound HTTPS | a 4th service + logs    |

## Prerequisites

- Linux with eBPF + BTF, root, and **Docker**. On macOS, do all of this inside
  the Lima VM (`limactl shell yeet.debian-13`); the host repo is mounted
  read-only, so work in a writable copy in the VM home (`~/containertraffic`).
- A built project: `make` (needs `bin/probe.bpf.o` and `src/index.jsx`).
- `demo/seed-docker.sh` builds a tiny image from `demo/app.py` on first run.

## Steps

Two shells in the VM, both in the project dir (`~/containertraffic`).

**Shell A — start the containers:**

```sh
sudo demo/seed-docker.sh    # builds the image, runs 4 named containers
```

Leave it running; Ctrl-C removes the containers on exit. (If you launch it over
a transient `limactl shell -- ...` one-liner the background job can be killed
when the SSH session ends — run it from an interactive shell, or start the
containers directly with `docker run -d` as the script does.)

**Shell B — run the dashboard:**

```sh
sudo yeet run -t .          # -t forces a PTY (required under sudo)
```

Give it ~10 seconds to accumulate a window of metrics (percentiles and error
rates need a few hundred requests to read true).

## Controls

Two focus regions, driven entirely by the arrow keys (or `hjkl`):

- **Rail** (left nav): `↑`/`↓` switch view — Containers · Routes · Notable ·
  Report — and `→` steps into the list.
- **List** (middle): `↑`/`↓` move the row selection; `←` returns to the rail.
- The detail pane on the right mirrors the selected row live; on the
  **Containers** view it tails that container's logs automatically as the
  cursor moves — no keypress, no drill-down to open.
- `+`/`-` raise/lower the slow-request floor; `r` reset counters; `q` quit.
- Mouse: click a rail item to switch view, click a list row to select it.

## Recording tips

- Make the terminal **≥110 columns** wide before launching, so names and the
  p95/p99 columns don't truncate.
- The workload loops continuously, so bars and percentiles stay live.
- A nice arc: open on **Containers** (the top), `→` into the list, scroll to
  `auth-svc` so the detail pane tails its error logs, back to `checkout-api` to
  show its slow routes, then `←` `↓` to **Notable** and into a failing request,
  then **Report** for the verdict.

## Cleanup

`Ctrl-C` in Shell A, or:

```sh
for n in web-frontend checkout-api auth-svc payments-gw; do
  sudo docker rm -f "$n" 2>/dev/null
done
```

## No-Docker fallback

`demo/seed.sh` runs the same workload via `systemd-run` cgroup scopes instead
of Docker. It needs no Docker daemon and still exercises HTTP capture + RED
metrics + cgroup attribution (rows show the scope name), but the detail pane's
log tail stays empty (no `docker_logs` for a bare scope).
