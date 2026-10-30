# @statewalker/peershare.page

> **Experimental / internal.** Private app in `statewalker-sandbox`.

## What it is

The standalone PeerShare page, with two routes:

- `/peer-share#localUrl=…&t=…` is the Sharer. The fragment pairs the page with the
  Bridge (the Bridge prints or opens this link). Sharing starts when the page opens and
  stops with the tab (ADR 0001).
- `/peer-share/invite#join=…&from=Dirk` is a Guest. Join, then the Viewer: each Service
  in its own isolated session origin (ADR 0003), answered over the mesh.

It is `@statewalker/peershare` (logic) + `@statewalker/peershare-react` (views) +
`@statewalker/peershare/browser` (browser mesh platform, IndexedDB) + the session-shell
client (`src/vendor/`, see [PROVENANCE.md](PROVENANCE.md)).

## How to use

```sh
pnpm build                # dist/
pnpm dev                  # vite
```

Serve `dist/` with every route falling back to `index.html`, and `/peershare.json` beside it:

```json
{
  "relayAddrs": ["/dns4/relay.example/tcp/443/wss/p2p/12D3Koo…"],
  "sessionOrigin": "https://{name}.p.sandclaw.ai"
}
```

## Internals

`tests/e2e.test.ts` runs the whole scenario in Chromium. Dirk and Claudia are two
browser contexts, with two IndexedDBs and two mesh nodes. Everything around them is real:
a relay, Dirk's Bridge and app, the built page on a public https origin, and session
origins built from the vendored shell (`tests/e2e-harness.ts`). The test checks:
- Dirk pairs with the Bridge, starts sharing, exposes his app and makes an Invite;
- Claudia opens it, joins, and sees the app in her own origin;
- Dirk sees her in his Guests list.

**Open, before deploying:** the deployed `*.p.httpeers.net` shell accepts parent pages on
`*.httpeers.net` only. A page on `tools.sandclaw.ai` therefore needs its own session zone
with a shell that accepts it (for example `*.p.sandclaw.ai`), or must itself live under
`httpeers.net`. That is decision 2.8 revisited; `sessionOrigin` makes it a deploy setting.

## License

MIT
