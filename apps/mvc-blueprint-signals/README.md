# @statewalker/mvc-blueprint-signals

The MVC blueprint, on signals. The same TODO app, the same three layers, the same command bus and
view protocol, and the same test ladder as `apps/mvc-blueprint` — with every model built on signals
behind one small contract, so the question it answers is: **which of the blueprint's rules were
about the architecture, and which only about its `BaseClass`?** The answer is in
[docs/DECISIONS.md](docs/DECISIONS.md): one rule disappeared outright — the view-side method grep,
replaced by a view that is handed only its facet — and two changed shape rather than vanished:
named channels became a declared `edges` set the controller's effect reads, and forwarding
derived getters became a rule about reading every input unconditionally, which fails silently and
only for some data when broken. None of the architecture changed.

The signals library is a one-line choice (`lib/signals/deps.ts`): alien-signals by default,
`@preact/signals-core` as the other implementation. The ladder runs on both.

```
pnpm dev          # the app, in a browser
pnpm test         # 288 headless tests, run on both signals libraries
pnpm test:browser # 90 tests in real Chromium
pnpm typecheck
pnpm build        # production bundle in dist/
```

## Goals

1. **Separate substrate from application.** Find, by building the smallest honest app, which code
   is framework and which is domain — so the framework can later be extracted into a package with
   two real callers, not one.
2. **Make every rule checkable.** A rule written in a comment is a wish. Most rules here are checked
   by a test that fails when they are broken — most of them by grepping the source tree
   (`B0-boundaries`), which catches what its patterns match and no more.
   [docs/DEVELOPING.md](docs/DEVELOPING.md) lists every rule with its test and what walks past it,
   and names the few that are kept by review.
3. **Headless first.** Everything that can be proven without a browser is: models, commands,
   controllers and the view *protocol* are all tested in Node — where the test project refuses to
   resolve React.
   The browser is reserved for what only a browser can prove — that React renders, that Tailwind
   emitted the styles, that a user can click.
4. **Be a starting point, not a demo.** The code is written to be copied. Its comments say *why*,
   and every place where the obvious approach was tried and failed says so.

## How it is built, in one picture

```
            ┌──────────────────────────── Commands (the bus) ────────────────────────────┐
            │                                                                             │
   ui:show-list(model)   ui:show-dialog:confirm   ui:notify      todos:add  todos:toggle  ...
            │                                                        ▲
            ▼                                                        │
   ┌─────────────────┐   mutators    ┌──────────────────┐   calls    │    ┌───────────────┐
   │  todo-ui        │ ────────────► │  todo-app        │ ───────────┘    │  todo-core    │
   │  React views    │               │  models          │                 │  declarations │
   │  (renderers)    │ ◄──────────── │  controllers     │ ──────────────► │  TodoApi      │
   └─────────────────┘  useValue     └──────────────────┘   api.list()    └───────────────┘
        knows only models              owns I/O, never sees a view            knows no UI
```

- A **controller** reads through `TodoApi`, writes through commands, and shows things by emitting
  `ui:*` commands carrying a model.
- A **view** is a renderer registered on a `ui:*` command. It receives `{ model, settle }` and
  nothing else, and turns every user gesture into a call to one of the model's view-side mutators.
- A **model** is a factory returning two frozen facets over private signals: `view` for the view
  layer, `control` for the controller.
- **`src/app.ts`** is the one place that wires the core, the app and the React views together.

## Documentation

| Read this | For |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The model: layers, commands, models, events, views, bootstrap — with the code |
| [docs/DEVELOPING.md](docs/DEVELOPING.md) | The rules, which test enforces each, and recipes for adding a command, an intent, a controller or a view |
| [docs/TESTING.md](docs/TESTING.md) | How it is tested, why, and the catalogue of tests that looked right and could not fail |
| [docs/DECISIONS.md](docs/DECISIONS.md) | What was decided, what was rejected, and why — including the ideas that were tried and removed |

The authoritative design is `docs/superpowers/specs/2026-09-11-mvc-blueprint-signals-design.md` in
the `statewalker/umbrella` repository (not linked: it lives in a different repo from this one).
These documents describe what was actually built from it, including where building it proved the
design wrong.

## Layout

```
lib/signals          contract.ts, alien.ts, preact.ts, and deps.ts — the one import point
lib/todo-core/src    declarations, TodoApi (the port), MemTodoApi, the command defaults
lib/todo-app/src     models, controllers, bootstrap, the model kit
                     models.ts is the ONLY entry the view layer may use
lib/todo-ui/src      view-adapter.ts (headless — no React), use-value.ts,
                     views/*.tsx, register-views.tsx
src/                 app.ts (composition root), main.tsx (page entry), index.css
B0-…B6-*/tests       the ladder — one directory per rung, each a proven property
test-support/        view-layer stand-ins, a seeded MemTodoApi, DOM helpers for the browser suites
aliases.ts           the alias table — one copy, imported by all three Vite/Vitest configs
```

Three layers are three **directories** behind `@todo/core`, `@todo/app` and `@todo/ui` aliases —
not three packages. The boundary suite polices them by reading the files, without the build steps;
[docs/DEVELOPING.md](docs/DEVELOPING.md) says exactly what each of its patterns catches.

## Running it

`pnpm dev` starts Vite on the app. Open the URL it prints.

**If `pnpm dev` fails with `ENOSPC: System limit for number of file watchers reached`**, the
machine's inotify watch limit is exhausted — usually by an editor watching large trees. It is not
the app. Either raise the limit:

```sh
sudo sysctl fs.inotify.max_user_watches=524288
```

or close editor windows, or run the production build, which needs no watcher:

```sh
pnpm build && pnpm preview
```

The app starts with three seeded todos in memory. There is no persistence yet — a persistent
`TodoApi` is rung B7, out of scope here; the seam for it is `TodoApi` in `lib/todo-core`.

## Status

| Rung | Settles | Where | Tests |
| --- | --- | --- | --- |
| B0 | the layering, as a fact about the files — and that node suites cannot load React | node | 38 |
| B1 | models, the three classes of input field, the model kit, **the signals contract on both libraries** | node | 108 |
| B2 | the command surface, its defaults, the override, the `claimed` contract | node | 20 |
| B3 | the controllers: reconciliation, coalescing, errors, disposal | node | 72 |
| B4 | the view protocol, bootstrap order and its failure unwind, the panel lifecycle | node | 48 |
| B5 | the React views, `useValue`, focus on close | Chromium | 86 |
| B6 | the running app, end to end, and that Tailwind emitted the kit's styles | Chromium + node | 4 + 2 |

288 node tests and 90 browser tests in all — B1 through B5 run once per signals library
(`node:alien`/`node:preact`, `browser:alien`/`browser:preact`); the contract suite (counted in B1)
and B0 run once, and B6 runs once on the default library — its browser half as its own project,
`browser:app`, resolving through `deps.ts`.

**Not done:** B7 (a persistent `TodoApi`), and B8–B9 (extracting the substrate into `app-kit` —
which the spec gates on the Files Manager being ported onto it as a second caller).

## Known upstream dependencies

The command-override rule reads `cmd.claimed`, which `@statewalker/shared-commands@0.2.1` sets at
run time but declares only on its **unexported** `CommandInternal` type; the public `Command` type
does not carry it. `B2-commands/tests/claimed-contract.test.ts` guards the behaviour, so an upstream
change fails loudly rather than silently letting every default handler run alongside a host's
override. An upstream issue asking for `claimed` on the public type is **not yet filed** — it must
be before this substrate is published.
