# J1: lessons

Prototype J1: json-render's generative half (catalog → prompt → SpecStream → validated spec) inside
architecture K, as one view kind. The base is P0 with P3's commit records. Brief:
`docs/sandbox-apps/architecture/prototypes/J1.md` (umbrella). Research:
`research/json-render.md`.

**Status: DONE.** Every acceptance criterion is met.

Tests:

- `pnpm test`: **258** node tests. That is P0's 150, plus 74 identity tests, plus 34 J1 tests.
- `pnpm test:browser`: **35** Chromium tests. That is P0's 24, plus 11 J1 tests.
- `pnpm typecheck` passes, and `pnpm build` passes.
- The node suite passed 3 runs in a row, and the browser suite 3 runs in a row.

## Verdict

**Green, and cheap where it matters.** One view kind, one controller bundle, two catalog slots and
one kit host agent-generated UIs:

- 0 changes to Todos and Contacts (71/71 of P0's source files are byte-identical);
- single writer holds by construction, and commit time holds through P3's records.

json-render does the parts it is good at: the prompt from the catalog, the SpecStream compiler, and
the element walker with `$state` / `$bindState` resolution. **Its safety is not usable as shipped.**
Its validation misses what matters, and its runtime has five writers. J1 therefore adds its own
policy (108 LOC) and a store facade (inside the 157-LOC model). Those are the load-bearing pieces,
and each has a negative control.

## What worked

- **Catalog as an extension point.** Three independent features contribute vocabulary, and the
  agent aggregates it into one catalog, one prompt and one validator:
  - `ui.catalog` contributes 8 components, `ui.badge` contributes 1, and `agent.todos` /
    `agent.contacts` contribute actions and data.
  - Removing a feature removes its entries from rendering, from the prompt and from validation.
    This was tested for `ui.badge`, `todos` (`todos.compose` leaves the prompt, and a spec that
    binds it is refused) and `ui.catalog`.
  - A withdrawal during a session re-checks the live spec. A spec that still uses the withdrawn
    component or action is refused, even after `ready`.
  - A name clash (a second `Button`) fails the second bundle's activation loudly (`RangeError` from
    the keyed slot), and the loader rolls it back.
- **The model kept our three kinds.**
  - Presentation groups: `spec`, `status`, `data`, `actions`, `outcome`, all written only by the
    controller.
  - A form group: `values`, written only through `editField` on a field the spec seeded.
  - Actions: one commit action per allow-listed binding, plus `close`.
  - json-render reads a stable composite (`{ form, data }`, with identity kept by `stableGroup`)
    through a `StateStore` facade.
- **Commit time holds.** The capture resolves the binding's params (`{ "$state": "/form/title" }`)
  against the model inside `submit()`.
  - "Type A, press, type B" in one tick composes "A". This is tested headless and through the real
    DOM and json-render.
  - A double press in one tick composes once: `running` flips inside `submit()`, as in P3.
  - Data captured from `/data` is also press-time: selecting another contact right after pressing
    "Open contact" still opens Ada.
- **Partial rendering is safe.**
  - The panel shows the valid prefix while streaming, and half a line shows nothing new.
  - Buttons render **inert** until the whole spec is checked, because no action exists for a partial
    spec.
  - The first invalid element clears everything (`spec = null`, `status = invalid`, issues listed)
    and aborts the stream.
- **Session scope.**
  - Closing mid-stream, a new request, or stopping the application aborts the stream.
  - After that there are 0 notifications, 0 writes and 0 warnings, even from a test generator that
    ignores the abort and keeps yielding.
  - After stopping, every slot is empty and no command has a listener.
- **Interaction (1) is reproduced through a generated UI.** Select Ada, open Assistant…, the
  recorded stream plays, and the table shows Ada. Create opens the todos editor with "Call Ada
  Lovelace" prefilled, and Save adds the todo. Nothing in Todos or Contacts knows about the agent.
- **Adding a component is cheap.** `Badge` costs 11 LOC for the definition (1 file), 12 + 5 LOC for
  React (2 files) and 2 feature entries, with 0 edits elsewhere.

## What failed (json-render findings that forced our own code)

1. **`catalog.validate` does not check props in a real catalog.**
   - With two or more components, the schema's `propsOf` falls back to `record(string, unknown)`
     (`packages/core/src/schema.ts`, `case "propsOf"`). `{ "type": "Button", "props": { "label": 42 } }`
     validates.
   - With exactly one component, props *are* checked, which is how the research probe missed it.
   - The policy parses props per component type itself.
2. **Prop schemas reject json-render's own expressions.** `z.string()` rejects `{ "$state": … }`
   and `{ "$bindState": … }`, so the docs' example (an `Input` with `value: z.string()` bound by
   `$bindState`) does not validate. Every dynamic prop must be declared with `dyn()` / `bindable()`
   (`@kit/catalog`), which makes this a per-catalog rule a contributor can get wrong.
3. **`validate` silently strips `on`, `watch` and `state` under the React schema.** A validated spec
   has no events. J1 copies the schema and keeps these fields, so that the policy can check them.
4. **`builtInActions: []` does not remove built-ins from the prompt.** The default prompt text still
   teaches `setState` / `pushState` with examples. J1 appends an override rule. The policy refuses
   built-ins anyway, but an LLM will waste generations on them.
5. **The runtime has five write paths into one tree** (research §3): `$bindState`, the built-ins
   inside `ActionProvider`, handlers' `setState`, `onSuccess` / `onError` `set`, and the seed.
   - J1 closes them with two independent layers:
     1. **the policy**: no built-in, `watch`, `onSuccess` / `onError` / `confirm` or action list, and
        binds only onto `/form/<field>`;
     2. **the store facade**: every `set` / `update` outside `/form/<seeded field>` is refused and
        logged, and not even the snapshot identity changes.
   - The browser test reaches layer 2 *around* layer 1 through json-render's own hooks
     (`useStateStore().set`, `useActions().execute({ action: "setState" | "pushState" })`). All three
     illegal writes are refused, and the legal `/form/title` write lands through `editField`.
6. **Components get `emit`, not an element key.** A registry component cannot tell which element it
   is, so J1 does not use json-render's action execution at all.
   - Each implementation receives `action(event)` (looked up from `element.on`) and never `emit`.
   - The policy makes each action bindable at most once per spec, so the name alone identifies the
     capture.

## Pros

- A new capability, contained in 9 bundles, 2 kits and 2 feature files. P0 is byte-identical, and
  so are the 29 Todos and Contacts files.
- Correctness is structural:
  - single writer (the store facade plus a form group that accepts only seeded fields);
  - commit time (P3's capture);
  - refuse (P3's same-tick `running`);
  - scope (a synchronous `end()`, and every write checks `open`).
- The vocabulary composes like any other slot: arrival order does not matter, removal is clean, and
  coverage reports unobserved vocabulary.
- json-render is used only for what it does well: the prompt generation, the SpecStream compiler and
  the renderer walk. The library's churn is contained in `@kit/catalog`, `agent` and
  `agent.ui.react`.

## Cons

- The safety comes from us, not from the library: a 108-LOC policy and the store facade, plus the
  `dyn` / `bindable` convention. A reviewer must trust these two, and the negative controls are
  their only guard.
- A second visual vocabulary sits beside the hand-written views, with generic components that are
  styled separately.
- No DOM renderer exists (json-render has none). The agent feature is React-only here: a DOM host
  would report `jr:generated` as unrendered.
- The concepts are local but real: +6 (catalog entry, spec/stream, policy, GeneratedView, agent
  action, generator/data).
- Zod is in the catalog API types. It was already in P0's bundle through `@statewalker/shared-commands`,
  so it costs 0 KB here.
- One action binding per spec limits what the generator can say. For example, "Create" on each
  table row is impossible without per-element action identity.

## Fitness table

Measured as ARCHITECTURE.md §13 prescribes, side by side with P0.

| Axis | Measurement | P0 | J1 | Notes |
| --- | --- | --- | --- | --- |
| Simplicity | concepts a newcomer must learn | 26 | **26 + 6** (agent feature only) | + P3's commit record, already in K |
| Simplicity | LOC of the new capability (src) | n/a | **1 467** (logic 801, UI 284, API 80, kits 231 incl. P3's 161, manifests 71) | per bundle: agent 539 (controller 274, model 157, policy 108), agent.fixtures 106 (81 recorded fixture), catalog 70, agent.contacts-actions 57, agent.todos-actions 18, badge 11; UI: catalog.ui.react 144, agent.ui.react 123, badge.ui.react 17; kit catalog 70 |
| Simplicity | cost to add a component | n/a | **definition 11 LOC / 1 file + React 17 LOC / 2 files, 0 edits elsewhere** | per additional technology: one implementation |
| Simplicity | cost to let an agent use a command | n/a | **18 LOC / 1 bundle** (`agent.todos-actions`) | no edit in the app it acts on |
| Separation | boundary suite: rules / violations | 8 / 0 | **8 / 0** | R1 widened: renderers may value-import `@json-render/react`; R7 as P3 (`@kit/commit`) |
| Separation | single-writer violations | 0 | **0** | + the store facade's negative controls: 7 refused paths headless, 3 through json-render's own hooks in Chromium |
| Separation | domain-logic hits in views | 2 | **2** (0 new) | catalog components are generic; the agent renderer has no domain code |
| Independence | cross-bundle edges / to API / violations | 53 / 53 / 0 | **73 / 73 / 0** (50 distinct) | the new bundles reach only `agent/api`, `catalog/api(+react)`, `shell/api(+react)`, `todos/api`, `contacts/api` |
| Independence | Todos/Contacts files changed | n/a | **0 / 29** (P0: 0 / 71 files changed) | SHA identity test with a negative control |
| Independence | removal runs: errors | 4 / 0 | **4 + 5 / 0** | −agent: `ui:catalog` and `ui.react:catalog` reported unobserved; −ui.catalog: complete; −todos: `todos.compose` refused; −ui.badge; −agent.react: `jr:generated` unrendered |
| Composability | interactions (1)–(3) | 3/3 | **3/3 + (1) through a generated UI** | P0's scenarios pass on the agent workbench (Chromium) |
| Composability | vocabulary contributors aggregated | n/a | **5 bundles in 4 features → 1 catalog** | clash = loud activation failure |
| Correctness gate | contract · commit races · dispose · late · read-then-set | green | **green** (P0's suites unchanged) | + J1: commit time ×2 (node, DOM), double press ×2, press-time `/data`, session close / replace / stop |
| Negative controls | spec refusals | n/a | **14** | 11 mid-stream (unknown type, bad props, `setState`, `todos.remove`, `watch`, bind `/data`, read `/secrets`, seed `/data`, action list, `onSuccess`, undeclared event) + 3 complete-spec (double binding, unseeded field, dangling child); each: nothing shown, stream aborted, 0 commands, 0 errors |
| Bundle | JS added (vite build, all chunks) | 677 KB / 175 KB gz | **+106 KB / +33 KB gz** | json-render core + react as imported: 68.6 KB / 21.9 KB gz (esbuild, zod and react external); Zod: **+0**, already in P0's bundle (`core` chunk, 324 KB / 72 KB gz); without that, zod v4 would add ≈92 KB gz (research) |

## Answers to the points to clarify

- **Flag in the command declaration, or allow-list in `agent.*` bundles?** The allow-list in
  `agent.*` bundles, as contributions to `agent:actions`.
  - This keeps the app untouched (0 Todos and Contacts changes), and removing the app removes the
    entry.
  - A flag would edit every app API and would still need the `run` glue somewhere.
  - The allow-list IS the slot. The policy refuses everything else, including real commands such as
    `todos.remove` and every built-in.
- **Zod params, or the command's own schema?**
  - Zod, written next to the allow-list entry. P0's commands are `passthrough` and have no schema to
    convert.
  - json-render needs Zod for the prompt, and the drain parses the captured params with the same
    schema before `run`. For example, a whitespace title is refused and never reaches
    `todos:compose`.
  - If commands gain schemas (the deferred item), the agent entry should *reference* the command's
    schema instead of repeating it. A converter is then needed only if that schema is not Zod.
- **`validateForm` / `checks` in generated UIs?** They stay out: the policy refuses a
  `validateForm` binding as not allow-listed, and `checks` is not in any catalog prop.
  - Errors come from the command's schema at drain time (published as the model's `outcome`) and
    from the command itself.
  - One validation system per form, owner-side, as ADR-013 says.

## Recommendation for consolidation

- Adopt **option (c) + (d) as J1 built them**: two keyed catalog slots, one `jr:generated` view kind
  whose model keeps the three kinds, an agent controller that drains commit records into existing
  commands, and agent actions as allow-list contributions.
- Make three J1 inventions **normative** if agents are adopted:
  1. the **policy** (no built-ins, `watch`, outcome hooks or action lists; binds only onto
     `/form/<seeded>`; reads only `/form` and `/data`; one binding per action);
  2. the **store facade** as the only writer json-render sees;
  3. **components receive capabilities (`action`, `write`), never `emit`**.
- Keep the policy's negative controls in the correctness gate.
- Pin json-render exactly and treat its validation as a type check only. Findings 1–4 are
  library-level. Report them upstream, and re-verify them on every bump.
- Do not extend json-render to hand-written views (J2). J1 confirms the research: the library's
  state model needs a guard at every entry point, which is acceptable for a sandboxed form group and
  not for our models.
