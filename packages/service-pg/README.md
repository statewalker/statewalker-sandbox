# @statewalker/service-pg

> **Experimental / internal.** Private package in `statewalker-sandbox`, scheduled for replacement by direct `pg` usage. Not published to npm. Nothing in this repository depends on it.

## What it is

A PostgreSQL connection pool stored in a context object. `getDbConnectionPool(context)` returns a
`pg` `Pool`, created on first use; the default export opens and checks it, and returns a cleanup
function.

## Why it exists

It lets modules share one pool through the context instead of each creating its own. It is kept as
a reference for that pattern; new code should use `pg` (or a driver package) directly.

## How to use

Entry point: `.` (`src/index.ts`).

| Export | Purpose |
| --- | --- |
| `newPool(options?)` | A new `Pool`. Options default to `POSTGRES_HOST` (`localhost`), `POSTGRES_PORT` (5432), `POSTGRES_USER` (`postgres`), `POSTGRES_PASSWORD` (`password`), `POSTGRES_DB` (`decider`). |
| `getDbConnectionPool`, `setDbConnectionPool`, `removeDbConnectionPool` | Context adapter under `"db:connection-pool"`; the getter creates a pool with `newPool()` if none is set. |
| `default` `initDbConnectionPool(context)` | Creates the pool, runs `SELECT 1`, logs idle-client errors, and returns `async () => void` that ends the pool. |

## Examples

```ts
import initDbConnectionPool, { getDbConnectionPool } from "@statewalker/service-pg";

const context: Record<string, unknown> = {};
const close = await initDbConnectionPool(context);
const { rows } = await getDbConnectionPool(context).query("SELECT now()");
await close();
```

## Internals

- **Failure.** If `SELECT 1` fails, the pool is ended, `Failed to connect to the database` is
  logged, and the error is rethrown.
- **Double init.** A second call on a context that already holds the pool returns a no-op cleanup,
  so the pool is not ended twice.
- **Dependencies.** `pg`; `@statewalker/shared-adapters`, `@statewalker/shared-logger`,
  `@statewalker/shared-registry`. There are no tests; only `typecheck` runs.

## License

MIT
