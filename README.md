# statewalker-sandbox

> **Internal and experimental.** Every package and app here is `"private": true`. Nothing is
> published to npm, APIs change without notice, and code outside this repository should not depend
> on it. If you want to depend on something here, open an issue: the package should move to a
> published home first.

## What it is

A pnpm workspace of prototypes and packages that are not stable enough to publish: the httpeers
mesh (core, conformance suite, a reference deployment and prototype ladders), MVC and file-manager
blueprints, a few app prototypes, and older service packages scheduled for refactor or
replacement. Published `@statewalker/*` packages are consumed from npm like any other dependency.

## Layout

```
packages/   libraries (private)
apps/       runnable apps, demos and prototype ladders (private)
pnpm-workspace.yaml   workspace globs and the dependency catalog
```

### Packages

| Package | Status | What it is |
| --- | --- | --- |
| [@statewalker/httpeers.core](packages/httpeers.core) | active | Contracts, Biscuit membership tokens, rules, hub registries, router and libp2p transport for the httpeers mesh |
| [@statewalker/httpeers-conformance](packages/httpeers-conformance) | active | One test per criterion of the httpeers block API; measures an implementation against it |
| [@statewalker/service-http](packages/service-http) | refactor | Transport-free HTTP routing contract over a context object |
| [@statewalker/service-http-impl](packages/service-http-impl) | refactor | Hono server for `service-http`, with WebSocket RPC at `/rpc` |
| [@statewalker/service-rpc](packages/service-rpc) | evaluate | RPC over `MessagePort` and WebSocket, built on Comlink, with streaming |
| [@statewalker/service-pg](packages/service-pg) | replace | PostgreSQL pool stored in a context object; no consumer here |
| [@statewalker/layout-reconstructor-core](packages/layout-reconstructor-core) | evaluate | Rebuilds a CSS-grid layout from absolutely positioned blocks |

### Apps

| App | What it is |
| --- | --- |
| [httpeers-stack](apps/httpeers-stack) | Installable reference deployment of the httpeers mesh (relay, hub, browser pages) |
| [httpeers-protos](apps/httpeers-protos) | Runnable httpeers demos: HTTP over libp2p with proven peer identity |
| [httpeers-lib-protos](apps/httpeers-lib-protos) | Test-suite prototypes for the httpeers library |
| [httpeers-shell-protos](apps/httpeers-shell-protos) | Test-suite ladder for a shell that renders apps served by peers |
| [fm-protos](apps/fm-protos) | File-manager prototype ladder over one `fm-core` / `fm-app` / `fm-ui` |
| [mvc-blueprint-00](apps/mvc-blueprint-00) … [03](apps/mvc-blueprint-03) | MVC blueprint TODO apps, four variants |
| [flue-workbench](apps/flue-workbench) | Browser Flue agent workbench over a local directory, using Gemini |
| [notes-demo](apps/notes-demo) | React notes app served without a bundler by `@statewalker/webrun-modules-build` |
| [openai-proxy.app](apps/openai-proxy.app) | OpenAI v1 HTTP proxy in front of a local llama.cpp server |
| [byok-config-prototype](apps/byok-config-prototype) | Throwaway UI prototype for editing an LLM connections config file |

Each folder has a README with its own run instructions.

## How to run it

Requirements: Node 24 and pnpm 10.16.1 (`corepack enable` picks the version from `packageManager`).

1. `pnpm install`
2. `pnpm run build` — builds the packages that have a `build` script.
3. `pnpm run test` — runs every package's `test` script.
4. For the browser suites (vitest browser mode, httpeers-stack e2e), install the browsers once:
   `pnpm --filter @statewalker/httpeers-stack exec playwright install --with-deps chromium firefox`.

Work on one package with `pnpm --filter <name> <script>`, e.g.
`pnpm --filter @statewalker/service-rpc test`.

## Why it is the way it is

- **Nothing is published.** All packages are private and there is no release workflow. The
  `.changeset/` config and the `changeset` / `publish-all` / `release-packages` scripts exist, but
  with every package private they publish nothing.
- **Dependencies come from the catalog.** External versions, including published `@statewalker/*`
  packages, are declared once in `pnpm-workspace.yaml` (`catalog:`); packages in this repository
  refer to each other with `workspace:^`.
- **The repository has its own CI workflow** (`.github/workflows/ci.yml`), because a few checks
  cannot run in a plain checkout and are excluded there. On every push to `main` and every pull
  request it: installs with `--frozen-lockfile` on Node 24, installs Playwright's Chromium and
  Firefox, runs `lint:check` and `format:check`, `build`, `typecheck` for every package except
  `httpeers-lib-protos`, `test` for every package except `httpeers-lib-protos` and
  `httpeers-conformance`, and then the conformance tests without `tests/coverage.test.ts` and
  `tests/parse-ids.test.ts`.
- **Only `node-datachannel` may run install scripts.** pnpm 10 blocks dependency build scripts by
  default; `onlyBuiltDependencies` allows this one because it fetches the native WebRTC binary that
  `@libp2p/webrtc` needs in Node.

## What will surprise you

- **`httpeers-lib-protos` does not typecheck.** Several rungs pass `{ port }` to
  `@statewalker/webrun-rpc`'s port `connect`/`serve`, whose `PortParams` has no such field:
  `error TS2353: Object literal may only specify known properties, and 'port' does not exist in type 'PortParams'.`
  CI skips this app's typecheck and tests.
- **`httpeers-conformance`'s coverage and parse-ids tests need the httpeers specification**, a
  file outside this repository. Without it both suites fail at load with
  `sync-criteria: could not find docs/superpowers/specs/2026-08-20-httpeers-api-design.md above ... Set HTTPEERS_SPEC to point at it.`
  Set `HTTPEERS_SPEC`, or run the other tests as CI does.
- **Without the `node-datachannel` build** (for example after an install that skipped scripts),
  every test that starts a Node libp2p peer fails at import: `build/Release/node_datachannel.node`
  is missing.
- **`pnpm run lint` rewrites files** (`biome check --write`). Use `lint:check` and `format:check`
  to check without changing anything, as CI does.

## Reference

### Commands

| Command | What it does |
| --- | --- |
| `pnpm run build` | `pnpm -r run build` |
| `pnpm run test` | `pnpm -r run test` |
| `pnpm run typecheck` | `pnpm -r run typecheck` |
| `pnpm run lint` / `lint:check` | Biome check, with / without writing fixes |
| `pnpm run format` / `format:check` | Biome format, with / without writing |

### Configuration

| File | Purpose |
| --- | --- |
| `pnpm-workspace.yaml` | Workspace globs (`packages/*`, `apps/*`), `onlyBuiltDependencies`, the version catalog |
| `biome.json` | Lint and format rules (2-space indent, line width 100) |
| `tsconfig.base.json` | Shared TypeScript options |
| `packages/PACKAGE_README.template.md` | Skeleton for a new package README |

MIT licensed; see [LICENSE](LICENSE).
