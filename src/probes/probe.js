// Shared BPF object. The single src/bpf/containertop.bpf.c unit is linked
// into bin/probe.bpf.o and loaded once here; the containertop data layer
// imports this `control` and reads its ring buffer. All binds/attaches
// happen before the single start().
//
// Capture programs feeding one ring buffer, each tagging its events:
//   on_sendmsg / on_recv (kprobes, auto-attached) — SRC_WIRE: cleartext HTTP.
//   on_ssl_write / on_ssl_read (uprobes on libssl) — SRC_TLS: inside HTTPS.
// Both the easy (plaintext) and hard (encrypted) cases, in one stream.
import { BpfObject } from "yeet:bpf";

// The TLS path attaches uprobes to the HOST's libssl (the only target the
// yeet:bpf uprobe API supports — it takes a bare library name, not a path or
// pid, and there is no post-start attach). So it captures HTTPS from processes
// using the system libssl. A container that ships its OWN libssl inside its
// image is a different library this uprobe can't reach, so in-container HTTPS
// is NOT captured in v1 — see README "Honest caveats". Plaintext (the wire
// kprobes) is attributed for containers regardless.
//
// `base: import.meta.dirname` resolves against the running bundle.
const cfg = { exe: "../bin/probe.bpf.o", base: import.meta.dirname };

// The SSL uprobe programs are linked into the same object as the wire kprobes,
// and the loader requires EVERY uprobe program to have attach opts at start()
// — so we can't selectively skip them. We attach both to the host libssl,
// which is present on any normal Linux (it's the system OpenSSL). If that fails
// the whole object fails to load; that's an environment problem worth
// surfacing loudly, not silently degrading to a half-broken state.
//
// tlsActive is true when these attached (host TLS is being captured). It does
// NOT mean in-container HTTPS is seen — see the README caveat.
export let tlsActive = false;
export const control = await new BpfObject(cfg)
  .bind("events", { kind: "ringbuf", btf_struct: "http_event" }) // unified stream
  // min_latency_ms is zero-initialized, so libbpf places it in .bss (not
  // .data). Bind that section; the live filter is patched here via DataSec.
  .bind("probe.bss", { kind: "data" })
  .attach("on_ssl_write", { kind: "uprobe", binary: "libssl.so", symbol: "SSL_write" })
  .attach("on_ssl_read", { kind: "uprobe", binary: "libssl.so", symbol: "SSL_read" })
  .start();
tlsActive = true;

export const numCpus = system.numCpus;
