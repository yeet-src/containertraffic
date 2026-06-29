#!/usr/bin/env bash
# Spin up a few fake "containers" so containertraffic has named rows with mixed
# RED behavior to show. Each service runs in its own systemd cgroup scope
# (<name>.scope), which containertraffic attributes to a named row exactly like a
# real container's cgroup. Each scope runs an HTTP backend plus a client loop
# generating realistic traffic; one client uses HTTPS so the encrypted path
# lights up.
#
# Usage:  sudo demo/seed.sh           # run until Ctrl-C, then it cleans up
#
# Needs: systemd-run, python3, curl. Root (cgroup scopes + the probe need it).
set -u
cd "$(dirname "$0")"

PIDS=()
SCOPES=()

cleanup() {
  echo; echo "tearing down demo scopes…"
  for s in "${SCOPES[@]}"; do systemctl stop "$s" 2>/dev/null; done
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  exit 0
}
trap cleanup INT TERM

# scope name | port | client traffic profile
# profiles drive which routes the client hits, shaping each row's RED signature.
start_service() {
  local name="$1" port="$2" profile="$3"
  # Backend AND its client loop run in ONE scope named "<name>.scope", so all
  # of this service's HTTP (the outbound curls) attributes to "<name>" — just
  # like a real container that both serves and makes requests. containertraffic
  # keys on the cgroup of whoever issues the request (the curl), so the client
  # must live in this scope for the row to read "<name>".
  systemd-run --scope --quiet --unit="${name}" bash -c "
    python3 backend.py $port &
    sleep 0.3
    while true; do
      case '$profile' in
        web)      # high volume, healthy, fast
          for i in \$(seq 1 6); do curl -s http://127.0.0.1:$port/ >/dev/null; curl -s http://127.0.0.1:$port/static/app.css >/dev/null; done ;;
        checkout) # slower, the 'slow' story
          curl -s http://127.0.0.1:$port/checkout >/dev/null
          curl -s http://127.0.0.1:$port/api/users/\$RANDOM >/dev/null ;;
        auth)     # error-prone, the 'broken' story
          curl -s http://127.0.0.1:$port/flaky >/dev/null
          curl -s http://127.0.0.1:$port/missing/\$RANDOM >/dev/null ;;
      esac
      sleep 0.15
    done
  " &
  PIDS+=($!); SCOPES+=("${name}.scope")
}

echo "starting fake containers…"
start_service web-frontend 8101 web
start_service checkout-api 8102 checkout
start_service auth-svc     8103 auth

# An HTTPS client in its own scope: exercises the TLS path (SSL_write/SSL_read)
# so the 'encrypted' split is non-zero. Forces HTTP/1.1 (v1 sees h1, not h2).
systemd-run --scope --quiet --unit=payments-gw bash -c '
  while true; do
    curl -s --http1.1 https://example.com/ >/dev/null 2>&1
    curl -s --http1.1 https://example.com/missing-xyz >/dev/null 2>&1
    sleep 0.4
  done
' &
PIDS+=($!); SCOPES+=("payments-gw.scope")

echo "traffic flowing. run containertraffic in another shell:  sudo yeet run -t ."
echo "Ctrl-C here to stop and clean up."
wait
