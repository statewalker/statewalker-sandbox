# mvc-blueprint-06 — prototype R2: actors

**Prototype id: R2** (radical alternative). Brief: `docs/sandbox-apps/architecture/prototypes/R2.md`
in the umbrella repository (`statewalker/umbrella`); lessons: [`LESSONS.md`](LESSONS.md).

Every bundle is an **actor with a mailbox**. There is no shared context, no adapters, no slots and
no command bus. Bundles meet only through:

- **messages** to an address (tell, or ask → reply), and
- **state streams** — named, retained values with exactly one owner actor — that views and other
  actors subscribe to.

Extension points survive as **state of their owner actor** (the `shell` actor owns `shell:*`,
`contacts.list` owns `contacts:selection-actions`), fed by `sys:contribute` / `sys:withdraw`
messages and published as a stream. Actors are in-process, on one thread (no workers).

## Run

```sh
pnpm install
pnpm dev                     # workbench.react; ?app=todos or ?app=contacts for the standalone apps
pnpm test                    # node: kernel, stream contract, scenario, commits, dispose, late,
                             #       standalone, removal, boundaries, worker readiness, cost
pnpm test:browser            # Chromium: React e2e of §14 and interactions (1)–(3)
pnpm typecheck && pnpm build
pnpm deps                    # dependency-graph report
pnpm loc [dir]               # LOC report (non-blank, non-comment; tests separately)
```

## Layout

```
src/kernel/        actors.ts (system, mailboxes, scheduler), streams.ts, extension.ts (points as
                   owner state), loader.ts, protocol.ts (ActionDesc, ViewKind, ViewRef), logger.ts
src/kit/           notify.ts (notifications with timeout); kit/react: useStream, ActionButton/Bar
src/bundles/
  shell/api        shell points: header, menu, panels, dialogs, notifications (+ api/react: renderers)
  shell/actor      the `shell` actor — holds and publishes the points
  shell.react      the React host actor — renders the points, owns ui.react:renderers, coverage
  todos/api        addresses + messages, todos:collection, todos:selection, action points, view kinds
  todos.core  todos.list  todos.edit  todos.clear-completed  todos.status  todos.rename  todos.ui.react
  contacts/api     addresses + messages, contacts:directory, contacts:selection, selection-actions
  contacts.core  contacts.list  contacts.edit  contacts.ui.react
  todos.contacts-link                interaction (1)
  hello/ hello.ui.react              the minimal no-kit bundle (§13.1)
src/features.ts, features.react.ts   feature manifests; configuration travels in them, by value
src/apps/                            workbench.headless / todos / contacts; react variants
tests/                               see `pnpm test` above; support/headless.ts is the test shell
```

## Concepts a bundle author must learn (12) and rules (5)

Concepts:

1. **Actor = bundle.** Its id is its address. `behavior(ctx)` runs once (setup) and returns the
   message handler.
2. **Tell** — `ctx.send(address, msg)`; fire and forget.
3. **Ask** — `ctx.ask(address, msg)` → promise; the handler answers with `env.ok(v)` / `env.fail(e)`;
   a message type declares its reply with `Asks<R>`.
4. **Run-to-completion handlers; async work comes back as a turn** — `ctx.pipe(promise, cb)`,
   `ctx.after(ms, cb)`. Turns and messages of a stopped actor are dropped.
5. **State stream** — `ctx.publish(key, value)` (whole value, owner only), `ctx.subscribe(key, cb)`
   (current value first, then every change, as turns).
6. **Extension point** — the owner calls `ownPoints(ctx, [...])`; a contributor calls
   `contribute(ctx, point, id, value)` → `update` / `withdraw`.
7. **Action as data** — `ActionDesc { id, label, enabled, running?, to, msg }`; submitting is sending
   `msg` to `to`.
8. **A view is a reference** — `{ kind, stream, inbox }` contributed to `shell:panels` or
   `shell:dialogs`; it exists as long as the contribution.
9. **View kind** — `defineViewKind<State, Msg>(id)` in an API module.
10. **Renderer** — a component of `{ state, send, dispatch }`, contributed to `ui.react:renderers`.
11. **API module** — addresses (with message unions), stream keys, points, view kinds, service
    interfaces. Declarations only.
12. **Features and applications** — manifests; per-bundle configuration (an injected api, a
    timeout, a DOM root) is passed in the manifest.

Rules:

1. A stream has one owner; a second publisher throws.
2. No module-level mutable state; everything lives in the actor's setup closure.
3. A bundle imports only the kernel, kits, API modules and its own files.
4. A renderer only reads `state` and calls `send` / `dispatch`.
5. Equality is by value: a contribution or stream is only re-sent when its value changed
   (the kernel's `contribute` and `ownPoints` enforce this — see LESSONS "ping-pong").

## Choices (where ARCHITECTURE.md had to be reinterpreted)

- **Scheduler**: one FIFO run queue; a send from outside any actor drains it synchronously. So a
  keystroke is fully processed — draft updated, stream republished — before the DOM event handler
  returns, which keeps React controlled inputs (and their caret) correct.
- **Commit** = the `save` message; the draft is the owner's state and edits are messages, so
  mailbox order *is* commit time. While a save runs the action shows `enabled: false, running:
  true`; further saves are refused (disable, not queue). Edits made while saving stay in the draft:
  the editor stays open for the next commit instead of closing.
- **`todos:collection`** is owned by the service actor `todos.core` (it owns the api too).
- **Added streams**: `todos:selection` (owner `todos.list`, needed by Edit / Rename) and
  `contacts:directory` (owner `contacts.core`; the list needs the data and there is no shared model).
- **`todos.status`** is its own feature (`todos.status`, requiring `todos`) so it can be removed.
- **Removal** of a feature drops the features that require it (`without()` in the loader).
- **Coverage report**: the `ui.react:coverage` stream, published by the React host.
- **Read-then-set** has no counterpart: there is nothing shared to read. Its nearest cousins —
  two owners of one stream, two actors at one address — throw.
