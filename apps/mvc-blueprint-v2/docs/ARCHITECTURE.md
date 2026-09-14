# Architecture

## 1. Who may do what

| Layer | May observe | May provide / call | May import |
| --- | --- | --- | --- |
| **UI** (hosts, views) | `ui:*` slots only | model intents only | `@sys/ui`, `@<feature>/models`, its own UI technology |
| **Controllers** | any slot | contributions to any slot; commands; context adapters | `@sys`, feature cores, their own feature's models |
| **Core** (declarations, apis, command defaults) | nothing | command handlers | its own declarations |

Each row is enforced by `tests/B0-boundaries/boundaries.test.ts`, as far as its patterns reach —
a computed call such as `slots["provide"](…)` walks past the publish rule.

## 2. The context and its services

`src/app.ts` creates one plain object and sets four adapters on it: `sys:commands` (a
`TracingCommands`), `sys:slots` (a `TracingSlots`), `todos:api` (`MemTodoApi`) and, once
`LogsController` activates, `app.logger`. Adapters without a factory throw when unset. The logger
is the exception — `shared-logger` creates a console default on first read — so `LogsController`
activates first, exactly the constraint `shared-logger-pino` documents. Every controller resolves
its services once, in `activate(ctx)`.

## 3. Extension points

| Slot | Contribution | Provided by | Observed by |
| --- | --- | --- | --- |
| `ui:panels` (keyed) | `{ kind, title, placement, model }` | Todo, Stats | React host, DOM host |
| `ui:dialogs` | `{ kind, model }` | Todo | React host |
| `ui:progress` | `{ kind, model }` | Progress | DOM host |
| `sys:logger-backends` | a `LoggerBackend` | Stats | Logs |
| `ops:running` | a `RunningOperation` model | Todo | Progress |

A slot is order-independent: a contribution made before its observer exists is delivered when the
observer subscribes. Its one silent failure — a contribution nothing renders — is what
`src/coverage.ts` reports.

## 4. The four controllers

- **TodoController (signals).** One reconcile loop drains every intent. Each pass starts in a
  microtask off the intent listener — MODELS.md §4 point 5 forbids writing to a model from inside
  its own listener — and re-checks disposal after every `await`, so no dialog can be contributed
  once the controller is disposed. Clear completed publishes a confirm-dialog model and returns;
  the answer is an edge the next pass drains, so an open question blocks nothing. It logs
  `todos:created|closed|reopened|removed|cleared` only after the command landed — `todos:removed`
  carries `done` as of the removal, including a toggle that landed earlier in the same pass, since
  the model isn't reloaded until the pass settles — answers `todos:summary`, and runs sample
  activity outside the loop while contributing a `RunningOperation`.
- **LogsController (plain).** Replaces the context's logger with a fan-out logger: console while no
  backend is registered, every registered backend otherwise. A record logged *while* records are
  being delivered is dropped and counted — the one rule that breaks every tracing loop.
- **StatsController (BaseClass).** Contributes a backend model — sink and state at once — and
  derives two view models from it: statistics (side) and the log inspector (bottom). Deriving
  statistics from logs is a demo convenience, not the recommended way to share facts.
- **ProgressController (plain).** A projection: every operation in `ops:running` gets a bar in
  `ui:progress`.

## 5. Models

Every model follows `MODELS.md` §4. `B1-contract` pins points 1–8 on three subjects: the todo
list's `visible` group on signals, the stats totals on BaseClass, the progress bar on a plain
listener set; point 9 (patch semantics — what a coarse write and an explicitly-`undefined` field
mean) is pinned separately, in `B2-controllers`, on the inspector's filter. BaseClass needed
lifting — it notifies every listener on every change, calls nobody on subscribe and lets a
throwing listener stop the rest — which `lib/stats/app/model-base.ts` does.

## 6. Tracing

`src/tracing.ts` is applied only by the composition root: `TracingCommands` logs every call and how
it settled; `TracingSlots` logs every contribution and withdrawal and replaces each `ui:*` model
with a traced copy that logs every notification. The copy is a fresh frozen object, not a Proxy —
the facets are frozen. Tracing marks every command promise as handled, so an ignored rejection
raises no unhandled-rejection warning while tracing is on.

## 7. Lifetimes

Every controller owns a `newRegistry`; `src/app.ts` owns one for the app. Disposal is LIFO:
coverage, hosts, controllers in reverse activation order, the page, the command defaults. A
contribution's lifetime is its disposer.
