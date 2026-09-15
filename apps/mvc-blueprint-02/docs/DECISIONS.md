# Decisions

What v2 decided, what it changed from v1 (`apps/mvc-blueprint`), and what is still open.

### V1 — Four mechanisms, each with one job · adopted

Adapters for shared infrastructure, slots for contributions, commands for invocations, models for
state and intent. v1 used commands for invocations *and* for showing views; the overlap is what
produced its three hardest mechanisms (V3).

### V2 — The UI sees only view models and `ui:*` slots · adopted

No command, no context, no `provide`. A UI part that wants something shown elsewhere raises an
intent; a controller publishes. State that another host must see, that must outlive a component, or
that must be tested without a DOM is a controller-owned model; anything else is component state.

### V3 — Views are slot contributions, not command handlers · adopted, supersedes v1 D2, D3, D11

Publishing a view model and disposing it retires v1's bootstrap-order token (contributions arrive in
any order), its declaration-keyed view adapter, and the asymmetric force-reject of open view
commands on dispose. Commands still require their handler and still fail loudly without one.

### V4 — Dialog answers are edges · adopted, resolves v1's deferred "one loop blocks behind a dialog"

The controller publishes the question and returns; the answer is drained by the next pass. B2 pins
that an intent queued while the dialog is open is processed.

### V5 — Placement is part of the contract · adopted

One slot per extension point, and a placement on every panel. A single generic "views" slot would
render a dialog in every host that observes it.

### V6 — Renderers are host-local; a coverage observer reports what nothing renders · adopted

Registering a renderer is wiring, not a contribution, so it stays out of slots (V2). The silent
failure slots introduce is made loud by `src/coverage.ts`. Knowing the kind is not enough: a host
skips a contribution it has a renderer for but no region for, so the observer asks each host whether
it renders the contribution in the slot and placement it arrived with, and reports what no host can
render.

### V7 — The logs controller replaces the logger · adopted

As `shared-logger-pino` does, with the same constraint: it activates first. Its fan-out writes to the
console while no backend is registered, and to every registered backend otherwise.

### V8 — Re-entrant log records are dropped and counted · adopted

The single rule that breaks every tracing loop, instead of an exclusion list. The count is visible
in the inspector.

### V9 — BaseClass is lifted to the MODELS.md contract in one base class · adopted

Immediate call, per-group change filtering, listener isolation, compare-before-write, post-dispose
no-ops. Without it BaseClass fails contract checks 1, 3, 6 and 8.

## Open

| Item | Why it is open |
| --- | --- |
| an "ask the user" command bridge | a command whose handler publishes a dialog and resolves with the answer, for callers that do not own a UI; documented, not needed by any controller here |
| statistics derived from logs | logs are a lossy channel for domain facts; a real app would publish facts as a model or through commands |
| tracing hides unhandled rejections | `TracingCommands` attaches a rejection handler to every command promise |
| keyed re-registration under tracing | `TracingSlots` passes a fresh traced copy, so re-registering the same value under the same id throws `RangeError` instead of refcounting |
| the inspector's 200-row window | older records scroll out; the backend keeps 500 |
