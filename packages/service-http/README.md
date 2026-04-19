# @statewalker/service-http

> **⚠ EXPERIMENTAL / INTERNAL** — this package is **scheduled for refactor** and lives in `statewalker-sandbox`. Do not take a dependency on it from outside the umbrella.

HTTP service contract used by the backbone. Defines request/response adapters and a thin middleware protocol.

## TODO — planned refactor

The ergonomics here predate `@statewalker/shared-adapters` and the workbench's backbone model. The next iteration will either:

- Fold the contract into `@statewalker/backbone-web` (if only backbone uses it), or
- Replace with a leaner request/response type over `@statewalker/shared-adapters`.

Until then, consumers should not broaden their dependency footprint on this module.
