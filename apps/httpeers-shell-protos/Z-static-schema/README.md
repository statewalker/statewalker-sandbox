# Z — JSON Schema can be derived from Zod source, for the subset the shell uses

`pnpm test Z-static-schema`

**Question**: can JSON Schema be derived statically from a Zod expression,
without executing the module?

**Answer: yes, for the subset the shell actually uses.**

This was the top-ranked open thread of [rung 04](../04-manifest-generation).
That rung derives command keys, policies and UX metadata from source but not
`inputJsonSchema`, and projection to OpenAPI and MCP tools depends on the schema.
A negative answer would have meant projection stays a runtime concern and the
build-time manifest story weakens. A positive one means the manifest *can* carry
`inputJsonSchema`, so projection can be fully build-time.

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

## Method: the runtime derivation is the oracle

Each derivation test writes its schema **once, as a string**. That one string is
both what the static deriver parses and what the oracle evaluates:

```ts
async function agree(source: string) {
  const runtime = await runtimeSchema(source);   // evaluated, via shared-commands
  expect(deriveJsonSchema(source)).toEqual(runtime);  // parsed, never evaluated
  return runtime;
}
```

There is no hand-written expectation to drift, and no way for a test to agree
with the deriver by copying it.

The oracle is the only evaluation in the rung, and it is on the *oracle* side by
construction — the deriver's input is text and its only tool is
`ts.createSourceFile`. The strongest evidence of that is test 13: deriving
`z.object({ input: NotesInput })` throws `UnresolvableSchemaError`, not
`ReferenceError`. `NotesInput` does not exist. Evaluation was never attempted.

### The method paid for itself, again

The note records three tests failing on first run against the oracle. This
reconstruction was written against the oracle from the start, and it still turned
up two facts no note states:

- `z.int()` emits a **negative safe-integer minimum** too (`-9007199254740991`).
  Note 39 names only the maximum.
- An explicit `.min()`/`.max()` on an integer **replaces** the safe-integer bound
  rather than narrowing alongside it — `z.int().min(0).max(10)` yields exactly
  `{minimum: 0, maximum: 10}`.

Both are pinned by test. Both are the same shape of quirk the note warns about:
unguessable from the method name.

## What each test establishes

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

The suite passed on its first run. Note 39's own method finding says to treat
that as suspicious rather than reassuring, so it was mutation-tested: emitting
`required: []`, dropping the negative safe-integer bound, flipping
`additionalProperties` to `true`, ignoring an object spread, and ignoring
`.optional()` each fail 1, 4, 12, 1 and 3 tests respectively. No mutation
survived.

## What this constrains

Applications must write command schemas as **literal `z.*` expressions with
literal enum members** — the same shape of constraint rung 04 imposes on command
keys, and now enforced rather than assumed.

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
