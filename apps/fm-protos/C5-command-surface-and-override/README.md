# C5-command-surface-and-override — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/C5-command-surface-and-override/`._

---

<!-- source: 01-C5 rung record and code.md -->

# C5 — Command surface and override · rung record

_9 September 2026 · green: 173/173 (17 new) · mutations killed: 6/6_

## Verdict

Phase C is closed. The whole `files:*` namespace is declared, registered at
negative priority, overridable per command, and projects to agent tools with no
bridge. Promotion grade: **Adopt** — with **one correction that invalidates an
assumption held since P0**.

## The correction: negative priority ORDERS listeners, it does not STOP them

This is the most consequential finding of Phase C, and P0 passed on luck.

Dispatch runs **every** registered listener in one pass and breaks only on
`cmd.settled`. A claim cannot settle synchronously, because resolution goes
through async output validation. So a host claiming at priority 0 **does not
prevent** the core's negative-priority listener from running immediately
afterwards — it enqueues a second job, and whichever promise resolves first
wins the race.

It showed up the moment the namespace grew past one command: the trash-mount
test got `job-5` instead of `trash`, because the host's handler did real I/O
while the core's returned an already-resolved promise and won.

**A fallback must decline explicitly.** Returning nothing is observe-only,
which leaves the host's claim untouched:

```ts
  /**
   * Negative priority orders the listeners; it does NOT stop them.
   *
   * Dispatch runs every listener in one pass and only breaks on `cmd.settled`,
   * which cannot happen synchronously because a claim resolves through async
   * output validation. So a host claiming at priority 0 does not prevent this
   * listener from running — and a fallback that acts anyway would perform the
   * operation twice, or race the host's answer and sometimes win.
   *
   * A fallback must therefore decline explicitly when the command is already
   * claimed. Returning nothing is observe-only, which is exactly right: it
   * leaves the host's claim untouched.
   */
  const fallback =
    <P, R>(handler: (cmd: { payload: P; claimed: boolean }) => Promise<R>) =>
    (cmd: { payload: P; claimed: boolean }): Promise<R> | undefined =>
      cmd.claimed ? undefined : handler(cmd);
```

File 07's description of the fallback convention should gain this sentence:
*a negative-priority handler must guard on `cmd.claimed`.* Without it the
convention is not "override", it is "run both and race".

## The second sharp edge: what counts as a claim

Only `true` or a **thenable** claims. A listener returning a plain object is
**observe-only** and is silently ignored.

A host author writing the obvious thing —
`commands.listen(filesResolveActions, (cmd) => ({ keys: [...] }))` — gets no
error, no warning, and the core fallback answers instead. It bit this rung
twice: once in the core's own `resolve-actions` handler, once in the test that
was meant to prove a host can narrow the set.

Both edges now have their own tests under **"what counts as a claim"**, so the
rules are executable documentation rather than a paragraph in a package README.

## The namespace

`files:copy`, `files:move`, `files:delete`, `files:mkdir`, `files:rename`, plus
`files:resolve-actions`. Uniform payload `{ files: FileRef[] }` — always an
array, so single-file and multi-file paths never branch in the panel — and
locations are resolved before dispatch, so **panel identity never appears**.
That is what lets an agent or a host call these directly, and it is asserted by
grepping every declaration's derived JSON Schema for `panelId`.

`delete` reached the engine as a third operation: it walks the same enumeration
and removes, sharing batching, cancellation, checkpointing and progress with
copy and move rather than getting its own path.

## Applicability is asked, not encoded

A registry is a flat catalog with no notion of what applies to what. Rather than
predicates in the schema or a side table, the app **asks** the host via
`files:resolve-actions`; unclaimed, the core fallback offers the whole
namespace. The app owns no MIME table and invents no extension rules.

## The agent projection needs no bridge

`CommandDeclaration` already carries `inputJsonSchema` — a promise of JSON
Schema derived via `@standard-community/standard-json`, documented for exactly
this. So the tool list is:

```ts
      const tools = await Promise.all(
        FILE_COMMANDS.map(async (d) => ({
          name: d.key.replace(":", "_"),
          description: d.description ?? d.label,
          input_schema: await d.inputJsonSchema,
        })),
      );
```

The same declarations that draw the menu are the agent's tools. No adapter, no
duplicate schema.

## Acceptance criteria, as tested

Payload: array-shaped even for one file; a two-file `rename` fails
`input-validation` before any handler runs; no declaration mentions `panelId`.

Operations: copy, move, delete, mkdir and rename all work through the bus.

Override: a host reroutes delete to a trash mount and **the file is moved, not
destroyed**; a rejecting host surfaces as `listener-threw` with the reason as
`cause`, and the copy does not happen; **every** command in the namespace is
overridable, checked in a loop — one command left at priority 0 would be an
unoverridable hole.

Claims: a plain-object host handler does not claim and the fallback answers; a
claimed command still runs lower-priority listeners, which must decline.

Errors: `no-handlers` on an empty bus; `listener-threw` short-circuits and the
core fallback does **not** run afterwards.

Registry: labels for the menu; `onUpdate` fires when a host adds or removes a
command at runtime; `compose` merges host commands with the core's; the agent
projection produces five tools with real JSON Schemas.

## Mutations run

| # | Mutation | Failing tests |
| --- | --- | --- |
| M1 | fallback ignores `cmd.claimed` | 2 |
| M2 | core registers at priority 0 | 4 |
| M3 | `resolve-actions` returns a plain object (no claim) | 2 |
| M4 | `resolve-actions` offers only copy | 2 |
| M5 | rename ignores the parent directory | 1 |
| M6 | delete routed through copy semantics | 1 |

## Phase C is closed

C0 packages and CI boundaries · C1 model kit · C2 panel algebra · C3 listing
lifecycle · C4 change notification · C5 command surface. 173 tests, 39
mutations killed in this phase.

## Next

**C0.5 — real adapters.** Everything so far runs on `MemFilesApi`, which never
denies permission, never expires, and never fails a write halfway. Three core
behaviours are asserted but unobserved: partial target removal after a real
interrupted write, re-acquisition failure on resume, and lane serialisation
under real latency. This runs before any UI, so a failure there is debugged
through one unproven layer rather than three.

