# @statewalker/mvc-blueprint-14 — prototype **J1**

**J1 — agent-generated UIs as ordinary publications.** This is P0 (`apps/mvc-blueprint-04`) plus
P3's commit records (`apps/mvc-blueprint-11`, `@kit/commit`). On top of that base it adds
[json-render](https://json-render.dev) **only for generated UIs** (research options c + d):

- **The catalog is an extension point.** Any bundle can contribute a component. The definitions go
  to `ui:catalog` and the React implementations go to `ui.react:catalog`.
- **A generated UI is one view kind, `jr:generated`.** Its model keeps our three model kinds: the
  spec is a presentation group, the values are a form group, and the allowed actions are
  `ActionView`s.
- **An agent controller runs the generation.** It streams a SpecStream, validates it and publishes
  the panel. It drains the generated actions into **existing commands** (`todos:compose`,
  `contacts:edit:open`).

The Todos and Contacts code is unchanged: all 71 of P0's source files are byte-identical. Only
`src/main.ts` changed, to add one more app to the picker.

- Brief (with the lessons section): umbrella repository,
  [`docs/sandbox-apps/architecture/prototypes/J1.md`](../../../../../docs/sandbox-apps/architecture/prototypes/J1.md)
  (`statewalker/umbrella`, path `docs/sandbox-apps/architecture/prototypes/J1.md`).
- Research: `docs/sandbox-apps/architecture/research/json-render.md` (§4 c/d, §5 J1).
- Full lessons and numbers: [`LESSONS.md`](LESSONS.md).
- New dependencies, pinned exactly: `@json-render/core` **0.21.0** and `@json-render/react`
  **0.21.0**. `zod` 4.5.4 was already a P0 dependency and was already in P0's bundle.

```
pnpm dev             # http://localhost:5173/?app=workbench.agent (default) | workbench.react | workbench.dom | …
                     # select a contact, then Assistant → Assistant… (the recorded stream replays at 40 ms/chunk)
pnpm test            # node: P0's suites + tests/agent (generation, refusal, commit time, sessions, removal)
                     #       + tests/identity (P0 byte-identical)
pnpm test:browser    # Chromium: P0's 24 + the generated panel under React (streaming, refusal, commit time,
                     #       json-render's own write paths) + P0's scenarios on the agent workbench
pnpm typecheck
pnpm build
node scripts/loc.mjs src/bundles/agent   # LOC per module
```

No real LLM is called. `agent.fixtures` replays a **recorded** SpecStream (JSONL, RFC 6902 patches)
line by line, in two chunks per line, so the compiler also sees partial lines. Tests inject their
own `agent:generator`, either a controlled stream or a fixed text. A live LLM would be one more
`SpecGenerator` that sends `request.system` (the prompt generated from the catalog) and streams back
its text.

## What J1 adds to P0

```
src/kits/commit/            P3's commit records, verbatim (createCommitAction, drainCommits, on)
src/kits/catalog/           json-render schema WITHOUT built-ins + buildCatalog(components, actions)
                            + prop helpers dyn()/bindable() ($state / $bindState expressions)
src/bundles/
  catalog/api/ (+react)     slots ui:catalog (definition) and ui.react:catalog (implementation);
                            CatalogRenderProps = { props, children, loading, action(event), write(prop) }
  catalog/                  8 generic definitions: Card Stack Text Input Select Checkbox Button Table
  catalog.ui.react/         their React implementations (controlled inputs, no private state)
  badge/ badge.ui.react/    one more component from an independent feature (the cost of vocabulary)
  agent/api/                agent:actions (the allow-list), agent:data (read-only /data),
                            agent:generator, GeneratedView + kind jr:generated
  agent/                    the agent controller: aggregation, sessions, stream, policy, drain
    generated.model.ts      the GeneratedView model (+ json-render StateStore facade)
    policy.ts               what a spec may contain beyond the catalog (on/watch/state/pointers)
  agent.ui.react/           the generic jr:generated renderer (json-render Renderer in controlled mode)
  agent.fixtures/           recorded SpecStream; provides agent:generator unless the host set one
  agent.todos-actions/      allow-lists todos:compose as "todos.compose"          (feature agent.todos)
  agent.contacts-actions/   allow-lists contacts:edit:open; /data/selectedContacts (feature agent.contacts)
src/features/agent.ts, agent.react.ts   ui.catalog, ui.badge, agent, agent.todos, agent.contacts;
                                        ui.catalog.react, ui.badge.react, agent.react
src/apps/workbench.agent.ts             P0's workbench.react features + the J1 features
```

Names versus the brief: the brief's `ui.catalog` is split into `catalog` (definitions, logic) and
`catalog.ui.react` (implementations), following P0's `<bundle>` / `<bundle>.ui.react` convention and
the boundary tooling's `*.ui.*` rule. The brief's `agent.ui` controller is `agent`.

## How it works

1. **Aggregation.**
   - The `agent` controller observes `ui:catalog` (components), `agent:actions` (actions) and
     `agent:data` (data sources), all three keyed by name.
   - On any change it drops its cached catalog. The next use rebuilds the catalog with
     `defineCatalog`, and an open session re-checks its spec.
   - A second bundle that contributes an existing name fails its activation (`RangeError` from the
     keyed slot). The loader then rolls back.
   - The React renderer's activator follows `ui.react:catalog` the same way and rebuilds the
     json-render registry.
2. **Session.** The "Assistant…" menu item is a commit action. The drain handles it in four steps.
   - It opens a session: it publishes the `agent:assistant` side panel with a fresh model, and it
     calls `generator.generate({ request, system: catalog.prompt(), data }, signal)`.
   - For each chunk, it runs `compiler.push` and then the policy on every element.
     - While everything is valid, it publishes a **valid prefix**: `{ root, elements }` only. The
       `state.form` seed goes to the form group instead.
     - At the first issue it publishes `spec = null` and `status = invalid`, logs a warning, and
       aborts the stream. Nothing of that spec stays on screen.
   - When the stream ends, it checks the whole spec (`checkComplete`). It then creates one commit
     action per bound action, and the `capture` resolves the binding's params against the model at
     submit time. Then it publishes the actions and `ready`, and starts a drain.
   - The drain handles each record: it parses the params with the action's Zod schema, calls
     `run` (the existing command) and publishes the outcome.
3. **Rendering.** `agent.ui.react` renders `JSONUIProvider store={model.store}` (controlled mode) and
   `<Renderer spec>`.
   - Each catalog implementation is wrapped. It receives resolved `props` and two capabilities:
     `action(event)`, our `ActionView` for its allow-listed binding, and `write(prop)`, a store
     `set` on its bound pointer.
   - It never receives json-render's `emit`, so a component cannot raise a built-in action.
4. **End.** Close, a new request or deactivation ends the session synchronously, in this order:
   abort, unsubscribe, withdraw the panel, stop the drains, dispose the actions and the model.
   Whatever a generator yields after that is ignored.

## What a newcomer must learn on top of P0 — +6, all local to the agent feature

P0's 26 concepts stay. P3's commit record (capture at submit, drained records) replaces P0's
`onSubmits` in the new code only, and it is already part of architecture K.

27. **Catalog entry**: a component definition (Zod props, slots, events, description) in
    `ui:catalog`, plus an implementation per technology in `ui.<tech>:catalog`. A dynamic prop must
    say so with `dyn` / `bindable`.
28. **Spec / SpecStream**: json-render's flat element tree, streamed as JSON Patch lines. It is data,
    not code, and is only ever produced by a generator.
29. **Policy**: a spec may bind only allow-listed actions (one binding each, no lists, no
    `onSuccess` / `onError` / `confirm`) and must not contain `watch`. Reads are allowed under
    `/form` and `/data`, binds only onto `/form/<field>`, and seeds only onto `/state/form`.
30. **GeneratedView**: the spec (presentation), the values (form, `editField` on seeded fields only),
    the data (presentation) and the actions (`ActionView`s). `store` is a facade over these, not a
    writer.
31. **Agent action**: an allow-list entry `{ description, params (Zod), run }` in `agent:actions`,
    contributed from outside the app it acts on. `run` calls an existing command.
32. **Generator / data source**: `agent:generator` (an LLM or fixtures), and `agent:data` entries
    (read-only JSON under `/data`).

## Answers and choices (details in LESSONS.md)

- **Allow-list** in `agent.*` bundles, not a flag on the command declaration. This needs 0 changes
  in Todos and Contacts. The allow-list is the `agent:actions` slot.
- **Params schema** is Zod, written in the `agent.*` bundle. P0's command declarations use
  `passthrough` and carry no schema to convert.
- **`validateForm` / `checks`** stay out. Errors come only from the command's schema at drain time
  (shown as the outcome) and from the command itself.
