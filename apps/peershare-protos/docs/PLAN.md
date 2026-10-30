# PeerShare — prototype ladder and implementation plan

Read first: [decisions.md](decisions.md) (what was agreed), [../GLOSSARY.md](../GLOSSARY.md)
(the words), [adr/](adr/) (the three hard-to-reverse choices).

## 1. The scenario in one paragraph

Dirk runs a web app on `localhost:5173`. He opens `tools.sandclaw.ai/peer-share`, either
alone (the app allows cross-origin calls: *Direct*) or launched by the downloaded
**Bridge** (*Bridged*). He types his name, adds the Service ("fooService" →
`http://localhost:5173`), sees it probed healthy, and presses **Invite Guest User**. A QR
code and a one-time, 24-hour link appear. Claudia scans it, sees "Dirk invited you…",
presses **Join Dirk**, and gets the Viewer: "SandClaw.ai presents: Dirk [Close session]"
over fooService, running in its own isolated origin. Every request she makes travels
over the mesh to Dirk's tab, which relays it to `localhost:5173`. Dirk can pause the
Service, stop the server, or revoke Claudia. Claudia can reopen the link to come back,
until she presses Close session.

## 2. Architecture

### 2.1 Packages (target homes after approval)

| Package | Home | Owns |
|---|---|---|
| `@statewalker/peershare` | sandclaw `apps/peershare.app` (logic) | Services store, sharer/guest state machines, commands, extension points, the `Feature`'s logic half |
| `@statewalker/peershare-react` | sandclaw `apps/peershare-react` | Views; contributes to `appViewsSlot`, `menuItemsSlot`, `settingsTabsSlot`, `overlaysSlot` |
| `@statewalker/httpeers-share` | httpeers `packages/` | Isomorphic, UI-free: Upstream kinds (`directUpstream`, `bridgedUpstream`), `probe()`, the guest-facing route table (paused/offline pages), the per-Guest cookie jar |
| `@statewalker/peershare-bridge` | httpeers `apps/` | The Bridge: loopback relay, lock-down, launch, `bun build --compile` |
| `peershare.page` | sandclaw `apps/` | The standalone `tools.sandclaw.ai/peer-share` entry: boots the same Feature with a minimal shell |

Package layout follows sandclaw: `src/public/{commands,extension-points,types,init,index}.ts`,
`src/internal/*.manager.ts` with colocated `*.test.ts`, `src/fragment.ts`; exports `"."`
and `"./fragment"`.

### 2.2 Commands (`peershare/src/public/commands.ts`)

Built with `Command.silent(...)` / `silent<P>(...)` like the ui-protos contracts. Every
menu item names one of these, and the PeerShare Feature handles all of them.

| Command | Input | Who |
|---|---|---|
| `peershare:set-name` | `{ name }` | Sharer |
| `peershare:add-service` / `peershare:edit-service` | `{ draft }` / `{ id, draft }` | Sharer |
| `peershare:remove-service` | `{ id }` | Sharer |
| `peershare:toggle-service` | `{ id, enabled }` | Sharer (Pause) |
| `peershare:set-default` | `{ id }` | Sharer |
| `peershare:probe` | `{ id }` | Sharer ("Test again") |
| `peershare:invite` | `void` → `{ url, expiresAt }` | Sharer |
| `peershare:revoke-guest` | `{ peerId }` | Sharer |
| `peershare:start` / `peershare:stop` | `void` | Sharer ("Turn off server") |
| `peershare:join` / `peershare:decline` | `{ invite }` | Guest |
| `peershare:open` | `{ serviceId? }` | Guest (Viewer, picker) |
| `peershare:close-session` | `void` | Guest |

### 2.3 Extension points (`peershare/src/public/extension-points.ts`)

| Slot | Kind | Value | Why it exists |
|---|---|---|---|
| `peershare:upstream-kinds` | keyed | `{ id, label, detect(env), create(config): Upstream, probeHints }` | `direct` and `bridged` are the first two; other apps can add kinds (a static folder, an in-process handler, another peer) without touching PeerShare |
| `peershare:service-actions` | list | `{ id, label, Icon, command, when(service) }` | Row actions beyond Test/Edit/Turn off |
| `peershare:viewer-items` | list | `{ id, render(ctx) }` | Items in the Viewer bar — the future "share my screen back" (LiveKit) slots in here |
| `peershare:probe-checks` | keyed | `(response, ctx) => Warning[]` | WebSockets-needed, cookies-set, CORS-missing are the first checks |

### 2.4 Dynamic loading

The Feature ships a **manifest** (derived from source as in shell-protos rung 04): its
views, menu items and commands. The SandClaw shell renders the "Share a local service"
menu item from the manifest alone and imports `peershare` / `peershare-react` only when
a PeerShare command first runs (shell-protos rung 05). The Guest side activates on
the `/invite` route the same way. The standalone page imports eagerly.

### 2.5 UI: what is reused from `sandclaw/apps/ui-protos.app`

| Screen | Reuse | New |
|---|---|---|
| Sharer services list | `services/` — `Services` ("inline" variant), `ServiceForm`, `Field`, `HealthTag`, `Advice`, `validateDraft`, `healthOf` | Name field in the header; "Default service" checkbox in the form |
| Invite modal | `link-device/` — `QrPlaceholder` (swap for `httpeers-qr` `qrSvg`), `CopyLink`, `Countdown`; shadcn `Dialog` | — |
| Guest list + Revoke | `team/` — `DeviceList`, `DeviceRow`, `Dot`, `Confirm` | — |
| Guest join + failures | `join-invite/` — `JoinFlow` (joined / machine-offline / invite-used / invite-expired) | "Decline" action, "end-to-end encrypted" line |
| Viewer | `group-status/` — `GroupPill` for the link state; `team/` `Choice` as the Service picker | `ViewerFrame` (bar + isolated iframe) — the one genuinely new component |
| Bridge / Direct onboarding | `services/` `Advice`; `installer/` | Local Network Access explanation card |
| Paused / offline page | `join-invite/` outcome copy | Served by the Sharer as HTML, not React |

No Switch primitive is needed: "Turn off" is a button, as in the draft.

## 3. Prototype ladder

Each rung answers **one** question, is throwaway, and lives in `NN-<topic>/` here. Rungs
are test suites (vitest; Playwright where a real browser is the question), red first.
Order is by risk: a rung that can sink the design goes first.

| # | Rung | Question | Seam under test | Red tests (first one in **bold**) | Kind |
|---|---|---|---|---|---|
| 01 ✓ | [`upstream-kinds`](../01-upstream-kinds/README.md) | Can Direct and Bridged be one `Upstream` behind one route table? | `createUpstream(kind, cfg): FetchHandler` against a real local HTTP server | **Direct reaches `/` and path-rewrites**; Bridged reaches the same; mesh token headers never reach the Service; streaming body passes through | logic |
| 02 ✓ | [`bridge-lockdown`](../02-bridge-lockdown/README.md) | Can a loopback CORS relay be safe from other websites? | The Bridge's HTTP port, speaking rung 01's wire contract | **Request without token → 401, no ACAO**; wrong `Origin` → 403; preflight from PeerShare origin passes (allows `x-peershare-*`); non-loopback target refused; binds 127.0.0.1 only; hop-by-hop headers dropped (streamed POST works); every relayed response marked `relayed`; SSE streams through | logic |
| 03 ✓ | [`local-network-access`](../03-local-network-access/README.md) | What does Chromium actually do when `https://` calls `127.0.0.1`? | Playwright, real Chromium, a public-origin test page | **Prompt/permission state is observable before the first call**; denied → the page can tell "denied" from "Bridge not running" | browser, may end manual |
| 04 ✓ | [`probe`](../04-probe/README.md) | Can one GET classify Health and spot what won't work for Guests? | `probe(upstream, opts): ProbeReport` against fixture servers | **Fast 200 → ok**; slow → slow; refused → down; CORS missing → advice with fix steps; `Upgrade`/Vite client → ws-needed; `Set-Cookie` → cookies-set | logic |
| 05 ✓ | [`tab-hub-invite`](../05-tab-hub-invite/README.md) | Can a tab-hosted hub mint a one-time, 24 h Invite to all Services? | `createHub` + `startMember` (Node, isomorphic code) | **Invite redeemed once → member**; second redeem → invite-used; after 24 h → invite-expired; Guest role reaches Services, not hub admin routes | logic |
| 06 ✓ | [`invite-link`](../06-invite-link/README.md) | Does one link format survive QR, chat apps and the join widget? | `encodeInvite` / `decodeInvite`; `qrSvg` → `decodeQr` | **Round-trip of a link with a fragment key**; service name not in the path; key never sent to a server (fragment only) | logic |
| 07 ✓ | [`advertised-services`](../07-advertised-services/README.md) | Does a Guest see the list, the Default Service and Pause without a reload? | Guest `meshView().advertisements` + guest `fetch` | **Two Services advertised, default flagged**; Pause → advertisement marks paused and fetch returns the paused page; resume restores | logic |
| 08 ✓ | [`isolated-viewer`](../08-isolated-viewer/README.md) | Does a real web app run unmodified in an `openSession` origin? | Playwright: the Viewer page, a fixture SPA with absolute asset paths | **Fixture SPA renders and its `fetch('/api')` reaches the Service**; the framed app cannot read the Viewer's storage; two Services → two origins; a Service's redirect works for Direct (browsers make manual redirects opaque, see rung 02) and Bridged | browser |
| 09 ✓ | [`lifecycle`](../09-lifecycle/README.md) | Do Stop, reload and Revoke behave as agreed? | Guest `MemberState` + guest `fetch`, Sharer restarted from the same storage | **Sharer stops → Guest sees machine-offline**; Sharer reloads → same peerId, Guest reconnects without Invite; Revoke → next fetch denied | logic |
| 10 ✓ | [`guest-persistence`](../10-guest-persistence/README.md) | Does the Guest come back after closing the tab, and not after Close session? | `createSession` over persisted browser storage | **Reopen → joined without Invite**; Close session → identity gone, link shows invite-used | logic (fake-indexeddb) |
| 11 ✓ | [`relay-only-sharer`](../11-relay-only-sharer/README.md) | What happens when the Sharer can only reach the relay, not peers? | `hubLink()` / `connectionKind()` on a Sharer behind a relay-only setup | **Sharer state reports "unreachable" with a reason**; Guests get machine-offline, not a hang | logic |
| 12 ✓ | [`feature-contribution`](../12-feature-contribution/README.md) | Does PeerShare plug into the suite through slots and commands only? | The ui-protos `Feature.contribute(rt)` runtime | **Every PeerShare menu item names a handled command**; views register in their zones; disposing removes all | logic |
| 13 ✓ | [`lazy-activation`](../13-lazy-activation/README.md) | Can SandClaw list PeerShare without importing it? | Manifest + activation (shell-protos rung 05 harness) | **Menu renders from manifest, module not imported**; first `peershare:*` call imports it once | logic |
| 14 ✓ | [`bun-bridge-binary`](../14-bun-bridge-binary/README.md) | Does `bun build --compile` give a one-file Bridge that opens the browser at the right URL? | The built binary as a child process | **Binary starts, prints a URL with `localUrl` and token**; opens the browser (stubbed `open`) | build smoke |
| 15 ◐ | [`ws-tunnel`](../15-ws-tunnel/README.md) *(spike: premises answered, transport open)* | Can a WebSocket from the isolated origin be tunnelled to the Service over the mesh? | A `WebSocket` shim in the session origin → MessagePort → Sharer → local WS server | **Echo message round-trips**; Vite HMR fixture receives an update | browser spike |
| 16 ✓ | [`cookie-jar`](../16-cookie-jar/README.md) *(spike)* | Can a per-Guest jar on the Sharer keep cookie logins working? | `withCookieJar(upstream, jarFor(peerId))` | **Login cookie set for Guest A is sent on A's next request**; never on Guest B's | logic spike |

UI rungs (stories, in the ui-protos convention `src/<topic>/{<topic>.tsx, .stories.tsx,
.mdx}`, each added to `test/stories.test.tsx`; tested with Testing Library on real
components):

| # | Story | Question | Red test first |
|---|---|---|---|
| U1 | `PeerShare/Sharer` | Does `Services` "inline" carry the draft's three states (empty, one service, several)? | **"Expose service" disabled until a URL is given** |
| U2 | `PeerShare/Invite` | Does the link-device kit make the invite modal with no new parts? | **Copy puts the exact link on the clipboard; countdown shows 24 h** |
| U3 | `PeerShare/Join` | Do `JoinFlow`'s outcomes cover every Guest failure? | **Expired / used / offline each render their outcome and a next step** |
| U4 | `PeerShare/Viewer` | Bar, picker and Close session around a frame | **Close session asks to confirm, then calls `peershare:close-session`** |
| U5 | `PeerShare/Guests` | Guest list with Revoke | **Revoke asks to confirm and removes the row** |

**Done per rung:** README states the answer and what it measured; validated decisions
are folded into §4; the rung stays on the branch as primary source.

## 4. Application milestones (red → green, vertical slices)

One slice = one test at an agreed seam → the least code to pass. No bulk test writing.
Refactoring happens in review, not in the loop. Each milestone ends runnable.

| M | Milestone | Slices, in order (each is one red test) | Depends on rungs |
|---|---|---|---|
| M0 | Scaffold | packages exist; `fragment` boots in a headless shell; Feature contributes nothing yet and disposes cleanly | 12 |
| M1 | Sharer, no mesh | add Service → listed; validation messages; edit; remove; set default; Pause; persist + reload; Probe sets Health; Probe warnings | 01, 04, U1 |
| M2 | Sharer joins its own mesh | tab starts hub + member; Services advertised; Stop/start; unreachable-sharer reported | 05, 07, 11 |
| M3 | Invite + join | `peershare:invite` returns a one-time 24 h link; QR renders it; Guest joins; used/expired/offline outcomes; Decline | 05, 06, U2, U3 |
| M4 | Viewer | Guest opens Default Service in an isolated origin; picker between Services; paused page | 08, U4 |
| M5 | Lifecycle | Revoke; Sharer reload keeps Guests; Guest reopen; Close session | 09, 10, U5 |
| M6 | Bridged (Way A) | page reads `#localUrl` + token; Bridged Upstream; Local Network Access explained; Bridge not running vs permission denied | 02, 03 |
| M7 | Suite integration | lazy activation in SandClaw; standalone page; `upstream-kinds` slot accepts a third kind from another Feature | 12, 13 |
| M8 | Ship | compiled Bridge per OS; `tools.sandclaw.ai` deploy; session domain from config; e2e (Playwright, two browsers + Bridge) | 14 |
| M9 | Optional | WebSocket tunnel; cookie jar — each only if its spike says "cheap" | 15, 16 |

### Status (2026-10-30)

| M | Status | Where |
|---|---|---|
| M0–M1 | done | `packages/httpeers-share` (library + `./bridge`), `apps/peershare-bridge` (CLI, compiled binary), `packages/peershare` (Services through commands) |
| M2–M5 | done | `packages/peershare`: the Sharer as hub, Invites, join/resume/close-session, Revoke, Stop and reload, on a real relay |
| M6 | done | `peershare:model`, the browser mesh platform and IndexedDB stores (`@statewalker/peershare/browser`), Bridge pairing from the link |
| M7 | done (standalone page) | `packages/peershare-react` (wired screens), `apps/peershare.page` with an end-to-end test in Chromium. Lazy loading inside SandClaw waits for the move to sandclaw (rung 13 proved it). |
| M8 | open | Per-OS Bridge builds and signing; the deploy of the page, relay and session zone (see the session-zone note in `apps/peershare.page/README.md`) |
| M9 | open | WebSocket tunnel (rung 15); cookie jars on by default (rung 16) |

## 5. Seams to confirm before the first red test

Per the `tdd` discipline, no test is written at an unconfirmed seam. Proposed:

| Seam | Catches | Misses |
|---|---|---|
| `Upstream` (`FetchHandler`) built by an upstream kind | header hygiene, path rewrite, streaming | browser-only restrictions (Local Network Access, forbidden headers) |
| The Bridge's HTTP port | lock-down rules end to end | how Chromium prompts (rung 03) |
| `probe()` → `ProbeReport` | Health and warnings from real responses | the UI's wording of advice |
| Sharer/Guest **commands** on a headless app runtime | app behaviour as the user drives it, without React | layout |
| Guest `fetch` + `meshView()` + `MemberState` over a real relay and hub (Node) | invites, advertisements, Pause/Stop/Revoke | browser storage and origin isolation |
| The Viewer page in Playwright | isolation, a real SPA running unmodified | mesh failure paths (covered above) |
| Stories with Testing Library on real components | each screen's states and the commands it calls | wiring to the mesh |

Mocks only at system boundaries (the clock for 24 h expiry, `open` for launching the
browser, `fake-indexeddb` for storage in Node). Nothing inside PeerShare is mocked.
