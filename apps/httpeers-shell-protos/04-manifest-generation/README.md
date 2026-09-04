# 04 — A manifest can be derived from source that cannot be run

`pnpm test 04-manifest-generation`

## Goal

**Question**: can a manifest be derived from TypeScript source without
hand-authoring it — and without *executing* that source?

**Answer: yes, by static analysis only.**

### Why this mattered in the ladder

The shell is a browser for meshes: it renders applications served by **other
peers**. To place a peer's command in a menu or a palette, the shell has to know
what that application contributes. There are only two ways to find out — read its
declaration, or run it.

Running it is the thing the whole design refuses. A peer-served module is
untrusted code; importing it to *discover* its contributions means executing a
stranger's module before the user has asked for anything, on a build machine or
in the shell itself. It is also often simply impossible: application code touches
browser globals, hits the network, or throws at module scope, and a build
environment may not be able to run it at all.

So a "no" here would have invalidated the design, not merely inconvenienced it:

- **Lazy activation would be a fiction.** Rung 05's promise — a contribution
  renders before its module is imported — has nothing to render *from* unless the
  manifest exists independently of the module.
- **The shell would have to execute a peer's module to find out what it
  contributes**, which is exactly the trust boundary the mesh design is built to
  keep.
- **Tool projection (OpenAPI, MCP) would stay a runtime concern**, because a
  manifest you can only obtain by running the application is not a build artifact.

The manifest is therefore not a convenience format. It is the *only* thing the
shell is allowed to read before the user activates an application, and this rung
establishes that it can be produced from source alone.

Rung [`Z-static-schema`](../Z-static-schema) asks the follow-on question: can the
**JSON Schema** inside that manifest be derived statically too? This rung
deliberately leaves `.input()` / `.output()` alone.

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

## Findings

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

Two findings are worth pulling out of the table because they are design
conclusions rather than behaviours:

- **`export` exists because a JSON manifest cannot carry a live object.** The
  host needs a `CommandDeclaration` to dispatch. The first implementation reached
  for a module-level registry — a global — which leaked state across hosts and
  could not be cleared on a failed load. Carrying the symbol name instead means
  the declaration is just `mod[c.export]` after import. That is the concrete
  reason field 4 exists.
- **The two halves of a contribution are one source read two ways.**
  `contributeMenu({...})` is executed at runtime to register with the host, and
  read syntactically at build time to derive the manifest. One source of truth,
  two readings — which is what keeps the manifest and the code from drifting.

## Techniques and APIs

### Static analysis, not import

`generateManifest` reads the file with `readFileSync` and parses it with the
**TypeScript compiler API**. Nothing in the path can execute the module; the
strongest evidence is fixture `explodes-on-import.ts`, whose entire module
scope is a `throw new Error(...)` and against which generation still resolves.

The compiler API surface actually used is small and entirely syntactic — no
`Program`, no type checker, no `tsconfig` resolution:

| API | Use |
|---|---|
| `ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, /* setParentNodes */ true)` | The parser entry point. The fourth argument is **required**: without parent pointers, `node.getText(sf)` and `node.getStart(sf)` throw |
| `ts.forEachChild(node, visit)` | The whole traversal. A hand-rolled recursion over `node.getChildren()` would also walk tokens and punctuation |
| `ts.isVariableStatement`, `ts.isCallExpression`, `ts.isPropertyAccessExpression`, `ts.isIdentifier`, `ts.isObjectLiteralExpression`, `ts.isPropertyAssignment`, `ts.isStringLiteral`, `ts.isNoSubstitutionTemplateLiteral`, `ts.isNumericLiteral` | Node discrimination. These are the only guards needed |
| `node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)` | The `export` test. Modifiers are a node array, not a bitmask, at this level |
| `sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1` | 1-based line numbers for diagnostics |

Because there is no type checker, everything is **name-based**. The generator
does not know that the `Command` it sees is `@statewalker/shared-commands`'
`Command`; it knows only that the chain root is an identifier spelled `Command`.
That is a deliberate trade: a type checker would need a resolvable program, which
reintroduces the build-environment fragility the rung is avoiding.

### Reading a builder chain backwards

`Command.async("notes:new").label("New Note").icon("plus").build()` parses as a
call expression whose callee is a property access on the previous call. `chain()`
walks that spine outermost-first, collecting `{name, args}` per link:

```
links = [build, icon, label, async]
root  = Command
```

so `links[links.length - 1]` is the **policy call** — the link nearest the root,
not the outermost one. (Note 16's recognition rule 3 says "the outermost chain
link is a known policy". The outermost link is `.build()`; the prose is loose,
the code is right.) Metadata is then a lookup by link name over the same array,
which makes chain order irrelevant to everything except the policy.

### Recognition rules

A command is extracted when **all** hold:

1. The statement is a `VariableStatement` carrying an `export` modifier.
2. The initialiser is a call expression whose chain root is the identifier
   `Command`.
3. The link nearest the root is a known policy: `async`, `required`, `silent`,
   `custom`.
4. That policy call's first argument is a **string literal** (or a
   no-substitution template — a backtick string with no `${}`).

Failing 3 emits `unknown-policy`; failing 4 emits `non-literal-key`. In both
cases the command is **omitted rather than guessed**.

A menu item is extracted from any call to the identifier `contributeMenu` whose
argument is an object literal with string-literal `location` and `command`.

### Constraints this imposes on application authors

These are the price of syntactic recognition, and are now enforced rather than
assumed:

| Rule | Reason |
|---|---|
| Command keys must be string literals | a computed key cannot be resolved without executing the module |
| `contributeMenu` must be called by that name | recognition is syntactic; an alias, a re-export under another name, or a wrapper is invisible |
| The declaration must be an `export const` variable statement | the generator reads variable statements, not what a factory function returns |
| One module per manifest | the generator reads a single file |

### Exported signatures

```ts
// src/generate.ts
function generateManifest(modulePath: string): Promise<Manifest>;

interface Manifest {
  readonly module: string;
  readonly commands: ManifestCommand[];
  readonly menus: ManifestMenuItem[];
  readonly diagnostics: Diagnostic[];
}

interface ManifestCommand {
  readonly key: string;
  readonly policy: "async" | "required" | "silent" | "custom";
  readonly label?: string;
  readonly description?: string;
  readonly icon?: string;
  readonly export: string;   // exported symbol name
}

interface ManifestMenuItem {
  readonly location: string;
  readonly command: string;
  readonly group?: string;
  readonly order?: number;
  readonly when?: string;
}

interface Diagnostic {
  readonly kind: "non-literal-key" | "unknown-policy" | "non-literal-menu";
  readonly message: string;
  readonly line: number;
}

// src/contribute.ts — the runtime half of the same call site
function contributeMenu(item: ManifestMenuItem): void;
function drainContributions(): ManifestMenuItem[];
```

`generateManifest` is `async` although its body is synchronous: the signature
leaves room for an async file read without a breaking change.

## Lessons learned

- **TypeScript 7 ships no compiler API, and the `5.9.3` pin is load-bearing.**
  The Go native port's main export is `lib/version.cjs` — version constants.
  `typescript/unstable/ast` offers type guards and enums with **no
  `createSourceFile` and no `forEachChild`**: there is no parser entry point at
  all. Anyone upgrading `typescript` in this app breaks this folder and
  [`Z-static-schema`](../Z-static-schema), which reuses the same parser. This
  will recur — any build-time tooling in this project that walks TypeScript
  source needs the 5.x line until the TS 7 API stabilises.
- **Report, never guess.** A guessed command key produces a manifest that looks
  complete and dispatches to nothing. A diagnostic plus an omission produces a
  build log. Rung Z inherits the rule and states it more sharply: a wrong artifact
  is worse than a missing one.
- **Syntactic recognition is a contract with application authors, so it has to be
  written down.** "Command keys must be string literals" is not an implementation
  detail; it is an API constraint, and the `non-literal-key` diagnostic is how it
  is communicated at build time rather than discovered at runtime.
- **`setParentNodes` is not optional.** Passing `false` (or omitting it) to
  `createSourceFile` makes `getText()`, `getStart()` and therefore every
  diagnostic line number throw at runtime, with an error that does not mention the
  flag. This is the single easiest way to break this file.
- **The app-level `pnpm typecheck` did not cover this folder while the rung was
  being restored, and that is worth knowing about.** The app `tsconfig.json` had
  `include: ["lib", "0*", "Z-*"]`; TypeScript expands a bare directory name but
  matches a wildcard entry as a *file* pattern, so `tsc --listFiles` returned the
  seven files in `lib/` and no rung directory at all. Every "typecheck clean"
  reported during the restoration was therefore vacuous. This folder and
  `Z-static-schema` were verified under the app's own compiler options via a
  throwaway config at the time, so the clean result was real when claimed. The
  `include` is now `["lib/**/*", "0*/**/*", "Z-*/**/*"]` and the app-level green
  covers 49 files — it is evidence again. A typecheck that silently covers
  nothing is the same failure mode as a test that silently asserts nothing.

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
- **No cross-file resolution.** A command declared in one file and re-exported
  from another is invisible; so is an aliased `contributeMenu`.
