# 03 — What does Chromium do when a public https page calls 127.0.0.1?

`pnpm test 03-local-network-access` (needs Playwright's Chromium and `openssl`)

**Answer: it blocks the call until the Sharer allows "local network access". A blocked
call fails exactly like a stopped Bridge, so the page must read the permission state to
tell them apart.** With that, the page tells the Sharer which of four things is true:

```ts
diagnoseBridge({ localUrl, token }): Promise<"ok" | "permission-needed" | "bridge-not-running" | "token-rejected">
```

## How it is measured

Real Chromium (Chrome for Testing 153, Playwright 1.63), a real Bridge (rung 02), a
real Service (rung 01's fixture) and an https page with a throwaway self-signed
certificate. Chromium decides a page's address space from the IP it was served from,
so a page on `127.0.0.1` would never meet the check. `--ip-address-space-overrides`
(the switch Chromium's own tests use) relabels the page as `public`, and relabels a
server on this machine's non-loopback interface (`192.0.2.2` here) as a `private` LAN
device. A control run without the override reaches the Bridge with no permission,
which shows the override is what triggers the check.

Headless Chromium cannot show the prompt. An unanswered prompt is refused at once;
`grantPermissions(["local-network-access"])` stands for the Sharer clicking **Allow**.

## Measured, 2026-10-30

| Scenario | Result |
|---|---|
| `diagnoseBridge`: allowed, running, right token | `ok` |
| `diagnoseBridge`: not allowed | `permission-needed` |
| `diagnoseBridge`: allowed, nothing listening | `bridge-not-running` |
| `diagnoseBridge`: allowed, Bridge restarted with a new token | `token-rejected` |
| Way A: rung 01's Bridged upstream in the page, through the real Bridge | reaches the Service; the `relayed` marker is readable |
| Way A: a Service's redirect, in the browser | a real `302` with `location: /echo/landed?from=redirect` |
| Way B: rung 01's Direct upstream in the page → plain-http LAN Service | reaches it (after the fix below) |
| **Fact:** without permission, `fetch` → `TypeError: Failed to fetch`; nothing reaches the Bridge; the console says "Permission was denied for this request" | ✓ |
| **Fact:** with permission: `OPTIONS` then `GET`, and no `Access-Control-Request-Private-Network` header | ✓ |
| **Fact:** granting `local-network-access` grants `local-network` and `loopback-network` too | ✓ |
| **Fact:** a `redirect: "manual"` fetch is opaque (`status 0`, no `Location`) even same-origin | ✓ |

## What the rung found

1. **"Not allowed" and "Bridge not running" fail the same way.** Both give
   `TypeError: Failed to fetch` within milliseconds; only Chromium's console says
   which. `diagnoseBridge` reads `navigator.permissions.query({name:
   "local-network-access"})` *after* the attempt: `prompt` or `denied` means
   permission-needed, `granted` means the Bridge is not there. A browser without the
   permission (`unsupported`) also means the Bridge is not there. That branch is
   untested, since only Chromium is installed here.
2. **A stale token looked like a stopped Bridge.** The Bridge refused it with no CORS
   headers, so the browser made it a network error. **Rung 02 changed:** a token
   refusal is now readable by the PeerShare origin. Other origins are refused earlier
   with nothing readable, and a browser cannot forge `Origin`.
3. **The Bridge got a hello.** A request with the token and no target answers
   `200 {"bridge":"peershare"}`. That is how `ok` is told apart from "something else
   is listening on that port", which counts as `bridge-not-running`.
4. **Way B could not reach a LAN Service at all.** An https page calling
   `http://192.168.…` is *mixed content* and blocked, even with permission. It works
   when the call says `targetAddressSpace: "local"`. **Rung 01 changed:** its Direct
   upstream passes that for every plain-http target that is not loopback. Loopback
   needs nothing, because Chromium trusts it already.
5. **Rung 02's redirect design is confirmed.** Manual redirects are opaque even
   same-origin, so restating them is the only way through, and the restated 302 works
   end to end in the browser.
6. **The Bridge's `Access-Control-Allow-Private-Network` is legacy.** Chromium 153
   sends no Private Network Access preflight header. It stays because it is harmless
   for older builds.

## What the page must do (input for the UI rungs)

- **Before the first call**, if the permission is `prompt`, explain the coming
  "Allow access to devices on your local network?" prompt.
- **Expect the first call to wait for the Sharer's answer.** In headed Chromium the
  call is presumably pending until they choose; headless cannot show this. Never
  time it out as "Bridge not running".
- **Per diagnosis:**
  - `permission-needed`: how to allow it in site settings.
  - `bridge-not-running`: start the Bridge (Way A) or check the Service URL.
  - `token-rejected`: relaunch from the Bridge's printed link.

## Not answered here (manual checks)

- What the real prompt looks like, and whether a "Block" shows up as `denied` in
  `permissions.query`. Headless always reads `prompt`; even a denial set over CDP read
  back as `prompt`.
- Firefox and Safari, which have no Local Network Access check yet.
