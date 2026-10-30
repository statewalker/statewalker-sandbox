# 08 — Does a real web app run unmodified in its own isolated origin?

`pnpm test 08-isolated-viewer` (Playwright's Chromium and `openssl`)

**Answer: yes.** Dirk's SPA, shared Bridged and reached over the real mesh, renders
unmodified inside a session origin of its own. Its absolute asset paths load, its API
call is answered, it cannot reach the Viewer's storage or DOM, and its redirects keep the
Guest inside that origin.

```
Viewer page (public https)
  └─ iframe https://<random>.localhost   ← its ServiceWorker answers EVERY request
        └─ Viewer's handler → the Guest's member → mesh → the Sharer → /s/app → Bridge → SPA
```

## How it is built

- **The session shell is httpeers' own** (`vendor/session-shell/`, copied from
  `apps/session-shell` at `4795a79`; see [PROVENANCE.md](PROVENANCE.md)). Three marked
  edits: two let `*.localhost` sessions and an `https://127.0.0.1` viewer work on a test
  machine, and one is type-only. `openSession` frames the shell's relay, hands it a
  `MessagePort`, and from then on the session's ServiceWorker sends every request in that
  origin, `index.html` included, to the Viewer's handler.
- **The Guest's member is a stand-in** (`src/guest-edge.ts`): a real Guest in Node on the
  real mesh, reached over HTTP. The in-browser member (`createSession` + ServiceWorker
  edge) is httpeers-member's and already proven in httpeers-stack. What the stand-in
  imitates is that the member's JavaScript `fetch` returns a redirect as an ordinary 3xx.
- **Sessions are https on `<name>.localhost`,** each its own origin. Chromium resolves
  `*.localhost` to loopback, and the session certificate is trusted with
  `--ignore-certificate-errors-spki-list`.

## Measured, 2026-10-30

| Scenario | Result |
|---|---|
| The SPA renders; `/assets/app.css` applies; its `fetch("/api/hello")` is answered over the mesh | ✓ |
| It runs in a session origin, not the Viewer's | ✓ |
| It reads the Viewer's `localStorage` (where the Guest's key lives) | `null` |
| It reads `window.parent.document` | blocked |
| Two Services | two origins; neither sees the other's storage |
| A redirect the app writes absolutely to itself (`http://127.0.0.1:…/landed`) | the frame lands on `<session>/landed` |
| Dirk pauses the Service | the Viewer shows "Dirk paused Dirk's app…" |
| **Shell fact:** a navigation with no `Referer` (typed, pasted, Playwright `goto`) | 403 "Open this session from its app" |

## What the rung found

1. **A ServiceWorker never registers on an origin with a certificate error.**
   Playwright's `ignoreHTTPSErrors` does not change that. Tests trust the one session
   certificate by its SPKI hash instead (`launchChromium(…, trust)`).
2. **The shell admits a navigation only with its parent's `Referer`, and an https Viewer
   framing an http session is a downgrade, which sends no referrer at all.** Sessions
   must be https, as `*.p.httpeers.net` is in production.
3. **The Viewer must call the mesh through the member's JavaScript `fetch`,** not a
   browser `fetch` to the ServiceWorker edge. The latter makes a Service's redirect
   opaque (rung 02), and the Guest's frame could not follow it.
4. **Redirects to the Service itself must become paths.** The Guest sees the Service at
   the root of their own origin; `Location: https://wiki.example.com/login` would take the
   frame out of it. **Rung 01 changed:** both upstream kinds now rewrite a self-redirect
   into a path. Before, only the real Bridge did.

## Not answered here

- The in-browser Guest member itself (proven in httpeers-stack, not repeated here).
- Cookies inside the session (ADR 0003: not in v1; rung 16).
- WebSockets inside the session (rung 15).
