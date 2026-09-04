# 09 — Nothing branches on provenance

`pnpm test 09-apps-from-peers` — 22 tests.

There is **no archive** for this rung. Its code survived as `lib/peer.ts` inside
the consolidated shell-core; the tests here are **reconstructed** from note 37
§3–§5 and note 38, and carry `DERIVED-FROM-NOTE` headers. They are the
assertions the notes record as having been made, re-expressed against the live
file — not the original files.

## Goal

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

### Why it mattered

This is the last rung of the original ladder, and the one the other nine were
built to survive. Note 01's premise is a **browser for meshes**: a bootstrap
shell that renders applications served by other peers, where a peer-served app
is as ordinary as a page from a web server. Everything above that premise —
the catalogue as a security boundary, the A2UI message protocol, the module
contract, the dock, layout persistence — was designed on the assumption that
the shell never needs to know *where an application came from*.

Rungs 1 through 8 never tested that assumption, because in all of them the
application was local. This rung is the first time messages arrive from
somewhere else, and its only job is to find out whether anything above
`peer.ts` notices.

**What a "no" would have cost.** If the host had to know whether a surface came
from a local module or a remote peer, then:

- the separation established in note 01 has **leaked**, and "browser for
  meshes" is fiction — a browser does not render differently because a page
  came from a different server;
- every guarantee from earlier rungs would need re-proving *twice*, once per
  provenance, and each new rung would inherit two code paths that must be kept
  in agreement forever;
- and the catalogue would stop being **the** security boundary. Once there is a
  peer path, an ad-hoc filter on it is the obvious place to put a defence, and
  the catalogue quietly becomes a second line behind something nobody audits.
  A mutation in note 37 §4 did exactly this, and made a hostile-peer test pass
  for the wrong reason.

The rung adds no features, so a "yes" buys nothing new; it only preserves what
the previous nine rungs already established. That asymmetry is the point — the
value is entirely in what it fails to break.

## Findings

### Verified

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

#### The mutations

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

## Techniques and APIs

### `lib/peer.ts` — the whole surface

Two types and two functions, and that is deliberately all of it:

```ts
interface PeerTransportSpec {
  readonly peerId: string;                     // opaque to the shell
  messages(): AsyncIterable<A2uiMessage>;      // the app, as a message stream
  send?(event: unknown): void;                 // optional sink for actions
}

interface PeerTransport {
  readonly peerId: string;
  readonly origin: string;                     // "/peer/<id>/" — a PATH
  messages(): AsyncIterable<A2uiMessage>;
  send(event: unknown): void;
}

createPeerTransport(spec): PeerTransport
mountPeerApp(container, transport, catalog, options?): Promise<PeerMount>
```

`createPeerTransport` does one substantive thing: it turns a peer id into
`` `/peer/${peerId}/` ``. **The peer becomes a path, not a special case** — the
dock stores it exactly the way it stores `https://apps.example/notes/`, and the
identical-shape assertion on the serialised layout is what proves the dock
cannot tell them apart.

`mountPeerApp` builds a renderer over the container, wraps `onAction` so
actions go to the transport *and* to the local handler, and then drains the
stream:

```ts
for await (const message of transport.messages()) {
  renderer.handle(message);
}
```

That loop body — one statement, no branch, no filter, no sanitisation pass — is
the entire peer path, and a test asserts it stays that way after comment
stripping. Errors propagate: a peer failing mid-stream rejects the promise and
the shell does not invent a retry policy on the peer's behalf.

The transport is an **async iterable, not a network**. No libp2p, no service
worker, no fetch. That is the scope decision (note 37 §2): the question is
whether the *shell* is indifferent to provenance, and a real transport would
test the mesh instead. Keeping the fake thin is what will make "swapping it for
a libp2p stream requires no change above `peer.ts`" checkable later.

### The A2UI messages both paths share

The reason the two paths can be compared byte for byte is that they are the
same protocol. A local module gets `mountStandalone` + `createAppHost`, which
turns `host.render(components)` and `host.setData(path, value)` into exactly
the messages a peer sends:

| Message | Local module | Peer |
|---|---|---|
| `createSurface` | `createAppHost` sends it on mount | first message in the stream |
| `updateComponents` | `host.render(...)` | streamed |
| `updateDataModel` | `host.setData(...)` | streamed |
| `deleteSurface` | `handle.dispose()` | streamed, or never |

`createSurface` carries a `catalogId` that must match the renderer's own, which
is where a foreign catalogue is refused. Everything else is validated against
`shellCatalog` — six components, and a peer may express those and nothing else.

### Test techniques worth reusing

**A source-level scan for provenance branching.** Tests read
`lib/{renderer,mount,basecoat,dock,catalog}.ts`, strip block comments, line
comments and string literals, and assert zero matches for
`peer|peerId|provenance|remote|untrusted|sandbox|isLocal`. The stripper is
itself guarded (the remaining code must still be non-trivial and contain
`export`), so it cannot pass by eating the file.

This is not decoration. **A behavioural test cannot catch the mutant that grows
a `peerId` option.** Adding `peerId?: string` to `RendererOptions` and
branching on it inside the renderer leaves the byte-identical-DOM test green,
because `peer.ts` does not pass a `peerId` — the property is already lost while
every rendering assertion still holds. Of the five mutations replayed, that one
was caught by the source scan **and by nothing else**.

**Replaying mutations against a scratch copy.** `lib/` is shared and read-only,
so the note 37 §4 mutations were replayed by copying `lib/` and the tests into
a throwaway tree whose relative imports (`../../lib/...`) resolve to the copy,
mutating the copy, running vitest against it, and deleting it. No shared file
was ever edited, and the mutation table above is measured rather than
remembered.

**Asserting both sides of a boundary.** The mutation that escaped the original
suite emitted a structured-JSON origin from the transport, and passed because
the suite checked only the **dock's stored** origin. Every origin assertion
here starts at the transport, then follows the string to the mount and to the
serialised layout, and asserts it survives unchanged and unparseable at each
hop — including for a peer that names itself `{"transport":"libp2p"}`.

**Guarding an equality assertion against vacuity.** Two empty containers have
identical `innerHTML`. The byte-identical test therefore also asserts the
markup is non-empty and that all six components rendered, so the strongest
assertion in the rung cannot pass by rendering nothing.

### Environment gotchas (both cost real time)

- Under **happy-dom**, `import.meta.url` is not a `file:` URL.
  `fileURLToPath(new URL("../../lib/x.ts", import.meta.url))` does not throw —
  it silently yields a path rooted at `/`, so the source-scanning tests failed
  with `ENOENT: /lib/peer.ts`. Resolve from `process.cwd()` instead.
- Under **happy-dom**, `console.log` goes to the DOM's virtual console and
  never reaches the terminal; anything a test needs to *report* must go through
  `process.stdout.write`.
- `dockview-core` 8.2.0 **does** construct and round-trip a layout under
  happy-dom, so the layout assertions run in the same suite as everything else.
  (Its CSS and theming do not work headless, but no assertion here needs them.)

## Lessons learned

**A green provenance-blindness suite must never be read as covering whether a
peer may serve you an app at all.** This is the lesson that matters most, and
it is one sentence away from being misread every time someone sees 22 passing
tests. The catalogue bounds *what* a peer may express. Nothing anywhere asks
*whether* this peer may express anything. Rung 8 built the machinery for that
question and the two have never met (note 38 §3). The suite makes the gap
visible by mounting an app from `an-entirely-unknown-peer`, asserting that it
renders, and asserting at the API surface that `mountPeerApp` has no parameter
through which a capability could be supplied — a test that passes by
**demonstrating an absence**, and that must be changed the day the absence is
filled.

**Provenance blindness currently rests on an assumption, not a mechanism.** The
ServiceWorker route installation that would make a peer-served app addressable
as an ordinary local URL does not exist (note 38 §1). What is demonstrated is
that the shell *does not* distinguish the two paths given a fake that hands it
the same messages a local module would. That is worth having, and it is not the
same as the property being true in a real mesh.

**Where a negative claim lives decides whether a test can check it.** "Nothing
branches on provenance" is a claim about *code*, not about output. Testing it
through rendering catches only branches that are already reachable; testing it
through the source catches the option that nothing passes yet. A rung whose
answer is a negative needs at least one assertion that reads the implementation.

**Mutation testing keeps earning its cost.** Note 38 §7 records that it found a
weak test at rungs 7a, 7b and 9 — three of the four rungs where it was applied,
and in every case the assertion was true but tested the wrong side of a
boundary. Replaying the three historical mutations plus two new ones here took
minutes and is the only reason the mutation table states which test catches
what, instead of asserting that the suite is good.

**Identical error messages are a stronger assertion than "it was rejected".**
The catalogue-gate test compares the peer path's failure to the local path's
*string for string*. "A peer sending `Iframe` fails" would also pass against a
peer-path pre-filter — which is precisely the mutation that made a hostile-peer
test pass for the wrong reason.

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
