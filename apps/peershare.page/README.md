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

## Publishing (decision 2.8)

```sh
pnpm build:site            # site/peershare.httpeers.net/: the page, peershare.json, .site/config.json
rclone sync site/peershare.httpeers.net httpeers:sites/peershare.httpeers.net
```

`build:site` reads the relay's addresses from its own document
(`https://relay.httpeers.net/.well-known/httpeers-relay.json`), points sessions at
`*.p.httpeers.net`, and sets `spa: true` so `/peer-share/invite` is served too. `SITE`,
`SESSION_ZONE` and `RELAY_DOCUMENT_URL` override the defaults. `tests/site.test.ts` checks
the folder.

## Internals

`tests/e2e.test.ts` runs the whole scenario in Chromium. Dirk and Claudia are two
browser contexts, with two IndexedDBs and two mesh nodes. Everything around them is real:
a relay, Dirk's Bridge and app, the built page on a public https origin, and session
origins built from the vendored shell (`tests/e2e-harness.ts`). `tests/deploy.test.ts` runs the same
scenario through the Docker deployment (`deploy/peershare`). The two files run one at a time
(`fileParallelism: false`): each starts Chromium, a relay and a page build. The scenario checks:
- Dirk pairs with the Bridge, starts sharing, exposes his app and makes an Invite;
- Claudia opens it, joins, and sees the app in her own origin;
- the app's WebSocket to its own host works (the shim, `src/ws-shim.ts`, hands it to the Viewer,
  which carries it over the mesh);
- Dirk sees her in his Guests list.

The deployed `*.p.httpeers.net` shell accepts parent pages on `*.httpeers.net` only, which
is why the page is published there (decision 2.8). `deploy/peershare` runs it under a zone
of one's own instead.

## License

MIT
