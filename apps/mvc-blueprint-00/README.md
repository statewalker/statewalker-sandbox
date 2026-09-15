# @statewalker/mvc-blueprint-00

A TODO application whose purpose is not todos.

It is the **blueprint** for an architecture — commands as the channel between layers, controllers
that never see a view, models that only hold data, views that are nothing but command handlers —
built small enough to read end to end, and tested hard enough to trust. A Files Manager and a
DockPanel shell hosting loadable mini-apps are meant to be cut from it next.

```
pnpm dev          # the app, in a browser
pnpm test         # 144 headless tests, no DOM, ~2 s
pnpm test:browser # 45 tests in real Chromium
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
   └─────────────────┘  useModel     └──────────────────┘   api.list()    └───────────────┘
        knows only models              owns I/O, never sees a view            knows no UI
```

- A **controller** reads through `TodoApi`, writes through commands, and shows things by emitting
  `ui:*` commands carrying a model.
- A **view** is a renderer registered on a `ui:*` command. It receives `{ model, settle }` and
  nothing else, and turns every user gesture into a call to one of the model's view-side mutators.
- A **model** holds data and notifies. It is changed only through its own mutators.
- **`src/app.ts`** is the one place that wires the core, the app and the React views together.

## Documentation

| Read this | For |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The model: layers, commands, models, events, views, bootstrap — with the code |
| [docs/DEVELOPING.md](docs/DEVELOPING.md) | The rules, which test enforces each, and recipes for adding a command, an intent, a controller or a view |
| [docs/TESTING.md](docs/TESTING.md) | How it is tested, why, and the catalogue of tests that looked right and could not fail |
| [docs/DECISIONS.md](docs/DECISIONS.md) | What was decided, what was rejected, and why — including the ideas that were tried and removed |

The authoritative design is `docs/superpowers/specs/2026-09-10-mvc-blueprint-design.md` in the
`statewalker/umbrella` repository (not linked: it lives in a different repo from this one). These
documents describe what was actually built from it, including where building it proved the design
wrong.

## Layout

```
src/lib/todo-core/src    declarations, TodoApi (the port), MemTodoApi, the command defaults
src/lib/todo-app/src     models, controllers, bootstrap, the model kit
                         models.ts is the ONLY entry the view layer may use
src/lib/todo-ui/src      view-adapter.ts (headless — no React), use-model.ts,
                         views/*.tsx, register-views.tsx
src/                     app.ts (composition root), main.tsx (page entry), index.css
tests/B0-…B6-*/          the ladder — one directory per rung, each a proven property
tests/support/           view-layer stand-ins, a seeded MemTodoApi, DOM helpers for the browser suites
aliases.ts               the alias table — one copy, imported by all three Vite/Vitest configs
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
`TodoApi` is rung B7, out of scope here; the seam for it is `TodoApi` in `src/lib/todo-core`.

## Status

| Rung | Settles | Where | Tests |
| --- | --- | --- | --- |
| B0 | the layering, as a fact about the files — and that node suites cannot load React | node | 34 |
| B1 | models, the three classes of input field, the model kit | node | 39 |
| B2 | the command surface, its defaults, the override, the `claimed` contract | node | 10 |
| B3 | the controllers: reconciliation, coalescing, errors, disposal | node | 35 |
| B4 | the view protocol, bootstrap order and its failure unwind, the panel lifecycle | node | 24 |
| B5 | the React views, `useModel`, focus on close | Chromium | 41 |
| B6 | the running app, end to end, and that Tailwind emitted the kit's styles | Chromium + node | 4 + 2 |

144 node tests and 45 browser tests in all.

**Not done:** B7 (a persistent `TodoApi`), and B8–B9 (extracting the substrate into `app-kit` —
which the spec gates on the Files Manager being ported onto it as a second caller).

## Known upstream dependencies

The command-override rule reads `cmd.claimed`, which `@statewalker/shared-commands@0.2.1` sets at
run time but declares only on its **unexported** `CommandInternal` type; the public `Command` type
does not carry it. `tests/B2-commands/claimed-contract.test.ts` guards the behaviour, so an upstream
change fails loudly rather than silently letting every default handler run alongside a host's
override. An upstream issue asking for `claimed` on the public type is **not yet filed** — it must
be before this substrate is published.
