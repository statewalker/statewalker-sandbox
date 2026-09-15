# @statewalker/mvc-blueprint-02

The MVC blueprint, second generation: a todo app joined by three small controllers, built to show
**four interaction mechanisms working together** — and a UI that renders only what controllers
publish.

| Mechanism | For | In this app |
| --- | --- | --- |
| **Adapters** on one app context | shared infrastructure | the command bus, the slots bus, the logger, the todo api |
| **Slots** (extension points) | what is available | `ui:panels`, `ui:dialogs`, `ui:progress`, `sys:logger-backends`, `ops:running` |
| **Commands** | invocations with an answer | `todos:*` (core services), `todos:summary` (stats → todo RPC) |
| **Models** (MODELS.md) | what is true now, what the user intends | on signals (todo), BaseClass (stats), a plain listener set (progress) |

Two rules make the separation real, and `B0-boundaries` checks both:

- **The UI sees only view models and `ui:*` slots.** It never calls a command, never reads the
  context, never provides to a slot. A part of the screen that wants something shown elsewhere
  raises an intent; a controller decides and publishes.
- **Commands are for invocations between controllers.** Showing a panel or a dialog is a
  contribution; removing it is the disposer.

```
pnpm dev          # the app
pnpm test         # Node: boundaries, model contract, controllers, coverage, emitted CSS
pnpm test:browser # Chromium: DOM host and views with React refused; React host, views, the app end to end
pnpm typecheck
pnpm build
```

## What you see

- **Todos** (React) — add, tick, delete, filter; *Add sample activity* adds five todos, one every
  150ms; *Clear completed* asks a question that never blocks anything else.
- **Statistics** (plain DOM + Tailwind) — totals and a created/closed chart per time bucket,
  derived from the log. The baseline comes from an RPC to the todo controller; without it, the
  panel says "baseline unknown".
- **Progress** (plain DOM) — a bar for every running operation, whoever runs it.
- **Log** (React) — every record the stats backend received: `todos:*` facts, and traces of every
  command call and settlement, slot contribution and withdrawal, and model notification.

## Layout

```
src/lib/sys          the context's adapters, the extension points, the contribution types
src/lib/signals      the signals contract over alien-signals (the todo models' substrate)
src/lib/todo         core (declarations, api, command defaults) · app (signals models, controller) · ui (React)
src/lib/logs         the fan-out logger and the controller that installs it
src/lib/stats        app (BaseClass models, controller) · ui (DOM stats view, React inspector)
src/lib/progress     app (plain model, projection controller) · ui (DOM progress bar)
src/lib/ui-react     the React host and useModel
src/lib/ui-dom       the DOM host
src/app.ts           the composition root — the only module that wires features to hosts
src/tracing.ts       tracing commands, slots and model notifications into the logger
src/coverage.ts      reports any contribution no host can render
tests/support        recording logger, test context, React helpers
tests/B0…B4          boundaries · model contract · controllers · hosts and views · the running app
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the mechanisms, the lifetimes, the data flows.
- [docs/DECISIONS.md](docs/DECISIONS.md) — what changed from v1 and why, and what is still open.
- The design: `docs/superpowers/specs/2026-09-14-mvc-blueprint-v2-design.md` in the umbrella
  repository; the model rules: `docs/sandbox-apps/MODELS.md` there.
