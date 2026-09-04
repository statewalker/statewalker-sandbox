# Z — JSON Schema can be derived from Zod source, for the subset the shell uses

`pnpm test Z-static-schema`

## Goal

**Question**: can JSON Schema be derived statically from a Zod expression,
without executing the module?

**Answer: yes, for the subset the shell actually uses.**

### Why this mattered in the ladder

This was the **top-ranked open thread of [rung 04](../04-manifest-generation)**,
and the reason is structural rather than cosmetic.

Rung 04 established that a manifest can be derived from source without running
it — which is what lets the shell render a peer's contributions before, and
without, importing that peer's code. But the manifest it produces carries keys,
policies and UX metadata and **not** `inputJsonSchema`. A command's schema is
what a tool projection (OpenAPI, MCP) needs to describe the command to an agent,
and what a form generator needs to render it.

So the question was whether rung 04's guarantee extends all the way, or stops one
field short. A "no" would have meant:

- **The manifest could not fully drive projection.** Half of it would be a build
  artifact and half of it a runtime one, and the runtime half is exactly the half
  that requires importing a peer's module — reintroducing the execution rung 04
  was built to avoid, one field at a time.
- **Projection would stay a runtime concern**, so the shell could not publish a
  peer application's tool surface without first activating that application.
- **Rung 04's answer would have been narrower than it looked.** "The manifest is
  derivable" would have quietly meant "the parts of it that are string literals".

A "yes" closes rung 04's largest open thread: the manifest *can* carry
`inputJsonSchema`, and projection can be fully build-time.

`deriveJsonSchema(expression)` takes the **text** of a Zod expression, parses it
with the TypeScript compiler API, and returns a JSON Schema — or throws
`UnresolvableSchemaError` and returns nothing at all.

---

## ⚠ This code is a reconstruction, not recovered code

**Both archives of this rung are corrupt and no copy survives.**
`26-prototype-Z-static-schema-derivation.tar.gz` and
`26-prototype-04a-zod-static-schema.tar.gz` in
`notes/drive/2026-09-02.Httpeers-Shell/` both fail to decompress; note 39
predicted exactly this ("binary uploads to Drive proved unreliable at these
sizes").

Everything here was written from **note 29, §"Prototype Z"**. Every file carries
a `DERIVED-FROM-NOTE` header. Contrast [rung 04](../04-manifest-generation),
whose archive is intact and whose code is byte-for-byte the original — the two
are never blurred in this project.

### What the note specified

The note is a design record, not an API reference. It fixes:

- The **question** and the **answer** ("yes, for the subset the shell actually
  uses").
- The **method**: "Every test derives the schema twice — statically from source
  text, and at runtime from the real Zod object via the same vendor path
  `shared-commands` uses — and asserts they agree." This rung is built that way,
  and it is what makes the rung self-checking rather than an assertion of its own
  output back at itself.
- The **design rule**: report, never guess. "A wrong schema is worse than a
  missing one — an agent would construct arguments that satisfy the tool
  interface and then fail validation at the command bus, a confusing failure a
  long way from its cause."
- The **six categories** that must throw `UnresolvableSchemaError`, verbatim: an
  imported symbol, a computed enum, `.refine()`/`.superRefine()`,
  `.transform()`/`.pipe()`, non-serialisable types such as `z.instanceof(Blob)`,
  and object spreads of an unknown shape.
- The **error class name** `UnresolvableSchemaError`.
- That the derived-from input is an **expression, not a module** — "Z does not
  integrate with prototype 4's generator; it derives from an expression string".
- Two Zod-4 quirks the oracle caught on its first run (also in note 39): `.int()`
  emits a safe-integer maximum, and `required` is omitted when empty.
- That `z.union`, `z.literal`, `z.record`, `z.nullable` and dates all throw.
- That the archived suite had **16 tests**.

### What the note did NOT specify — decided here

Where the note is silent, this is the reconstruction's judgement, not history:

| Gap | Decision taken here |
|---|---|
| Every signature | `deriveJsonSchema(expression: string): JsonSchema`. The note never names a function. The `string` input follows from "it derives from an expression string" |
| Which vendor path is "the same one `shared-commands` uses" | `shared-commands@0.2.1` derives `inputJsonSchema` through `@standard-community/standard-json`. The oracle therefore goes through a real `CommandDeclaration` — `Command.async(k).input(s).output(…).build().inputJsonSchema` — rather than calling `z.toJSONSchema` directly, so it is the shell's actual path and not a re-implementation of it |
| Whether the six categories share one error class | One `UnresolvableSchemaError` with a `reason` field. The caller's decision is identical in every case: do not emit a schema |
| Whether the open-thread types (`z.union`, `z.literal`, `z.record`, `z.nullable`, dates) throw the *same* error | They do, with a seventh reason `unsupported-type`. The note says only "all throw" |
| Which constructs are IN the subset | `z.object`, `z.string`, `z.number`, `z.int`, `z.boolean`, `z.array`, literal `z.enum`, plus `.optional()`, `.describe()`, `.min()`, `.max()` and `.int()`. The note names no positive list; this is the closure of what the shell's own command inputs use |
| Whether a partly-derivable schema yields a partial result | It does not. Any underivable member fails the whole derivation — a silently-shrunk schema is precisely the wrong schema the design rule exists to prevent |
| The test partition | 21 tests here against the archive's 16. Same method, different split; no claim is made that these are the same 21 |

---

## Findings

### Derivation — twelve tests, each checked against the oracle

| # | Claim | How it is established | Falsified by |
|---|---|---|---|
| 1 | A flat object derives | `{id, title}` — both required, both `string` | Static output differing from the runtime schema in any key |
| 2 | `.optional()` moves a property out of `required` | `title` optional, `required` is `["id"]` only | An optional property appearing in `required`, or losing its type |
| 3 | **`required` is omitted when empty** (note 39) | `z.object({})` and an all-optional object carry no `required` key at all | Emitting `required: []`, which the vendor never does |
| 4 | **`z.int()` carries the safe-integer bounds** (note 39) | `maximum` is `9007199254740991`; `minimum` is `-9007199254740991` | A bare `{type:"integer"}`, or a bound guessed at the wrong magnitude |
| 5 | `z.number().int()` and `z.int()` agree | The two derive to identical schemas | The two spellings diverging |
| 6 | Length and range bounds derive | `minLength`/`maxLength` on strings, `minimum`/`maximum` on numbers; an explicit bound replaces the safe-integer one | Bounds dropped, mapped to the wrong keyword, or intersected with the safe range |
| 7 | Arrays derive, including of objects and with item counts | `z.array(z.string())`, `.min(1).max(3)` → `minItems`/`maxItems`, `z.array(z.object({…}))` | An `items` that is not itself a derived schema |
| 8 | Nested objects are sealed at every level | `additionalProperties: false` at the root *and* at the inner object | Sealing only the top level, which would accept junk one level down |
| 9 | Literal enums and booleans derive | `z.enum(["note","folder"])` → `{type:"string", enum:[…]}` | A bare `string` with the members lost |
| 10 | `.describe()` becomes `description` | On a property and on the object itself | Documentation dropped, which is what a tool projection shows an agent |
| 11 | A realistic command input derives whole | The rung-04 notes-app shape plus bounds, enum, array and optionals | Any single feature failing in combination with the others |
| 12 | The 2020-12 dialect is declared at the top level only | `$schema` present at the root, absent on the nested object | A `$schema` on every subschema, which is not what the vendor emits |

### Report, never guess — nine tests

| # | Claim | How it is established | Falsified by |
|---|---|---|---|
| 13 | An imported symbol is reported | `z.object({input: NotesInput})`, `NotesInput.extend({…})` and shorthand `{title}` all throw `imported-symbol` | Emitting a schema for a shape it cannot see — or throwing `ReferenceError`, which would mean it evaluated |
| 14 | A computed enum is reported | `z.enum(KINDS)` and `z.enum([FIRST,"b"])` throw `computed-enum` | An enum emitted with guessed or empty members |
| 15 | `.refine()`/`.superRefine()` are reported | Both throw `refinement` | Dropping the predicate and emitting the unrefined schema — the schema would then accept values the command bus rejects |
| 16 | `.transform()`/`.pipe()` are reported | Both throw `executable` | Emitting the input side of a transform as if it were the output |
| 17 | Non-serialisable types are reported | `z.instanceof(Blob)`, `z.file()` throw `non-serialisable` | Any JSON shape at all for a value that has none |
| 18 | An object spread is reported | `z.object({...base, x})` throws `object-spread` | Emitting the visible keys and silently omitting the spread's |
| 19 | Types outside the subset are reported, not approximated | `z.union`, `z.literal`, `z.record`, `.nullable()`, `z.date()`, `.default()` all throw `unsupported-type` | Any of them approximated — e.g. a union flattened to its first member |
| 20 | The error names the offending source | `error.source` contains `z.enum(KINDS)`; the message carries the reason | An error a build log cannot locate |
| 21 | Nothing is emitted when any part fails | `z.object({good: z.string(), bad: z.instanceof(Blob)})` throws rather than returning `{good}` | A partial schema, which is a *wrong* schema wearing a plausible shape |

### Two facts found that no note states

Both surfaced from the oracle, not from reading, and both are pinned by test:

- `z.int()` emits a **negative safe-integer minimum** too (`-9007199254740991`).
  Note 39 names only the maximum.
- An explicit `.min()`/`.max()` on an integer **replaces** the safe-integer bound
  rather than narrowing alongside it — `z.int().min(0).max(10)` yields exactly
  `{minimum: 0, maximum: 10}`.

## Techniques and APIs

### Method: the runtime derivation is the oracle

This is the note's method, kept verbatim, and it is the technique this rung
exists to demonstrate. Each derivation test writes its schema **once, as a
string**. That one string is both what the static deriver parses and what the
oracle evaluates:

```ts
async function agree(source: string) {
  const runtime = await runtimeSchema(source);        // evaluated, via shared-commands
  expect(deriveJsonSchema(source)).toEqual(runtime);  // parsed, never evaluated
  return runtime;
}
```

There is no hand-written expectation to drift, and no way for a test to agree
with the deriver by copying it. As the note puts it: "There is no point inventing
an independent expectation; agreement with the runtime path *is* the
requirement."

The oracle is the only evaluation in the rung, and it is on the *oracle* side by
construction — the deriver's input is text and its only tool is
`ts.createSourceFile`. The strongest evidence of that is test 13: deriving
`z.object({ input: NotesInput })` throws `UnresolvableSchemaError`, not
`ReferenceError`. `NotesInput` does not exist. Evaluation was never attempted.

### Why the oracle goes through `CommandDeclaration`, not `z.toJSONSchema`

```ts
const declaration = Command.async(`oracle:${n}`).input(schema).output(z.object({})).build();
const runtime = await declaration.inputJsonSchema;   // Promise<Record<string, unknown>>
```

`z.toJSONSchema(schema)` would be shorter and, for every case in this suite,
returns the same thing. It is still the wrong oracle. `shared-commands@0.2.1`
derives `inputJsonSchema` through **`@standard-community/standard-json`**, which
loads schema-vendor adapters by dynamic import — hence the `Promise`. That bridge
is the shell's **actual** derivation route, and it is a layer that can diverge
from Zod's own converter without anyone noticing.

Comparing against the route the shell really uses means a future bump of
`shared-commands`, of the bridge, or of Zod shows up here as a failing test rather
than as a wrong tool description handed to an agent. Comparing against
`z.toJSONSchema` would test a path the shell does not take.

### The static side

The parser is the same one rung 04 uses, and for the same reason — see that
rung's README for the compiler-API surface. What differs here:

- **The whole expression is wrapped, not visited.** `deriveJsonSchema` parses
  `` `const __schema = (${expression});` `` and takes
  `statements[0].declarationList.declarations[0].initializer`, then unwraps any
  `ts.isParenthesizedExpression`. There is no `forEachChild` walk: recursion
  follows the *schema* structure (object properties, array items), not the AST
  generally.
- **Chains are walked root-first.** `chainOf` collects links outermost-first then
  reverses, so `z.string().min(2).optional()` becomes base `string` followed by
  modifiers `min`, `optional`. The base constructor decides the JSON type;
  modifiers refine it.
- **`.min()`/`.max()` are polymorphic on the derived type so far** — `minLength`
  on a string, `minimum` on a number or integer, `minItems` on an array, and an
  `unsupported-type` error on anything else.

### Public surface

```ts
function deriveJsonSchema(expression: string): JsonSchema;   // throws UnresolvableSchemaError
type JsonSchema = Record<string, unknown>;

class UnresolvableSchemaError extends Error {
  readonly reason: UnresolvableReason;
  readonly source: string;   // the offending source text, for a build log
}

type UnresolvableReason =
  | "imported-symbol"    // z.object({ input: NotesInput }), NotesInput.extend({...}), { title }
  | "computed-enum"      // z.enum(KINDS)
  | "refinement"         // .refine() / .superRefine() — carries a predicate
  | "executable"         // .transform() / .pipe() — carries code
  | "non-serialisable"   // z.instanceof(Blob), z.file()
  | "object-spread"      // z.object({ ...base, x })
  | "unsupported-type";  // z.union, z.literal, z.record, .nullable(), z.date(), .default()
```

The first six are the note's categories verbatim; `unsupported-type` is this
reconstruction's addition, covering the note's open-thread types.

### The derivable subset

| Construct | Emits |
|---|---|
| `z.object({...})` | `{type:"object", properties, required?, additionalProperties:false}` — `required` omitted when empty |
| `z.string()` | `{type:"string"}` |
| `z.number()` | `{type:"number"}` |
| `z.int()`, `z.number().int()` | `{type:"integer", minimum:-2^53+1, maximum:2^53-1}` |
| `z.boolean()` | `{type:"boolean"}` |
| `z.array(inner)` | `{type:"array", items: <derived inner>}` |
| `z.enum(["a","b"])` — literal members only | `{type:"string", enum:["a","b"]}` |
| `.optional()` | the property is left out of `required` |
| `.describe("…")` — string literal only | `description` |
| `.min(n)` / `.max(n)` — numeric literal only | `minLength`/`maxLength`, `minimum`/`maximum`, or `minItems`/`maxItems` |

Everything else throws. **The constraint this imposes on application authors**:
command schemas must be written as **literal `z.*` expressions with literal enum
members** — the same shape of constraint rung 04 imposes on command keys, and now
enforced rather than assumed.

### Mutation testing

The suite passed on its first run, which is a reason for suspicion rather than
confidence (see Lessons). It was therefore mutation-tested by editing the deriver
and re-running:

| Mutant | Tests killed |
|---|---|
| Always emit `required: []` instead of omitting it when empty | 1 |
| Change the safe-integer minimum from `-2^53+1` to `0` | 4 |
| Emit `additionalProperties: true` | 12 |
| Silently skip an object spread instead of reporting it | 1 |
| Make `.optional()` mark nothing | 3 |

No mutant survived. The `additionalProperties` mutant killing 12 is the useful
signal: it confirms the `agree()` oracle comparison is live in every derivation
test rather than short-circuiting somewhere. The two mutants that kill only one
test each mark the thinnest coverage in the suite.

## Lessons learned

- **The `typescript@5.9.3` pin is load-bearing here too.** TypeScript 7 — the Go
  native port — ships no compiler API: its main export is version constants, and
  `typescript/unstable/ast` has type guards and enums with no `createSourceFile`
  and no `forEachChild`. This rung and [rung 04](../04-manifest-generation) both
  break on an upgrade. Anyone bumping `typescript` in this app must read both.
- **Report, never guess, is stronger here than at rung 04.** A wrong command key
  fails loudly at dispatch. A wrong *schema* fails quietly and far away: an agent
  builds arguments that satisfy the published tool interface, and validation
  rejects them at the command bus, a long way from the cause. Hence: any
  underivable member fails the whole derivation. There is no partial output.
- **Zod 4 emits things you would not guess from the method name.** `.int()` adds a
  safe-integer range — and note 39 records only the maximum; the minimum
  (`-9007199254740991`) is real and is not written down anywhere. An explicit
  `.min()`/`.max()` *replaces* that bound rather than narrowing alongside it,
  which is also unrecorded. `required` is omitted rather than emitted empty. Each
  of these is a fact about the vendor, not about JSON Schema, and none is
  derivable by reasoning — which is the entire argument for the oracle method.
- **Note 29's own record does not add up, so one divergence cannot be confirmed
  reproduced.** Its prose says "**Three tests failed on first run**, all genuine
  divergences"; the table immediately beneath it lists **two**. The two are `.int()`'s
  safe-integer bound and the omitted `required`, both reproduced here. The third
  is unrecorded and this reconstruction cannot claim to have hit it. If it was a
  third vendor quirk, it is still out there.
- **A suite that passes on its first run deserves suspicion, not relief.** Note 39
  lists this as a method finding of the original session, alongside the note that
  mutation testing found a weak test at three of the four rungs where it was
  applied — every time an assertion that was true but tested the wrong side of a
  boundary. This suite passed first run, so it was mutation-tested; see above.
- **Note 16's rule-3 wording is loose.** It says the policy is "the outermost
  chain link". In a `Command.async(k)…build()` chain, `.build()` is outermost and
  the policy is the link nearest the root. Rung 04's code is right; the prose
  would mislead anyone reimplementing from the note alone — as this rung had to
  do from note 29.
- **The app-level `pnpm typecheck` did not cover this folder while the rung was
  being restored.** The app `tsconfig.json` had `include: ["lib", "0*", "Z-*"]`;
  TypeScript expands a bare directory name but matches a wildcard entry as a
  *file* pattern, so no rung directory was picked up and `tsc --noEmit` passed
  vacuously. This folder and rung 04 were verified under the app's own compiler
  options via a throwaway config at the time, so the clean result was real when
  claimed. The `include` is now `["lib/**/*", "0*/**/*", "Z-*/**/*"]`, the
  app-level green covers 49 files, and it is evidence again.

## Not covered here

- **No integration with rung 04.** Z derives from an expression string; the
  generator has a command declaration in a real module. Wiring `.input(…)`'s
  argument node into `deriveJsonSchema` is the obvious next step and is not done.
  (The note is explicit that the original rung did not do it either.)
- **The subset is small.** `z.union`, `z.literal`, `z.record`, `z.nullable`,
  dates and tuples all throw. Each is easy to add and each needs its own oracle
  test — the safe-integer surprise is the argument for not skipping that.
- **No `$ref` or `$defs`.** A schema reused across two commands is inlined twice.
- **Formats are untested.** `z.email()` emits a `format` and a long `pattern` at
  runtime; nothing here derives them, and `z.email()` is reported as
  `unsupported-type` rather than approximated.
- **Output schemas are not exercised.** The oracle reads `inputJsonSchema` only;
  `outputJsonSchema` goes through the same bridge and is assumed, not tested.
