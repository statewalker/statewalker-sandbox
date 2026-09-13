# 15 — Can a libp2p connection hand out MessagePorts?

`pnpm test 15-ports`

**Answer: yes — one libp2p stream is one port — and the dividing line for
"runs over the mesh unchanged" is not the type, it is TRANSFER.**

The requirements document describes the mesh as a connection that yields ports.
Nothing in the repo did that. `webrun-rpc` ships `byteChannelFromMessagePort`
(a port, seen as bytes) and nothing going the other way, which is the direction
a mesh needs: **a libp2p stream, seen as a port.**

## Verified

| # | Claim | What would falsify it |
|---|---|---|
| 1 | A message posted on one side arrives on the other, in order, both ways | any loss, reorder, or corruption of a structured value |
| 2 | The port carries the **proven** remote peer | `peerId` not matching what Noise established |
| 3 | **webrun-rpc's port stack runs over it unchanged** — a fifth parity column | any of rung 11's eight scenarios failing |
| 4 | A transport that **transfers** ports cannot cross the mesh | `sendHttpRequest` succeeding over a mesh port |
| 5 | **The remedy**: `multiplexPort` gives virtual ports that do cross | no port arriving at the responder's `onPort` |
| 6 | Transferables are refused, not silently copied | `postMessage(msg, [port])` returning normally |
| 7 | Closing one side is observable to the other | `closed` never resolving |

Measured 2026-09-12, all seven pass. Claim 3 runs all eight scenarios in 99 ms.

```
Port-over-libp2p column:
  ✓ GET /hello → 200                 ✓ GET /secret without a token → 401
  ✓ POST /echo round-trips a body    ✓ GET /secret with a valid token → 200
  ✓ POST /echo survives 256 KiB      ✓ GET /secret with a foreign token → 403
  ✓ a query string is not lost       ✓ GET /nothing-here → 404
```

## One stream is one port

The tempting alternative — one stream carrying `multiplexPort` — runs our
multiplexer inside yamux's: two credit systems stacked, with no way to tell
which one stalled. yamux already opens cheap independent streams with its own
flow control, so **the mesh's multiplexing stays yamux's** and this layer adds
none. Identity comes from `serveConnections`' `ConnectionContext`, captured per
stream by closure — the same seam rung 11 uses, because a duplex has no
`Request` to hang a `WeakMap` off.

## Claim 4 asserted the opposite when it was written

The reasoning was clean and wrong: `handleHttpRequests`/`sendHttpRequest` are
typed against a `MessageTarget` and never mention a browser, so they should run
over a mesh port unchanged. Running it said otherwise on the very first call —

```js
communicationPort.postMessage({ type: "START_CALL" }, [channel.port2])
```

— the ServiceWorker transport **transfers a real `MessagePort` per call**.
Transfer moves ownership between two agents in one process. A mesh stream
copies bytes between machines; there is no ownership to move, and no framing
invents one.

So the limit belongs to that transport, not to the mesh, and the repo already
names the way across it: `transferPortMux`'s own docstring says *"use
`multiplexPort` where the transport is one pipe of bytes"*. A mesh stream is
one pipe of bytes. Claim 5 runs it and virtual ports cross.

**This is the finding that matters for the library.** "Isomorphic" cannot mean
"anything holding a `MessageTarget` works everywhere". It means: *no transfer
in the contract*. A seam that transfers ports is a same-process seam wearing a
portable type.

## Three defects in this rung's own adapter, each found by running it

1. **JSONL framing silently destroyed binary.** A real `MessagePort` carries a
   `Uint8Array` by structured clone; `JSON.stringify` turns one into
   `{"0":1,"1":2,…}`. Every byte-oriented consumer — `byteChannelFromMessagePort`,
   and therefore webrun-rpc's whole `connect`/`serve` stack — saw a plain
   object, ignored it, and **hung with no error anywhere**. Framing is
   length-prefixed msgpack now.
2. **Inbound messages were dropped before anyone listened.** A real port
   *queues* until `start()`. `serve()` is awaited, so the caller's first bytes
   routinely beat its listener — another silent hang. There is a backlog now,
   flushed on the first `addEventListener` or `start()`.
3. **The queue has to predate the generator.** `newAsyncGenerator`'s init runs
   on the first *pull*, so an early `postMessage` would touch an unassigned
   `push` — rung 09 recorded this exact trap, and `postMessage` is
   fire-and-forget by contract, so it cannot await its way out.

Two of the three presented as a **hang with no error**, which is the
signature of this whole family: a transport that drops what it does not
understand tells nobody.

## And one in webrun-rpc, found by `tsc`

`PortParams.port` and `byteChannelFromMessagePort` were typed `MessagePort`
though neither uses more than the `MessageTarget` surface — the narrowing shut
out every virtual port, including the one this rung exists to build. Widened at
the source; 120 tests still pass. Rung 07 was built to make the compiler judge
sufficiency, and here it did.

## Not covered

- **Structured clone beyond msgpack.** `Map`, `Set`, `Date`, cyclic
  references and `ArrayBuffer` views other than `Uint8Array` are not tested;
  msgpack covers the JSON types plus binary and no more.
- **Backpressure.** `postMessage` is fire-and-forget by contract, so a fast
  producer over a slow mesh queues in `pending` without bound. Where
  backpressure matters, the duplex altitude (rung 09) is the right seam.
- **Port count.** One port per stream is cheap, but nothing here opens
  thousands to find where yamux's `maxInboundStreams` bites.
- **Browser.** Node only; a page would reach the mesh through the gateway
  (rung 08) or the SW site (rung 14), neither of which needs this adapter.
