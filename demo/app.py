#!/usr/bin/env python3
# One self-contained demo service: an HTTP backend with deliberately mixed
# behavior, plus a client loop that drives traffic to itself, plus log output
# so the container has real stdout/stderr for the logs drill-down.
#
# Run inside a Docker container named for the service; the PROFILE env var
# shapes the workload so each container tells a different RED story.
#
#   PROFILE=web       high volume, healthy, fast        -> baseline / overloaded
#   PROFILE=checkout  slow /checkout (200-500ms)        -> SLOW
#   PROFILE=auth      /flaky (500s) + /missing (404s)   -> BROKEN
#   PROFILE=payments  outbound HTTPS + a 404 route      -> encrypted split
#
# stdlib only (works on python:3-slim with no pip).
import os, sys, time, random, threading, urllib.request, ssl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROFILE = os.environ.get("PROFILE", "web")
PORT = 8080

def log(msg, err=False):
    f = sys.stderr if err else sys.stdout
    print(f"[{PROFILE}] {msg}", file=f, flush=True)

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass  # we do our own logging

    def do_GET(self):
        p = self.path.split("?")[0]
        code = 200
        if p == "/checkout":
            time.sleep(random.uniform(0.20, 0.50))      # slow tail
        elif p == "/flaky" and random.random() < 0.30:
            code = 500
        elif p.startswith("/missing/"):
            code = 404
        body = b"ok\n"
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        # Log a line per request — this is what the logs drill-down shows.
        if code >= 500:
            log(f"ERROR {self.command} {p} -> {code}", err=True)
        elif code >= 400:
            log(f"WARN  {self.command} {p} -> {code}", err=True)
        else:
            log(f"{self.command} {p} -> {code}")

def serve():
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()

def get(url, ctx=None):
    try:
        urllib.request.urlopen(url, timeout=5, context=ctx).read()
    except Exception:
        pass  # 4xx/5xx raise; we don't care about the client's view here

def client():
    base = f"http://127.0.0.1:{PORT}"
    tls = ssl.create_default_context()
    while True:
        if PROFILE == "web":
            for _ in range(6):
                get(f"{base}/"); get(f"{base}/static/app.css")
        elif PROFILE == "checkout":
            get(f"{base}/checkout"); get(f"{base}/api/users/{random.randint(1,9999)}")
        elif PROFILE == "auth":
            get(f"{base}/flaky"); get(f"{base}/missing/{random.randint(1,9999)}")
        elif PROFILE == "payments":
            # Plaintext calls to its own API so it shows as a real container row
            # with logs. (Outbound HTTPS to example.com is also attempted, but
            # containerized TLS via the container's own libssl isn't captured by
            # the host-side SSL uprobe in v1 — see the README caveat.)
            get(f"{base}/charge"); get(f"{base}/refund")
            get("https://example.com/", tls)
        time.sleep(0.15)

if __name__ == "__main__":
    log(f"starting service (profile={PROFILE}) on :{PORT}")
    threading.Thread(target=serve, daemon=True).start()
    time.sleep(0.5)
    client()
