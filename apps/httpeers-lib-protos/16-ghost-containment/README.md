# 16 — Which ghost containment actually contains?

`pnpm test 16-ghost-containment`

**Answer: a path-scoped Content-Security-Policy closes the hole and costs
nothing. The sandboxed-iframe candidate is DISQUALIFIED — the opaque origin
that would contain the page is the same thing that removes it from the
ServiceWorker's control, so the ghost cannot serve it at all.**

Rung 06 found the hole and deliberately refused to choose a remedy, leaving it
as the one open decision in the design (§11.1). Three candidates were named
from their descriptions. A decision taken from three plausible descriptions is
a guess, so this rung runs **the same escape under each**, in a real Chromium,
with everything but the containment held constant.

## Measured

```
[none]                                    [csp]
  parent fetch : 200                        parent fetch : 200
  frame ran    : true                       frame ran    : true
  relative     : asset-from-host            relative     : asset-from-host
  rootAbsolute : 200:VIEWER-ORIGIN-FILE     rootAbsolute : ERR TypeError: Failed to fetch
  otherPeer    : 403                        otherPeer    : 403

[sandbox]
  parent fetch : 200        ← the CONTROLLED parent fetches the ghost's url fine
  frame ran    : false      ← the sandboxed frame never ran at all
  host saw     : /app/      ← only the parent's probe; the frame contributed nothing
```

| # | Claim | What would falsify it |
|---|---|---|
| 1 | **Control**: with no containment the escape still reproduces | the viewer's file not being read — every other claim would be vacuous |
| 2 | A path-scoped CSP **blocks** the escape | `VIEWER-ORIGIN-FILE` reaching the page, or a mere 404 instead of a refusal |
| 3 | The CSP does **not** break the host app's relative fetch | `asset-from-host` not arriving |
| 4 | `'self'` would not have worked; the **path** is why | any fetch directive naming `'self'` |
| 5 | A sandboxed opaque origin is **not SW-controlled** | the frame running, or the host seeing its request |
| 6 | So containment by opaque origin costs the ghost its transport | the relative fetch succeeding under sandbox |
| 7 | The pin holds in every mode | any mode reaching another peer |

Measured 2026-09-12, all seven pass.

## The recommendation, and the reasoning

**Adopt the CSP.** It is the only candidate that contains the escape while
leaving the feature working, and it has three properties the others lack:

- **The ghost applies it to its own responses.** No cooperation from the host
  app, no DNS, no TLS, no new infrastructure — which is what sank the
  subdomain option in the notes.
- **It fails closed and loudly.** The blocked fetch is a `TypeError`, not a
  404, so a host app that relies on root-absolute URLs breaks visibly instead
  of silently rendering the viewer's assets.
- **It is per-mount.** The policy names the ghost's own base URL, so two
  ghosts in one page contain each other as well as the viewer.

### `'self'` is the trap, and it is worth stating

The reflex policy is `default-src 'self'`, and it does **nothing** here: the
viewer's origin *is* self, so `'self'` permits precisely the escape being
closed. What contains is the **path** in the source expression — CSP matches
source paths by prefix — so the directive has to name the mount:

```
default-src http://viewer.example/ghost/; connect-src http://viewer.example/ghost/; …
```

`frame-ancestors 'self'` is the one directive that *should* say `'self'`: it
governs who may embed the ghost, which is the opposite direction. Claim 4
pins both halves so a later "simplification" to `'self'` cannot pass.

## Why sandbox is disqualified, not merely ranked lower

This is the finding the rung exists for, and it is not obvious from the
description. `sandbox` without `allow-same-origin` gives the document an opaque
origin. That **is** containment — nothing escapes. It is also, in the same
stroke, what removes the document from the ServiceWorker's control: a client is
controlled only when its origin matches the registration's, and an opaque
origin matches nothing. The frame's request for the ghost's own URL goes to the
network, where nothing serves it.

The two-point measurement is what makes this conclusive rather than inferred:
the **controlled parent** fetches the very same URL and gets 200, while the
sandboxed frame never runs. The only difference between the two is the
document's origin.

CORS does not rescue it. The problem is not that the request is refused — it is
that the ServiceWorker never sees a request to answer. Anything built this way
would need a transport that is not the SW edge, which is a different design,
not a policy knob.

## What this settles in the design

`ACC-GHOST-8` can now be written:

> **ACC-GHOST-8** A root-absolute URL from inside a rendered host page is
> refused, not served by the viewer's origin. The ghost sets a CSP on every
> HTML response naming its own mount as the only source for `default-src`,
> `connect-src`, `img-src`, `style-src` and `script-src`; a relative fetch to
> the host still succeeds.

`mountGhost` needs one knob — the policy, or an opt-out for a host app that
must reach elsewhere — and its default is on.

## Not covered

- **Chromium only.** CSP path matching is specified, but Firefox and Safari are
  not measured here, and Safari's ServiceWorker behaviour differs elsewhere.
- **Redirects relax path matching.** Per the CSP spec, a redirected request is
  matched against the source list without its path. A host app that redirects
  through the viewer's origin is not tested and may still escape.
- **`img-src`/`style-src` are policy, not proof.** Only `fetch` is exercised;
  a `<link>` or `<img>` escape is assumed to follow the same rule rather than
  measured.
- **Nothing here tests a hostile host app.** The escape measured is the
  *accidental* one — an app written for a normal origin. A deliberately
  malicious peer's app is a different threat model and the pin (rung 06), not
  the CSP, is what stands against it.
