# PeerShare — grilling record

Source: the internal PeerShare draft (`internal.sandclaw.ai/doc/peershare/peershare.adoc`),
grilled in three rounds. Every answer below accepted the recommended option.

## Given by the draft

- Two ways to share: **Way A** — a downloaded Bun executable, which opens
  `tools.sandclaw.ai/peer-share#localUrl=http://localhost:9090/…`; **Way B** — the
  same page alone, for services that already allow cross-origin calls.
- Sharer UI: a services list (name, local URL, default service; *Test again*, *Edit*,
  *Turn off*; *Add another service*; *Invite Guest User*; *Turn off server*).
- Invite modal: QR code + copyable link; the link works **once, for 24 hours**.
- Guest: "Dirk invited you…" → *Join Dirk* / *Decline* → Viewer with
  "SandClaw.ai presents: Dirk [Close session]" over an iframe.
- Failure screens: the existing `join-invite` story in ui-protos.
- Out of v1: the Guest sharing screen and pointer back to the Sharer (LiveKit).

## Decided

| # | Question | Decision |
|---|---|---|
| 2.1 | What is the Way A executable? | A loopback CORS **Bridge** only; the page is the only mesh member; sharing stops with the tab, and the page says so. ([ADR 0002](adr/0002-bridge-is-a-cors-bridge-only.md)) |
| 2.2 | Who issues invitations? | The **Sharer's tab is the hub** of its own mesh; only the relay is shared. ([ADR 0001](adr/0001-sharer-tab-is-the-hub.md)) |
| 2.3 | Invite scope | **All** the Sharer's Services; the Default Service opens first; a picker when there are several. The service name leaves the link path. |
| 2.4 | "exposing https://my-fancy-URL-here" | The local URL echoed back (`localhost:5173 → shared as "fooService"`). There is **no public URL**. |
| 2.5 | "you then invite the others" | The Sharer mints one link per Guest. Guests cannot invite in v1. |
| 2.6 | Turn off / Turn off server | Turn off = **Pause** (Guests stay members, see "paused"). Turn off server = **Stop** (Guests see "machine offline", return automatically). A Guest list with **Revoke** is in v1. |
| 2.7 | WebSockets (dev-server HMR) | v1: HTTP + streaming/SSE only; Probe warns. A WebSocket tunnel is a prototype off the critical path. |
| 2.8 | Domains | Page on `tools.sandclaw.ai`; isolated sessions on `*.p.httpeers.net` for now, as config. ([ADR 0003](adr/0003-guests-view-in-isolated-origins.md)) |
| 2.9 | Place in the suite | `peershare` (logic) + `peershare-react` (views) contributed as a `Feature`; commands; extension points (`peershare:upstream-kinds`…); lazy activation from a manifest; one standalone page and the same feature inside SandClaw. |
| 3.1 | Sharer identity / reload | Name is display-only. Key, hub state and Services persist in IndexedDB (no secrets); reload re-joins the same mesh and Guests reconnect. |
| 3.2 | Guest persistence | Guest identity persists on the PeerShare origin; reopening the link reconnects. **Close session** = leave + forget identity; closing the tab only disconnects. |
| 3.3 | Bridge lock-down | `127.0.0.1`; CORS for the PeerShare origin only; Pairing token in the fragment; loopback/private targets only by default. The page explains Chromium's Local Network Access prompt. |
| 3.4 | Cookies / logins | v1 accepts that cookie logins break, and the Probe warns. A per-Guest cookie jar on the Sharer side is a prototype. |
| 3.5 | What "Test again" checks | `GET /` through the same Upstream Guests use → Health (ok/slow/down/disabled/checking) + warnings (CORS missing with fix steps, WebSockets needed, cookies set). |
| 3.6 | Bridge packaging | Prototypes: `bun run bridge.ts --port 9090`. Compiled, signed installers are the last milestone. |
| 3.7 | Where code lives | Everything on this branch of `statewalker-sandbox` until approved; then libraries → `httpeers`, app packages and stories → `sandclaw`. |

## Found while prototyping

| Rung | Finding | Effect on the design |
|---|---|---|
| 01 | Direct passed Guest-sent Bridge headers to the app | Bridge headers are stripped for every Upstream kind |
| 02 | Browsers make `redirect: "manual"` responses opaque | The Bridge restates redirects as headers; Direct's redirects are open for rung 08 |
| 02 | `localhost` may resolve to `::1` in browsers | The pairing URL uses `127.0.0.1`, not the draft's `localhost:9090` |
| 02 | `*.localhost` and every DNS name are refused as targets | Only exact `localhost` and literal private addresses; **open:** Tailscale `100.64/10` and mDNS `.local` names |
