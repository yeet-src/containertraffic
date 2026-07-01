// container-traffic — "top for your containers' HTTP traffic".
//
// Watches HTTP at the socket layer with zero application instrumentation,
// attributes every request to the container that made it (by cgroup id),
// and measures per-request round-trip latency. Two capture paths feed one
// ring buffer so we see BOTH cleartext and TLS:
//
//   PLAINTEXT WIRE (kprobes on the same socket):
//     tcp_sendmsg(sk, msg, size)   — a request goes out. Copy the first
//                                    bytes, parse the HTTP request line
//                                    (METHOD SP path SP HTTP/x), stash
//                                    {ts, method, path, cgroup} by `sock *`.
//     tcp_cleanup_rbuf(sk, copied) — the response has been consumed. Look
//                                    up the stashed request, parse the
//                                    status code off the response line
//                                    ("HTTP/1.1 200"), take now-ts as the
//                                    latency, emit one event, clear it.
//
//   TLS (uprobes on libssl, plaintext BEFORE encryption):
//     SSL_write(ssl, buf, num)     — the request, parsed like the wire path
//                                    and stashed by the SSL* pointer.
//     SSL_read (ssl, buf, num)     — the response; matched to the stashed
//                                    request by SSL*, status parsed, emitted.
//
// HTTP/1.x request and status lines are plaintext and newline-delimited, so
// the first frame is parseable in BPF without reassembling the stream. v1
// tradeoff: it does not decode HTTP/2 (binary HPACK) — that traffic is
// simply not matched and shows nothing, rather than garbage.
//
// The runtime knob `min_latency_ms` is the kernel-side filter: userspace
// patches it (via DataSec) and we only emit requests at least that slow,
// so the ring buffer stays calm under load.
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_tracing.h>

char LICENSE[] SEC("license") = "Dual BSD/GPL";

#define TASK_COMM_LEN 16
#define METHOD_LEN    8   // longest method we keep (OPTIONS, CONNECT, DELETE)
#define PATH_LEN      64  // request path, truncated
#define PEEK_LEN      64  // bytes of the buffer we copy to parse a line. Drives
                          // the parser's verifier complexity quadratically; 64
                          // keeps on_sendmsg well under kernel 6.1's limit (96
                          // was rejected there). Long request paths truncate a
                          // little sooner, which the route-pattern collapse in
                          // JS absorbs.
#define CG_NAME_LEN   96  // leaf cgroup name; fits "docker-<64hex>.scope" (78)

// Slow-request floor in milliseconds, patched live from the UI. Default 0:
// emit everything until the user raises the bar. Kept in .data (volatile,
// referenced) so the bound section stays `<obj>.data`. Must match
// `minLatency`'s initial value in probes/container-traffic.js.
volatile __u64 min_latency_ms = 0;

// How a request was observed — the dual-source proof.
#define SRC_WIRE 0 // TCP-layer probe — cleartext HTTP, any client
#define SRC_TLS  1 // SSL_write/SSL_read uprobe — INSIDE encrypted connections

// One observed HTTP request/response pair, streamed to userspace.
struct http_event {
	__u64 cgroup_id;          // cgroup that issued it — container attribution
	__u32 pid;
	__u32 lat_ms;             // request -> response round trip
	__u32 status;             // HTTP status code (e.g. 200, 404, 0 if unknown)
	__u32 req_bytes;          // request size on the wire
	__u32 resp_bytes;         // bytes consumed for the response (approx)
	__u32 source;             // SRC_WIRE | SRC_TLS
	char comm[TASK_COMM_LEN]; // client process
	char method[METHOD_LEN];  // GET, POST, ...
	char path[PATH_LEN];      // request path, truncated
	char cgroup[CG_NAME_LEN]; // leaf cgroup name — contains the container id
};

// Force BTF emission so the daemon resolves btf_struct: "http_event".
struct http_event *_unused_event __attribute__((unused));

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 256 * 1024);
} events SEC(".maps");

// In-flight request, keyed by the connection handle (sock* on the wire path,
// SSL* on the TLS path). Holds everything we need to emit on the response.
struct inflight {
	__u64 ts;
	__u64 cgroup_id;
	__u32 pid;
	__u32 req_bytes;
	__u32 source;
	char comm[TASK_COMM_LEN];
	char method[METHOD_LEN];
	char path[PATH_LEN];
	char cgroup[CG_NAME_LEN];
};

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 16384);
	__type(key, __u64);   // (__u64)sock*  or  (__u64)SSL*
	__type(value, struct inflight);
} inflight SEC(".maps");

// Read the leaf cgroup directory name of the current task into `dst`. On
// cgroup v2 a docker/containerd container's leaf is named for its 64-char
// container id (e.g. the kernfs node name is the long hex id, or a
// "docker-<id>.scope" under systemd); userspace matches this prefix against
// the container list to resolve a human name. Bare-metal tasks get names like
// "init.scope" / "user.slice", which userspace buckets as host. Best-effort:
// on any read failure dst stays empty and the event attributes to "host".
static __always_inline void read_cgroup_name(char *dst, int sz)
{
	struct task_struct *task = (struct task_struct *)bpf_get_current_task();
	const char *name = BPF_CORE_READ(task, cgroups, dfl_cgrp, kn, name);
	if (name) bpf_probe_read_kernel_str(dst, sz, name);
}

// Is this the start of an HTTP request line? Cheap pre-filter so we don't
// stash garbage from non-HTTP sockets, then lift the method + path. The
// trailing " HTTP/" check is the strongest guard against false positives.
//
// Implementation note (the verifier): we make EXACTLY ONE pass over the buffer
// using the compile-time loop counter `j` as the only index, driving a small
// state machine in scalar registers. Indexing solely by the constant `j` keeps
// every access at a fixed stack offset, so clang never lowers it to runtime
// pointer arithmetic (which the verifier rejects: "bitwise operator on pointer
// prohibited"). A running index that's masked still trips that lowering when
// clang can prove the index small enough to fold into an OR — so we avoid a
// running index entirely.
//
// States: 0 = reading METHOD, 1 = reading PATH, 2 = at the space before
// " HTTP/", 3 = verifying the "HTTP/" tag. `mi`/`pi` are output cursors,
// bounded by their array sizes so writes stay in range.
//
// Complexity note: this loop's cost grows quadratically with PEEK_LEN, and
// kernel 6.1's verifier is stricter than 6.6+ about the resulting state count.
// Two things keep it under 6.1's limit: PEEK_LEN is 64 (not 96), and the
// METHOD phase bails after METHOD_LEN bytes — without that early exit the
// method-scanning branch fans out across the whole window and on_sendmsg
// balloons to ~575k insns / ~17k states (rejected on 6.1); with it, ~66k / ~2k.
static __always_inline int parse_request_line(const char *buf, int len, struct inflight *fl)
{
	if (len < 5) return 0;
	if (len > PEEK_LEN) len = PEEK_LEN;

	char c0 = buf[0];
	if (c0 < 'A' || c0 > 'Z') return 0; // every method starts uppercase

	int state = 0, mi = 0, pi = 0, tag = 0;

	for (int j = 0; j < PEEK_LEN; j++) {
		if (j >= len) break;
		char c = buf[j]; // j is loop-bounded — the verifier tracks it as in-range

		if (state == 0) {            // METHOD
			if (c == ' ') { if (mi == 0) return 0; state = 1; continue; }
			if (c < 'A' || c > 'Z') return 0; // methods are letters only
			if (j >= METHOD_LEN) return 0;    // no method is this long -> not HTTP
			// Mask with size-1 (METHOD_LEN is a power of two) so the write
			// offset is provably in range; cap the cursor one below the last
			// slot to keep a trailing NUL.
			fl->method[mi & (METHOD_LEN - 1)] = c;
			if (mi < METHOD_LEN - 2) mi++;
		} else if (state == 1) {     // PATH (until the space before HTTP/)
			if (c == ' ') { state = 2; continue; }
			if (c == '\r' || c == '\n') return 0; // no version → not HTTP
			fl->path[pi & (PATH_LEN - 1)] = c;
			if (pi < PATH_LEN - 2) pi++;
		} else {                     // state == 2: match "HTTP/" after the space
			const char want[5] = { 'H', 'T', 'T', 'P', '/' };
			if (c != want[tag]) return 0;
			tag++;
			if (tag == 5) return 1; // confirmed a real request line
		}
	}
	return 0; // ran out of buffer before confirming "HTTP/"
}

// Parse the status code off an HTTP response line: "HTTP/1.1 200 OK".
// Returns the 3-digit code, or 0 if the buffer isn't a response.
// One pass, constant index only (same verifier rationale as the request line).
// States: 0 = matching "HTTP/", 1 = skipping the version to the space,
// 2 = collecting the 3 status digits. dig0..2 hold the code as we read it.
static __always_inline __u32 parse_status(const char *buf, int len)
{
	if (len < 12) return 0;
	if (len > PEEK_LEN) len = PEEK_LEN;
	if (!(buf[0] == 'H' && buf[1] == 'T' && buf[2] == 'T' && buf[3] == 'P' && buf[4] == '/'))
		return 0;

	int state = 1; // we've matched HTTP/ via the constant check above
	int ndig = 0;
	__u32 code = 0;

	#pragma unroll
	for (int j = 5; j < PEEK_LEN; j++) {
		if (j >= len) break;
		char c = buf[j];
		if (state == 1) {
			if (c == ' ') state = 2; // reached the gap before the status code
		} else {                     // state == 2: three ASCII digits
			if (c < '0' || c > '9') return 0;
			code = code * 10 + (__u32)(c - '0');
			if (++ndig == 3) return code;
		}
	}
	return 0;
}

// Pull the first PEEK_LEN bytes of a tcp_sendmsg payload out of the iov_iter.
// Modern kernels store a single user buffer inline as ITER_UBUF (ptr in
// `ubuf`); a classic iovec array is ITER_IOVEC (ptr in `__iov->iov_base`).
// Branch on iter_type — this is the one fragile read on the wire path.
static __always_inline long read_sendmsg_buf(struct msghdr *msg, char *buf, int sz)
{
	__u8 itype = BPF_CORE_READ(msg, msg_iter.iter_type);
	const void *base = NULL;
	if (itype == ITER_UBUF) {
		base = BPF_CORE_READ(msg, msg_iter.ubuf);
	} else if (itype == ITER_IOVEC) {
		const struct iovec *iov = BPF_CORE_READ(msg, msg_iter.__iov);
		if (iov) base = BPF_CORE_READ(iov, iov_base);
	}
	if (!base) return -1;
	return bpf_probe_read_user(buf, sz, base);
}

// --- Plaintext wire path --------------------------------------------------

SEC("kprobe/tcp_sendmsg")
int BPF_KPROBE(on_sendmsg, struct sock *sk, struct msghdr *msg, size_t size)
{
	char buf[PEEK_LEN] = {};
	if (read_sendmsg_buf(msg, buf, sizeof(buf)) != 0) return 0;

	struct inflight fl = {};
	if (!parse_request_line(buf, PEEK_LEN, &fl)) return 0;

	fl.ts = bpf_ktime_get_ns();
	fl.cgroup_id = bpf_get_current_cgroup_id();
	fl.pid = bpf_get_current_pid_tgid() >> 32;
	fl.req_bytes = (__u32)size;
	fl.source = SRC_WIRE;
	bpf_get_current_comm(&fl.comm, sizeof(fl.comm));
	read_cgroup_name(fl.cgroup, sizeof(fl.cgroup));

	__u64 key = (__u64)sk;
	bpf_map_update_elem(&inflight, &key, &fl, BPF_ANY);
	return 0;
}

// The response: to lift the STATUS CODE on the plaintext path we need the
// bytes the server sent back, and tcp_cleanup_rbuf doesn't carry them. So we
// pair an entry+return probe on tcp_recvmsg instead:
//   entry  — stash (sock*, msghdr*) for this thread; the msghdr's iov is the
//            user buffer the kernel is about to fill with the response.
//   return — that buffer now holds the response; read its head, parse
//            "HTTP/1.1 <code>", compute latency against the stashed request,
//            and emit. This is what makes "broken" real for cleartext HTTP.
struct recv_ctx {
	struct sock *sk;
	struct msghdr *msg;
};

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 16384);
	__type(key, __u64);            // pid_tgid of the reading thread
	__type(value, struct recv_ctx);
} recvctx SEC(".maps");

SEC("kprobe/tcp_recvmsg")
int BPF_KPROBE(on_recvmsg, struct sock *sk, struct msghdr *msg)
{
	// Only bother if we have a request in flight on this socket.
	__u64 skkey = (__u64)sk;
	if (!bpf_map_lookup_elem(&inflight, &skkey)) return 0;

	__u64 tid = bpf_get_current_pid_tgid();
	struct recv_ctx rc = { .sk = sk, .msg = msg };
	bpf_map_update_elem(&recvctx, &tid, &rc, BPF_ANY);
	return 0;
}

SEC("kretprobe/tcp_recvmsg")
int BPF_KRETPROBE(on_recvmsg_ret, int ret)
{
	__u64 tid = bpf_get_current_pid_tgid();
	struct recv_ctx *rc = bpf_map_lookup_elem(&recvctx, &tid);
	if (!rc) return 0;
	struct sock *sk = rc->sk;
	struct msghdr *msg = rc->msg;
	bpf_map_delete_elem(&recvctx, &tid);

	if (ret <= 0) return 0; // no bytes read — not the response yet

	__u64 skkey = (__u64)sk;
	struct inflight *fl = bpf_map_lookup_elem(&inflight, &skkey);
	if (!fl) return 0;

	// The response now lives in the user read buffer (same iov_iter layout as
	// the send path: ITER_UBUF or ITER_IOVEC).
	char buf[PEEK_LEN] = {};
	if (read_sendmsg_buf(msg, buf, sizeof(buf)) != 0) {
		// Couldn't read the buffer; still emit with latency, status unknown.
		buf[0] = 0;
	}
	__u32 status = parse_status(buf, PEEK_LEN);

	__u64 lat_ms = (bpf_ktime_get_ns() - fl->ts) / 1000000;
	if (lat_ms < min_latency_ms) {
		bpf_map_delete_elem(&inflight, &skkey);
		return 0;
	}

	struct http_event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e) {
		bpf_map_delete_elem(&inflight, &skkey);
		return 0; // ring full — drop is the backpressure
	}
	e->cgroup_id = fl->cgroup_id;
	e->pid = fl->pid;
	e->lat_ms = (__u32)lat_ms;
	e->status = status; // 0 if the head wasn't in the first PEEK_LEN bytes
	e->req_bytes = fl->req_bytes;
	e->resp_bytes = (__u32)ret;
	e->source = SRC_WIRE;
	__builtin_memcpy(e->comm, fl->comm, sizeof(e->comm));
	__builtin_memcpy(e->method, fl->method, sizeof(e->method));
	__builtin_memcpy(e->path, fl->path, sizeof(e->path));
	__builtin_memcpy(e->cgroup, fl->cgroup, sizeof(e->cgroup));
	bpf_ringbuf_submit(e, 0);

	bpf_map_delete_elem(&inflight, &skkey);
	return 0;
}

// --- TLS path: plaintext HTTP at the OpenSSL boundary ---------------------
// SSL_write carries the request, SSL_read the response — both before/after
// encryption, so this works through HTTPS. We stash the request by SSL* on
// write and complete it on read, lifting the status code from the response
// (which we DO have here, unlike the wire path). Latency is the SSL_write ->
// SSL_read gap, a good proxy for server round-trip.

SEC("uprobe/SSL_write")
int BPF_KPROBE(on_ssl_write, void *ssl, const void *buf, int num)
{
	if (!buf || num <= 0) return 0;

	char tmp[PEEK_LEN] = {};
	if (bpf_probe_read_user(tmp, sizeof(tmp), buf) != 0) return 0;

	struct inflight fl = {};
	if (!parse_request_line(tmp, PEEK_LEN, &fl)) return 0;

	fl.ts = bpf_ktime_get_ns();
	fl.cgroup_id = bpf_get_current_cgroup_id();
	fl.pid = bpf_get_current_pid_tgid() >> 32;
	fl.req_bytes = (__u32)num;
	fl.source = SRC_TLS;
	bpf_get_current_comm(&fl.comm, sizeof(fl.comm));
	read_cgroup_name(fl.cgroup, sizeof(fl.cgroup));

	__u64 key = (__u64)ssl;
	bpf_map_update_elem(&inflight, &key, &fl, BPF_ANY);
	return 0;
}

SEC("uprobe/SSL_read")
int BPF_KPROBE(on_ssl_read, void *ssl, void *buf, int num)
{
	__u64 key = (__u64)ssl;
	struct inflight *fl = bpf_map_lookup_elem(&inflight, &key);
	if (!fl) return 0; // response on a connection we didn't see a request for

	if (!buf || num <= 0) return 0;
	char tmp[PEEK_LEN] = {};
	if (bpf_probe_read_user(tmp, sizeof(tmp), buf) != 0) return 0;

	__u32 status = parse_status(tmp, PEEK_LEN);
	if (status == 0) return 0; // not the response head (could be a body chunk)

	__u64 lat_ms = (bpf_ktime_get_ns() - fl->ts) / 1000000;
	if (lat_ms < min_latency_ms) {
		bpf_map_delete_elem(&inflight, &key);
		return 0;
	}

	struct http_event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e) {
		bpf_map_delete_elem(&inflight, &key);
		return 0;
	}
	e->cgroup_id = fl->cgroup_id;
	e->pid = fl->pid;
	e->lat_ms = (__u32)lat_ms;
	e->status = status;
	e->req_bytes = fl->req_bytes;
	e->resp_bytes = (__u32)num;
	e->source = SRC_TLS;
	__builtin_memcpy(e->comm, fl->comm, sizeof(e->comm));
	__builtin_memcpy(e->method, fl->method, sizeof(e->method));
	__builtin_memcpy(e->path, fl->path, sizeof(e->path));
	__builtin_memcpy(e->cgroup, fl->cgroup, sizeof(e->cgroup));
	bpf_ringbuf_submit(e, 0);

	bpf_map_delete_elem(&inflight, &key);
	return 0;
}
