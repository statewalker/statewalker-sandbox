# 04 — A manifest can be derived from source that cannot be run

`pnpm test 04-manifest-generation`

**Question**: can a manifest be derived from TypeScript source without
hand-authoring it?

**Answer: yes, by static analysis only.**

`generateManifest(modulePath)` reads the file from disk, walks the TypeScript AST
and reads the `Command.async("notes:new").label(...).build()` builder chain
syntactically. It **never imports the module**. That constraint is not an
optimisation: a build environment may not be able to run application code at all
— the code may touch browser globals, hit the network, or simply throw — and a
manifest that requires executing the thing it describes is not a build-time
manifest.

## Provenance

**Recovered, not reconstructed.** This rung's archive
(`notes/drive/2026-09-02.Httpeers-Shell/13-prototype-04-manifest-generation.tar.gz`)
decompresses intact. `src/generate.ts`, `src/contribute.ts`, all three fixtures
and every assertion in `tests/generate.test.ts` are the archived code, byte for
byte. Each file carries a `RECOVERED-FROM-ARCHIVE` header.

The single edit is three string literals in the test file: the archive ran vitest
from the prototype's own package root, so its fixture paths were
`test/fixtures/…`; here they are `04-manifest-generation/tests/fixtures/…`. All
nine tests pass with their assertions untouched.

## What each test establishes

| # | Claim | How it is established | Falsified by |
|---|---|---|---|
| 1 | Exported command declarations are found | `notes-app.ts` yields exactly `notes:new` and `notes:delete` | A key missing, or one invented that the fixture does not declare |
| 2 | UX metadata comes off the builder chain | `.label`, `.icon`, `.description` recovered for `notes:new` | Any of the three undefined or wrong |
| 3 | The dispatch policy is recorded | `notes:new` is `async`, `notes:delete` is `required` | The policy is dropped or defaulted |
| 4 | The exported symbol name is emitted | `notes:new` carries `export: "NewNoteCommand"` | A missing `export`, which would force rung 05 back onto a module-level registry |
| 5 | Menu contributions are found with their `when` clauses | `contributeMenu({...})` yields location, group and `selection("note")` | A contribution missed, or a `when` clause dropped |
| 6 | The module path is carried so contributions resolve lazily | `manifest.module` equals the path passed in | The manifest cannot say where its code lives |
| 7 | **Generation never imports the module** | `explodes-on-import.ts` throws at module scope; generation against it still resolves | Any import — direct, dynamic, or via a transitive helper. This is the rung |
| 8 | An unresolvable key is reported, not guessed | `dynamic-key.ts` uses a template literal; a `non-literal-key` diagnostic is emitted and **zero** commands are produced | A command appearing with a guessed key, or the diagnostic being silent |
| 9 | The manifest is plain JSON | `JSON.stringify` round-trips and still holds two commands | A live Zod object, a function, or a cycle leaking into the output |

Test 7 is the negative assertion the rung exists for, and test 8 is the design
rule it shares with rung Z: **report, never guess.**

## Constraints this imposes on applications

Enforced now rather than assumed:

| Rule | Reason |
|---|---|
| Command keys must be string literals | a computed key cannot be resolved without executing the module |
| `contributeMenu` must be called by that name | recognition is syntactic; an alias or a wrapper is invisible |
| One module per manifest | the generator reads a single file |

## The TypeScript pin

`import ts from "typescript"` needs `createSourceFile` and `forEachChild`.
**TypeScript 7 — the Go native port — ships neither.** Its main export is
version constants; `typescript/unstable/ast` offers type guards and enums with no
parser entry point at all. The app therefore pins `typescript@5.9.3`, and the pin
is load-bearing for this folder specifically. Do not "upgrade" it.

## Not covered here

- **No JSON Schema.** This rung does not read `.input()` / `.output()`. That was
  its largest open thread; [`Z-static-schema`](../Z-static-schema) closes it, but
  the two are still not wired together — Z derives from an expression string, not
  from a command declaration in a real module.
- **The generated manifest is never loaded or executed.** Feeding it to an
  activation host is rung 05's question and is not restored here.
- **Multi-file applications are unaddressed.** One module, one manifest.
- **Nothing verifies a generated manifest still matches its source.** A stale
  manifest would fail silently at runtime.
