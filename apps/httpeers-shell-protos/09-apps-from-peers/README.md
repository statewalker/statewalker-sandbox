# 09 — Nothing branches on provenance

`pnpm test 09-apps-from-peers` — 22 tests.

**Question**: do the earlier rungs keep working when the applications arrive
from a peer instead of from a local module?

**Answer: yes, and nothing in the shell can tell the difference.** A peer-served
app and a local module render to **byte-identical** `innerHTML`, and the files
that build the DOM contain no peer, remote, provenance or sandbox concept in
executable code at all.

This rung adds no features. Its entire value is in what it fails to break, so
its reject condition is a negative — *anything in the shell that branches on
provenance* — and a negative has to be asserted directly, not inferred from a
rendering test passing.

There is **no archive** for this rung. Its code survived as `lib/peer.ts` inside
the consolidated shell-core; the tests here are **reconstructed** from note 37
§3–§5 and note 38, and carry `DERIVED-FROM-NOTE` headers. They are the
assertions the notes record as having been made, re-expressed against the live
file — not the original files.

## Verified

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 1 | A peer-served app and a local module produce **the same DOM, byte for byte** | The same six-component tree is delivered twice — through `mountStandalone` and as a stream of A2UI messages through `mountPeerApp` — and `innerHTML` is compared, with a non-emptiness guard so equality cannot be satisfied by two blank containers | The peer path adds any wrapper, marker attribute, class or sanitisation pass |
| 2 | The peer id leaks into no rendered attribute, class or element | The mounted markup is matched against `/12D3KooWabc\|peer\|provenance\|sandbox/i` | Any of them appears in the surface |
| 3 | **Nothing in the render path can branch on provenance** | `lib/renderer.ts`, `mount.ts`, `basecoat.ts`, `dock.ts` and `catalog.ts` are read, comments and string literals stripped, and searched for `peer`, `peerId`, `provenance`, `remote`, `untrusted`, `sandbox`, `isLocal`. Zero hits | Any of those files names the concept in code — even a `peerId?: string` option nothing passes yet |
| 4 | `mountPeerApp`'s message loop does nothing but forward | The loop body, comments stripped, is exactly `renderer.handle(message);` | A filter, a conditional or a rewrite appears in the peer path |
| 5 | The renderer is handed nothing peer-shaped | `createRenderer(container, catalog, {…})` — no fourth argument, no `peerId` in the call | Peer identity reaches the renderer at all |
| 6 | The **catalogue is the only gate** | A peer sending `Iframe` and a local module sending `Iframe` fail with the **identical error message**, compared string to string | The peer path rejects it first — the catalogue would silently become a second line of defence behind an ad-hoc filter |
| 7 | Peer text never becomes markup | `<img src=x onerror=…>` arrives as `Text`; no `<img>` exists afterwards, the handler never fires, and `textContent` is the literal string | The renderer ever uses `innerHTML` for a bound or literal value |
| 8 | An unknown `catalogId` from a peer is refused at `createSurface` | The mount rejects with `Unsupported catalog` and the container stays empty | A foreign catalogue is accepted, and the enumeration of what a peer may express stops being fixed |
| 9 | Two peers keep **separate data models** | Two mounts, two `updateDataModel` values, both read back distinct | The renderers share state |
| 10 | A mid-stream transport failure **propagates**, and the shell survives it | The stream throws after two messages: the mount rejects, the partial content is still in the DOM, and a subsequent mount of a different peer succeeds | The error is swallowed, or one peer's failure takes the shell with it |
| 11 | Actions travel back to the **transport** *and* to the local handler | A click asserts on both: `onAction` fired once with the right event, and `transport.send` received `{type:"action", …}` with the data-model snapshot | Either side is missed. Note 37 §4 records a mutation escaping precisely because a test checked one side of a boundary and not the other |
| 12 | The transport's **own** origin is an opaque path, and is not JSON | `transport.origin === "/peer/12D3KooWabc/"`, `JSON.parse` on it throws, and it contains no `{}[]":` — asserted on the transport first, then on the mount, then on the dock | The origin carries structure that something downstream will eventually parse |
| 13 | A hostile peer id cannot force structure into the origin | A peer naming itself `{"transport":"libp2p"}` still yields a path that fails `JSON.parse` | The id is interpolated somewhere that makes the origin parseable |
| 14 | Layout serialisation is **unchanged** by a peer | A peer-backed pane and an `https://` pane serialise to params with the *same keys* (`["origin"]`) and the same `contentComponent`; the whole document matches no `peerId\|transport\|libp2p\|provenance`; both origins survive a `fromJSON` round trip | A peer pane serialises to a different shape from a web pane — that difference *is* the shell knowing what a peer is |

### The mutations

Note 37 §4 records three deliberate defects, one of which escaped the original
suite. All three were replayed here against a scratch copy of `lib/` (the real
one is shared and read-only), plus two of our own:

| Mutation | Caught by |
|---|---|
| Peer path wraps content in a `.peer-sandbox` div | 4 tests, including #1 |
| Peer path pre-filters disallowed components | #6 and #4 |
| **Transport origin emits structured JSON** — *the one that escaped* | #12 (three ways) and #14 |
| Action never travels back to the transport | #11 |
| `renderer.ts` grows a `peerId` option and branches on it | **#3 only** |

The last is the reason #3 is a source-level test and not a rendering one. A
renderer that knows what a peer is renders identically until something passes
it a peer — the DOM comparison stays green while the property is already lost.

## What this does **not** establish

Note 38 is blunt about this, and a green run here must not be read as covering
any of it.

- **Nothing checks whether a peer is permitted to serve you an application at
  all.** The catalogue bounds *what* a peer may express; nobody asks *whether*
  this peer may express anything. Rung 8 built the capability machinery and the
  two have never met (note 38 §3 flags this gap hardest). A test here mounts an
  app from `an-entirely-unknown-peer` and asserts that it renders — passing by
  demonstrating the absence — and asserts at the API surface that
  `mountPeerApp` has no parameter through which a capability could be supplied.
  **This is the ladder's biggest open security question.**
- **Provenance blindness rests on an assumption, not a mechanism.** The
  ServiceWorker route installation that would make a peer-served app
  addressable as an ordinary local URL does not exist (note 38 §1). What is
  demonstrated is that the shell *does not* distinguish the two paths, given a
  fake that hands it the same messages a local module would. A test asserts
  that no ServiceWorker, `navigator.*` or `fetch()` appears anywhere in the
  render path — the absence is real, and it is an absence of the mechanism as
  much as of a leak.
- **There is no transport.** No libp2p, no service worker, no network.
  `PeerTransport` is an async iterable, deliberately thin (note 37 §2), so that
  "swapping it for a real stream requires no change above `peer.ts`" stays
  checkable. It is **set up, not proven**.
- **`mountPeerApp` drains the stream to completion before returning.** A live
  peer's stream never completes, so this shape fits a finite handshake and not
  a session. A test pins the behaviour: content reaches the DOM incrementally,
  but the promise does not settle until the stream ends.
- **Nothing re-requests content after a layout restore.** Rung 7a stores
  `origin` and this rung proves it survives; nothing turns it back into a
  transport.
- **`send()` is fire-and-forget.** There is no response path, so a peer cannot
  acknowledge or reject an action.
- **`theme` on `createSurface` is accepted and ignored.** Honouring a
  peer-supplied theme is a security question nobody has answered.
