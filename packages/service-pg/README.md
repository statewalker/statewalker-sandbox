# @statewalker/service-pg

> **⚠ EXPERIMENTAL / INTERNAL** — scheduled for **replacement**. Private, non-published.

Legacy PostgreSQL service adapter. Kept alive because `sandbox-mcp-module`'s drizzle migration pipeline currently reaches through it.

## TODO — planned replacement

Migrate callers to use `drizzle-orm` + `pg` directly (both are in `statewalker-db`'s catalog), or through `@statewalker/db-api` once a Postgres driver ships there. When the last caller switches, this package goes.
