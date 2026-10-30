# 04 — Can one GET classify Health and spot what won't work for Guests?

`pnpm test 04-probe`

**Answer: yes, with help from the Bridge for what a browser hides.** One `GET /`
through the same Upstream Guests use gives Health, a cause when it is down, and
warnings. Two facts a page cannot see by itself need workarounds: a missing CORS header
(it fails like a dead server) and `Set-Cookie` (no page script can read it).

```ts
probe(upstream, { slowMs?, direct?: targetUrl }): Promise<ProbeReport>
// { health: "ok" | "slow" | "down", cause?: "service-down" | "bridge-down" | "cors-missing",
//   warnings: ("ws-needed" | "cookies-set")[], ms }

checkServiceTarget(kind, target): { ok: true } | { ok: false, reason }   // the v1 rule
```

## The v1 rule: what can be shared, and how

- **Bridged**: a service on the Sharer's machine or LAN, through the CORS proxy on
  localhost (the Bridge, rung 02 rules).
- **Direct**: a remote resource with a **domain name**, a **certificate** and its own
  **CORS headers**: `https`, a host name (never an IP literal), and not `localhost` or
  `.local`.

| Refusal | Example |
|---|---|
| `needs-https` | direct `http://api.example.com` |
| `needs-domain-name` | direct `https://192.168.1.20`, `https://[2001:db8::1]` |
| `local-needs-bridge` | direct `https://localhost:5173`, `https://nas.local` |
| `remote-is-direct` | bridged `https://api.example.com` |
| `not-local` | bridged `http://8.8.8.8` |
| `not-http`, `not-a-url` | `ftp://…`, `not a url` |

## Measured, 2026-10-30

**Node**, a real Bridge and real apps:
- `ok` when the app answers quickly; `slow` past `slowMs` (default 1500).
- `down` / `service-down` when nothing listens or the app answers 5xx. A 404 at `/`
  still counts as up.
- `down` / `bridge-down` when the Bridge is not running.
- `ws-needed` for Vite (`/@vite/client`), webpack-dev-server, Next.js dev
  (`/_next/webpack-hmr`) and pages calling `new WebSocket(`, but not for prose that
  merely mentions WebSockets.
- `cookies-set` when the app sets a cookie.
- 15 cases of the v1 rule.

**Chromium**, from the public https page:
- Direct to `https://remote.localhost` with CORS: `ok`.
- The same site without CORS: `down` / `cors-missing`.
- Direct with nothing listening: `down` / `service-down`.
- Bridged to an app that sets a cookie: `cookies-set`, although the page never sees
  `Set-Cookie`.

## What the rung found

0. **Direct must follow redirects.** In the Sharer's browser tab, a Direct upstream's
   `redirect: "manual"` response is opaque, so a remote site that redirects came back
   as `502 upstream-redirect`. Direct now follows (`redirect: "follow"`), measured in
   Chromium.

1. **A missing CORS header is a dead server, to a page.** Both fail with
   `TypeError: Failed to fetch`. For Direct, the Probe follows a failure with a
   `mode: "no-cors"` request. That request is not subject to CORS, so an opaque answer
   proves the site is up and only its permission for other origins is missing.
2. **`Set-Cookie` is invisible to page scripts**, whatever CORS exposes. The Bridge now
   restates it as `x-peershare-set-cookie: <count>` (exposed), and the Probe reads only
   that. For Direct there is no Bridge, so a Direct site's cookies cannot be detected.
   v1 accepts this (ADR 0003 already says cookie logins do not work for Guests).
3. **WebSocket detection is a heuristic on the HTML at `/`.** It catches the dev
   servers above. An app that opens its socket later, from a bundled script, is not
   caught. Rung 15 is where WebSockets are actually handled.

## Not answered here

- How the Probe's result is worded for the Sharer: the Storybook stories
  (`apps/peershare-ui-protos`).
- Probing through the mesh as a Guest would see it: rung 05 onwards.
