# peershare-ui-protos

## What it is

A Storybook of PeerShare's screens: the Sharer's side (Dirk), the Guest's side
(Claudia), and the **whole usage scenario** on one page, with both sides clicked
through against a fake mesh. Design and words follow
[`../peershare-protos`](../peershare-protos): its `docs/PLAN.md` §2.5 (screens), §2.2
(commands) and §3 U1–U5 (tests), and the findings of rungs 01–03.

It is a prototype. Nothing is stored, and no network is used.

## How to run it

```bash
pnpm install              # at the repo root
pnpm storybook            # in this folder: http://localhost:6006
pnpm build-storybook      # static site in dist/
pnpm test                 # vitest + jsdom + Testing Library
pnpm typecheck
```

## Stories

| Story | States |
|---|---|
| **PeerShare/Scenario** · DirkAndClaudia | Both sides on one fake mesh. Expose `http://localhost:5173` → probe → Invite Guest User → "Open the link from Dirk" → Join Dirk → viewer → Turn off / Turn off server / Revoke / Close session |
| PeerShare/Sharer/Services | Empty (name, form, "Expose service" disabled until a URL) · OneService · Several (Bridged, Direct, off) · Probing · DownWithAdvice (incl. no CORS headers) · Warnings (WebSockets, cookies) · ServerOff · AddingAnother |
| PeerShare/Sharer/Invite | NewLink (real QR code, copy, "works once, for 24 hours") · AlmostExpired · Used |
| PeerShare/Sharer/Guests | TwoGuests (revoke asks first) · NobodyYet |
| PeerShare/Sharer/Bridge | BeforeThePrompt (explains the local network prompt) · WaitingForTheAnswer · Connected · PermissionNeeded · BridgeNotRunning · TokenRejected |
| PeerShare/Guest/Join | Invite · Joining · MachineOffline · AlreadyUsed · Expired · Declined |
| PeerShare/Guest/Viewer | OneService ("SandClaw.ai presents: Dirk [Close session]") · Several (picker) · Paused · SharerOffline · Revoked · NothingShared |

## Reused and new

**Reused** from sandclaw's `ui-protos.app` (see [PROVENANCE.md](PROVENANCE.md)):
- `HealthTag` and `Field` (services)
- `CopyLink` (link-device)
- `Frame` and `EndPage` (join-invite)
- `Dot`, `Confirm` and `Choice` (team)
- the shadcn primitives from `@statewalker/ui.view.shadcn`
- the theme in `index.css`

**New**, where the plan called for it:

| Component | File | What it is |
|---|---|---|
| `SharerServices` | `src/peershare/sharer-services.tsx` | The draft's services page, controlled |
| `InviteDialog` | `src/peershare/invite-dialog.tsx` | A real QR code from `@statewalker/httpeers-qr` |
| `GuestList` | `src/peershare/guests.tsx` | |
| `BridgeStatus` | `src/peershare/bridge-status.tsx` | Rung 03's four diagnoses, plus the Local Network Access explanation |
| `GuestJoin` | `src/peershare/guest-join.tsx` | |
| `ViewerFrame` | `src/peershare/viewer-frame.tsx` | |

**Model** (`src/model.ts`, no React): `Service`, `Guest`, `Invite`, `BridgeDiagnosis`,
`JoinOutcome`, and `validateDraft()`, the v1 target policy:
- A service on this machine or its LAN is **Bridged**: `localhost`, loopback, private,
  Tailscale and `.local` addresses, through the CORS proxy on localhost.
- A remote service must be **Direct**: `https://` on a domain name, never an IP literal.
  Whether it sends CORS headers only a probe can tell.

## What is fake

`src/scenario/fake-mesh.ts` implements the commands of PLAN §2.2 in memory:
`peershare:add-service`, `edit-service`, `toggle-service`, `probe`, `invite`,
`revoke-guest`, `start`, `stop`, `join`, `decline`, `open` and `close-session`. It
follows the rules the rungs settled: invites work once for 24 hours, and Pause, Stop,
Revoke and Close session behave differently from each other.

What it does not do:
- The probe always answers.
- The Bridge is always connected.
- The viewer shows an inline stand-in page instead of the Service in an isolated
  origin.
- `scenario:deliver-link` stands for the link travelling by chat or camera.

Only `scenario.tsx` wires screens to the fake; every screen takes props and callbacks.

## Tests

88 tests in 9 files:
- `model.test.ts`: the target policy and names.
- One file per screen:
  - U1 `sharer-services`
  - U2 `invite-dialog`
  - U3 `guest-join`
  - U4 `viewer`
  - U5 `guests`
  - `bridge-status`
- `scenario.test.tsx`: the full flow; a reused link is refused; server off and back on.
- `stories.test.tsx`: every story renders.

Each screen's first test was written red before the screen existed. Exception: U1's
tests after the first passed on their first run, because the screen was written whole
after its first slice, so they are guards.

The built Storybook was also clicked through in Chromium (Playwright), from exposing a
service to Claudia viewing it, with no page errors and the theme applied.
