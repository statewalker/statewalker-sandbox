# 06 — Can a remote peer's app render as a page that can reach only that peer?

`pnpm test 06-ghost-pin`

**Answer: the pin holds, and the containment has one hole that the documented
remedy does not close.** A host peer's HTML renders in the viewer through the
real ServiceWorker edge; the rendered page cannot reach any other peer; but a
**root-absolute URL escapes the ghost and reads the viewer's own origin**.

The mesh hop is stubbed deliberately — rung 01 already carries a real call
between two peers. What was unproven is the ISOLATION, so the assertions that
matter here are about what does *not* get through.

## Verified

| # | Claim | Where |
|---|---|---|
| 1 | A request through the ghost reaches the pinned peer, under the host's own mount (`/app/asset.txt`), never the viewer's | Node |
| 2 | The viewer's token is attached for the pinned peer | Node |
| 3 | A path naming another peer is **refused 403, and nothing is dialled** | Node |
| 4 | No input makes the pin name a different peer — `..`, encoded `..`, query, fragment | Node |
| 5 | The host's page **renders** in an iframe through `SwHttpAdapter`, and its relative fetch reaches the host | Chromium |
| 6 | **A root-absolute URL escapes**: `/static/escape.txt` is served by the viewer's origin | Chromium |
| 7 | **`<base href>` does not fix that** — it governs relative URLs only | Chromium |
| 8 | From inside the foreign page, a fetch naming another peer gets **403** | Chromium |

Measured 2026-09-12, all eight pass.

## Why the pin is a different handler, not a wrapper

`createEdgeDispatch` reads the target peer from the **first path segment** and
attaches the viewer's token to whatever it forwards. A page rendered through it
can address any peer in the mesh with the viewer's credentials by fetching a
different first segment. That is right for the viewer's own app and wrong for a
foreign one.

So `pinnedPeer` never reads a peer id from the request at all: the peer is
supplied once at mount time and the path is data. Claim 4 is the form that
argument has to take — not "the check rejects these inputs" but "there is no
code path from a request to a peer id". The explicit refusal in claim 3 is belt
and braces on top of that.

## The hole, stated plainly

A host peer's page that uses root-absolute URLs — `/static/app.css`,
`/api/thing` — silently reads the **viewer's** origin instead of its own. The
ServiceWorker passes anything outside the ghost's mount to the network, which
is correct behaviour for an edge and wrong for containment. Three consequences:

- It is **silent**. The host's page appears to work and quietly renders the
  viewer's assets, or 404s against a site it knows nothing about.
- `<base href>` is not the fix (claim 7). The notes propose it, and it governs
  relative URLs only.
- The candidates are: require host apps to use relative URLs only (a rule no
  one can enforce), give each ghost its **own origin** (a subdomain per peer,
  which the notes raised and did not adopt), or serve the ghost in a
  **sandboxed iframe with a CSP** that forbids reaching the viewer's origin.

**This rung does not choose between them**, and the choice is a real design
decision the extraction has to make before a ghost is shipped. What it does
establish is that the peer pin — the part everyone worried about — is solid,
and the remaining exposure is same-origin containment, which is a different
problem with different remedies.

## Not covered

- **The real mesh hop.** `remote` is a stub; rung 01 has the real one.
- **A signed landing.** `Landing` is a plain value here. In a deployment the
  hub signs `{peerId, appPath}`, and nothing here verifies a signature.
- **The A2UI path.** The shell ladder renders peer apps as A2UI messages rather
  than HTML; this rung takes the HTML route, which the notes describe as the
  ghost proper.
- **Sandboxing, CSP, and subdomain-per-peer** — the three candidate remedies
  above, none implemented.
- **Firefox and Safari.**
