# 15 (spike) — Could a WebSocket from the isolated origin be carried over the mesh?

`pnpm test 15-ws-tunnel`

**Answer: the premises hold. Carrying the socket is still open.**

## Measured, 2026-10-30 (Chromium)

1. **A socket the app opens goes to the session's host,** `wss://<name>.p.httpeers.net/live`
   in production, straight past its ServiceWorker, the Viewer and the mesh. A ServiceWorker
   cannot intercept WebSockets. Without a shim, every dev server's hot reload (Vite,
   webpack, Next.js) connects to httpeers' session host and fails.
2. **The hook exists.** The Viewer's handler can put `<script src="/_shell/ws-shim.js">`
   first in every HTML page the Service returns. `/_shell/` is the shell's own path, so the
   ServiceWorker leaves it to the network. The shim replaces `window.WebSocket` before the
   app's scripts run; the app still renders, and no socket reaches the network.

## Part 2: the mesh leg is full-duplex (measured 2026-10-30)

`tests/duplex.test.ts`: one request from a Guest to the Sharer, whose handler echoes each
chunk of the request body as it arrives. The Guest sends A, **hears A's echo before it sends
B**, then sends B and hears it. httpeers-member's `fetch` carries a streaming request and a
streaming response at once, over the libp2p stream, so a WebSocket can ride one request.
The tunnel is built in the application (milestone M9).

## What was left (before part 2)

The shim's sockets need a two-way stream to the Sharer and on to the Service:
shim ⇄ (MessagePort) ⇄ Viewer ⇄ member ⇄ mesh ⇄ Sharer ⇄ Bridge ⇄ `ws://localhost:5173`.

- **The mesh leg:** httpeers carries `fetch` over libp2p streams, and a full-duplex request
  is possible there, unlike in a browser `fetch`. Whether `httpeers-member` exposes it is the
  first thing to check.
- **The Bridge leg:** the Bridge would also have to relay WebSocket upgrades (Bun's
  `Bun.serve` does WebSockets natively).
- **Alternative:** skip the shim and serve dev builds without hot reload (`vite build
  --watch` + a static server), which works today.
