# httpeers-shell-protos

## What it is

The **shell prototype ladder**: twelve rungs that each
answer one question about a "browser for meshes": a shell that renders applications
served by other peers.

Companion to [`httpeers-protos`](../httpeers-protos), which does the same for the
mesh ladder. That one runs demos over real libp2p; this one is a test suite, because
every question here is answered by an assertion rather than by a process.

## Layout

`lib/` is the shell core — the renderer, catalogue, Basecoat mapping, dock, mount,
peer and theme bridge. Every rung is tested against this one copy, so the rungs
cannot drift apart. [PROVENANCE.md](PROVENANCE.md) lists where each file comes from.

Each rung is a folder: `README.md` (the question and the answer), `tests/`, and
`src/` only where the rung owns code that is not in `lib/`.

## How to run it

```bash
pnpm install                      # at the repo root
pnpm test                         # in this folder: every rung
pnpm test 03-a2ui-binding         # one rung
pnpm typecheck
```

**Dependencies come from the workspace catalog** (`catalog:`), like every other
package in the repo. Rungs 04 and Z parse TypeScript source without executing it,
with `parseSource` from `@statewalker/webrun-modules` (sucrase strips the types,
acorn parses into an ESTree). TypeScript 7 does not ship the compiler API, so this
is what lets the app run on the same TypeScript 7 as the rest.

## Reference

| Command (in this folder) | What it does |
| --- | --- |
| `pnpm test [rung]` | vitest, all rungs or one |
| `pnpm test:watch` | vitest in watch mode |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm build:css` | Tailwind build of `06a-tailwind-build/input.css` into `06a-tailwind-build/dist/shell.css` |
