# 17 — A port factory: one consumer, every kind of transport

`pnpm test 17-port-factory`

**Answer: it works, the consumer is twenty lines, and on libp2p the second
multiplexer disappears entirely.**

## The question

`webrun-rpc`'s `connect`/`serve` take **one `MessageTarget`** and manufacture
many virtual ports from it with an id table. From a single pipe there is no
other way to get a second port, so that is right for a `MessagePort` or a
WebSocket — and wrong for libp2p, which already multiplexes. Rung 15 does
exactly that and its own comments warn against it: *"two credit systems stacked
with no way to tell which one stalled."*

The proposal is to invert it. Don't take a port; take a **source of ports**, and
let whoever builds the source decide how ports are made:

| Transport | Port source | Id table? |
|---|---|---|
| one pipe of bytes (`MessagePort`, WebSocket) | `multiplexPort` | **yes** — there is no alternative |
| a transferable boundary (browser, worker, iframe) | `transferPortMux` | no — the platform moves real ports |
| a libp2p connection | **`libp2pPortMux`** (this rung) | no — yamux already did it |

**`PortMux` is already that abstraction.** `openPort()` outbound, `onPort`
inbound, `maxMessageSize` reported. The missing piece was an implementation for
libp2p, which is `src/libp2p-port-mux.ts`.

## Verified

| # | Claim | What would falsify it |
|---|---|---|
| 1 | Over a `MessagePort`, the source is `multiplexPort` — all 8 of rung 11's scenarios pass | any scenario failing |
| 2 | Over libp2p, **the same consumer code** passes all 8 with no id table | needing a single change to `over-port-mux.ts` |
| 3 | One call is one libp2p stream — yamux is the only multiplexer | a shared stream, or a count that is not 1:1 |
| 4 | A stream built and never iterated opens **no** port at all | any stream opened for a call that never ran |

Measured 2026-09-13, all four pass.

## What the consumer becomes

```ts
const call = callOverPortMux(mux);            // caller
const { onPort, stop } = serveOverPortMux(h); // server, wired into the mux
```

Three things leave the API, and each is a leak today:

- **`side`** (`"initiator"`/`"responder"`) is id parity — `multiplexPort`'s
  private business. A caller over libp2p has no ids and no parity, and today's
  signature makes them pass one anyway.
- **`maxPorts`** bounds an id table that may not exist.
- **`maxMessageSize`** stops being a *parameter* and becomes something the mux
  **reports**, which is where it belonged: a libp2p stream has no message
  ceiling, a LiveKit data channel does, and neither is the consumer's to know.

## The one wrinkle, stated plainly

`multiplexPort` takes `onPort` in its **options**, at construction. So a serving
consumer must be wired *before* the mux exists, and `serve` cannot simply accept
a finished `PortMux` — it has to return the callback the mux is then built with.
That is why `serveOverPortMux` is shaped the way it is.

Two ways out if this is adopted: give `PortMux` a subscribable `onPort` instead
of a construction-time one, or keep the factory shape and pass
`(onPort) => PortMux`. This rung takes neither — it demonstrates the mechanism
and leaves the API choice open.

## Why lazy opening matters more here

Over a `MessagePort` an eagerly opened port costs an id. **Over libp2p it costs
a whole stream**, held open on the peer for a call that never arrives. Claim 4
is the guard, and it is the reason the port is opened on the consumer's first
pull rather than when `call` is invoked.

## Not covered

- **`transferPortMux` is not exercised.** It is a real `PortMux` and should
  drop straight in, but "should" is not a measurement, and the browser harness
  this would need is rung 14's, not this one's.
- **No flow-control comparison.** Claims 1 and 2 prove the scenarios pass on
  both sources; nothing here measures whether removing the inner id table
  changes throughput or stall behaviour. The bounded-memory property is
  `duplexOverPort`'s and is measured in `webrun-rpc`'s own suite.
- **Nothing here is wired into `httpeers-libp2p`.** The extraction's transport
  uses `webrun-streams-libp2p` directly and opens a libp2p stream per call
  already — so it gets the right shape without this seam. What the seam buys is
  *the same consumer* also running over a `MessagePort` or a WebSocket, which
  is what "the stack over any kind of port" would mean.
