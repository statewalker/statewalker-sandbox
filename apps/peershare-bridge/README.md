# @statewalker/peershare-bridge

> **Experimental / internal.** Private package in `statewalker-sandbox`. Not published to npm.

## What it is

The PeerShare Bridge as a program. It listens on `127.0.0.1`, prints (and with `--open`,
opens) the PeerShare link that pairs the page with it, and relays the page's requests to the
Sharer's local services. The relay itself is `@statewalker/httpeers-share/bridge`.

## How to use

```sh
pnpm start                      # bun run src/main.ts --open
pnpm compile                    # one file: dist/peershare-bridge
dist/peershare-bridge --port 9090 --origin https://tools.sandclaw.ai --open
```

`PEERSHARE_OPEN` replaces the platform's opener (`open`, `xdg-open`, `explorer`).

## Internals

`tests/cli.test.ts` runs it under Bun. `tests/binary.test.ts` compiles it and runs the binary
with an empty `PATH`. Cross-compiling, signing and the download page are milestone M8.

## License

MIT
