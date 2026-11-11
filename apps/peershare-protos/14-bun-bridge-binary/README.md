# 14 — Does `bun build --compile` give a one-file Bridge that opens the browser at the right URL?

`pnpm test 14-bun-bridge-binary` (needs `bun`)

**Answer: yes.** `bun build --compile 02-bridge-lockdown/src/main.ts` gives one 109 MB
file, most of it the Bun runtime. It runs with nothing on `PATH`. With `--open`, it opens
the PeerShare page at a pairing URL that works: the Bridge answers its hello with the
printed token.

`--open` uses the platform's opener (`open`, `xdg-open`, `explorer`). `PEERSHARE_OPEN`
overrides it; the test uses a script that records the URL.

## Not answered here (milestone M8)

Cross-compiling for each OS (`--target=bun-darwin-arm64`, `bun-windows-x64`, …), code signing
and notarisation, and the download page. 109 MB is also worth trimming: Node SEA, or `deno
compile`, would be the alternatives to compare.
