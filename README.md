# statewalker-sandbox

> **⚠ INTERNAL / EXPERIMENTAL — NOT FOR EXTERNAL CONSUMPTION**
>
> This repository collects packages that are **scheduled for refactor**,
> **prototype-quality**, or otherwise **intentionally unstable**. Every
> package here is marked `"private": true` in its `package.json`; nothing
> is published to npm, and nothing outside the `statewalker` umbrella
> should depend on these packages.
>
> APIs in this repo **will break**. There are **no compatibility
> guarantees**. If you find yourself wanting a dependency on something
> here, open an issue first — that is a signal the package should be
> promoted to a proper home.

Only consumed inside the umbrella via `workspace:*` overrides.

## Packages

| Package | Disposition | Description |
| --- | --- | --- |
| [@statewalker/service-http](packages/service-http) | refactor | HTTP service adapter contract. Migrating to workbench/backbone-* or indexer/ directly. |
| [@statewalker/service-http-impl](packages/service-http-impl) | refactor | Hono-based implementation of the service-http contract. |
| [@statewalker/service-pg](packages/service-pg) | replace | Legacy PostgreSQL service adapter. Planned replacement by direct drizzle/pg usage. |
| [@statewalker/service-rpc](packages/service-rpc) | evaluate | JSON-RPC-ish transport for `@repo/rpc` use-cases. Future uncertain. |
| [@statewalker/layout-reconstructor-core](packages/layout-reconstructor-core) | evaluate | Experimental layout-reconstruction core using `@lume/kiwi` constraints. |

## Development

```sh
pnpm install
pnpm run build
pnpm run test
```

## Release

This repo has **no release pipeline** and **no npm publication**. Consumption
is strictly via the umbrella's `workspace:*` overrides. Do not add a
`release.yml` workflow.
