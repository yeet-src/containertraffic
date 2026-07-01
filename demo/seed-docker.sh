#!/usr/bin/env bash
# Real-Docker demo: a handful of named containers, each running demo/app.py with
# a different PROFILE so they tell distinct RED stories. Because they're real
# Docker containers, container-traffic resolves them by container id (the 64-hex in
# their cgroup) to their real names, AND the detail pane's live log tail works (it
# streams docker_logs).
#
# Usage:  sudo demo/seed-docker.sh        # run until Ctrl-C, then clean up
#
# Needs: docker, the python:3-slim image (pulled on first run). Root.
set -u
cd "$(dirname "$0")"
IMAGE="container-traffic-demo"
NAMES=(web-frontend checkout-api auth-svc payments-gw)

cleanup() {
  echo; echo "removing demo containers…"
  for n in "${NAMES[@]}"; do docker rm -f "$n" >/dev/null 2>&1; done
  exit 0
}
trap cleanup INT TERM

# Bake app.py into a one-layer image rather than bind-mounting it — robust
# across hosts (no file-vs-dir mount surprises) and self-contained.
echo "building $IMAGE image…"
docker build -q -t "$IMAGE" -f - . >/dev/null <<'DOCKERFILE'
FROM python:3-slim
COPY app.py /app.py
ENTRYPOINT ["python3", "/app.py"]
DOCKERFILE

run() {
  local name="$1" profile="$2"
  docker rm -f "$name" >/dev/null 2>&1
  docker run -d --name "$name" -e "PROFILE=$profile" "$IMAGE" >/dev/null
  echo "  started $name (profile=$profile)"
}

echo "starting demo containers…"
run web-frontend web
run checkout-api checkout
run auth-svc     auth
run payments-gw  payments

echo
echo "containers up. run the dashboard in another shell:  sudo yeet run -t ."
echo "On the Containers view, select a row; the detail pane tails its logs."
echo "Ctrl-C here to stop and remove them."
# idle until interrupted
while true; do sleep 3600; done
