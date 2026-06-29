#!/usr/bin/env python3
# A tiny HTTP backend with deliberately mixed behavior, so containertraffic has
# something interesting to show: healthy routes, a route that 404s, a route
# that 500s, and a slow route. Each fake "container" runs one of these.
#
#   /            -> 200, fast
#   /api/users/N -> 200, fast
#   /static/...  -> 200, fast
#   /checkout    -> 200 but SLOW (200-500ms) — the "slow" story
#   /flaky       -> 500 ~30% of the time — the "broken" story
#   /missing/N   -> 404 — client asking for things that aren't there
import sys, time, random
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def do_GET(self):
        p = self.path.split("?")[0]
        body = b"ok\n"
        code = 200
        if p == "/checkout":
            time.sleep(random.uniform(0.20, 0.50))  # slow tail
        elif p == "/flaky":
            if random.random() < 0.30:
                code = 500
        elif p.startswith("/missing/"):
            code = 404
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

if __name__ == "__main__":
    port = int(sys.argv[1])
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
