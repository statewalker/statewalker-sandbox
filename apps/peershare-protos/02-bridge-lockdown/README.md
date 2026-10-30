# 02 — Can a loopback CORS relay be safe from other websites?

`pnpm test 02-bridge-lockdown` · run it yourself: `bun run 02-bridge-lockdown/src/main.ts`

**Answer: yes, with six rules, and only if redirects are restated.** A Bridge on
`127.0.0.1` that answers cross-origin requests can be reached by every website the
Sharer visits. These rules close that door. All of them are tested at the Bridge's
real port, and the same handler runs under Node (tests) and Bun (`main.ts`).

| # | Rule | What it stops |
|---|---|---|
| 1 | Bind `127.0.0.1` only | Anyone on the LAN or café Wi-Fi using the Bridge |
| 2 | Any `Origin` other than the PeerShare page → 403, no CORS headers | Other websites, even ones that somehow got the token |
| 3 | No Pairing token → 401, no CORS headers. The token is 32 random bytes, new each launch, compared in constant time | Websites guessing at loopback ports |
| 4 | Preflight: granted to the PeerShare origin only, echoing the requested method and headers, plus `Access-Control-Allow-Private-Network` | Nothing extra; a preflight cannot carry the token, so the origin check is its only guard |
| 5 | Relay only to `localhost`, `127/8`, `10/8`, `172.16/12`, `192.168/16`, `100.64/10` (Tailscale), `::1` and `fc00::/7`, and to `.local` names whose every resolved address is one of those; refuse every other address, every other DNS name, and non-HTTP schemes | The Bridge as an open proxy into the internet or cloud metadata, and DNS rebinding |
| 6 | Replace the Service's own CORS headers with a grant for the one origin | A dev server's `Access-Control-Allow-Origin: *` + credentials leaking through the relay |

## Measured, 2026-10-30 (Node 22 and Bun 1.4.4)

36 tests at the port, plus 11 from rung 01:

- **Refuses:** no token; a foreign origin; a foreign preflight; `8.8.8.8`,
  `example.com`, `dev.localhost`, `169.254.169.254`, `[fe80::1]`, `0.0.0.0`,
  `100.128.0.1`, `file:`, and `.local` names resolving to any public address.
- **Relays to:** `localhost`, `127.0.0.1`, `[::1]`, `10.0.0.5`, `172.16.4.2`,
  `192.168.1.20`, `[fd12:3456::1]`, `100.64.0.1`, `100.101.102.103`, `nas.local`
  (resolving to `192.168.1.30`). A `.local` name that does not resolve is reported as
  `target-unreachable`.
- **Rung 01's bridged upstream against this Bridge:** reaches the Service; tells
  "Service down" from "Bridge down"; turns redirects back into real redirects; a POST
  arrives whole; live responses stream.
- **Ports:** not reachable through the machine's non-loopback addresses.
- **Under Bun:** `bun run main.ts` prints a working PeerShare URL.

Three tests passed on their first run (streamed POST, streaming, loopback bind). Each
was confirmed able to fail by breaking the code on purpose: a naive header-copying
relay, a `0.0.0.0` bind, and removing the CORS replacement.

## What the rung found

1. **Redirects cannot cross to a browser page as redirects.** `fetch(…, {redirect:
   "manual"})` in a browser returns an *opaque* response (status 0, no `Location`),
   whatever CORS says. So the Bridge never answers the page with a 3xx. It answers 200
   with `x-peershare-redirect-status` and `x-peershare-redirect-location` (both
   exposed), and rung 01's bridged upstream turns that back into a real 3xx for the
   Guest. A location on the Service itself becomes a path (`http://127.0.0.1:5173/login`
   → `/login`), so the Guest stays inside their isolated origin.
   **Open:** the same opacity hits **Direct** in a browser, and with no Bridge there is
   nothing to restate the redirect. Rung 08 must measure it; the likely answer is
   `redirect: "follow"` for Direct.
2. **The Bridge's own "Service unreachable" must be restated.** Passed through as the
   proxy's `upstream-unreachable`, the page read it as "the Bridge is down". The
   Bridge now answers `x-peershare-bridge: target-unreachable`.
3. **Refusals the page may read, and ones it may not.** No-token and wrong-origin
   refusals carry no CORS headers, so a foreign page learns nothing. Refusals after
   both checks pass (`target-forbidden`, `target-unreachable`, `no-target`) are granted
   to the PeerShare origin, so the page can tell the Sharer what is wrong.
4. **`*.localhost` is refused.** Mapping `*.localhost` to loopback is a convention, not
   a guarantee; a resolver may forward it to DNS. Only exact `localhost` is accepted.
5. **The printed URL says `127.0.0.1`, not `localhost`.** The draft writes
   `#localUrl=http://localhost:9090/…`, but the Bridge binds IPv4 loopback only, and a
   browser may try `localhost` as `::1` first.
6. **A request with no `Origin`** (curl, a local script) is admitted by the token alone
   and gets no CORS headers. Browsers always send `Origin` on these requests.

## Decided after the rung

- **Tailscale / CGNAT (`100.64/10`) is allowed.**
- **mDNS `.local` names are allowed, after resolving.** The Bridge resolves the name
  and relays only if every address returned is private. One public answer refuses
  it, because some company networks serve `.local` from ordinary DNS. What remains:
  `fetch` resolves the name again when connecting, so someone who already controls
  mDNS on the Sharer's LAN could change the answer between the check and the
  connection. Accepted for v1.

## Not answered here

- What Chromium actually shows and does for Local Network Access: rung 03.
- Opening the browser, and the compiled single-file binary: rung 14.
- Redirect handling for Direct in a real browser: rung 08.
