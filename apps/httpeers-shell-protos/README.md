# httpeers-shell-protos

The **shell prototype ladder** restored as runnable code — twelve rungs that each
answer one question about a "browser for meshes": a shell that renders applications
served by other peers.

Companion to [`httpeers-protos`](../httpeers-protos), which does the same for the
mesh ladder. That one runs demos over real libp2p; this one is a test suite, because
every question here is answered by an assertion rather than by a process.

## Where this came from

The ladder ran on 2–3 September 2026 and produced ten positive rungs. Its record is
the Drive session `notes/drive/2026-09-02.Httpeers-Shell/` — 39 notes, eleven
archives, and `code/shell-core/`, the consolidated live code.

**Three archives are corrupt and no copy survives** (note 39 predicted it: "binary
uploads to Drive proved unreliable at these sizes"). Rungs 01, 05, and Z were
therefore **rebuilt from their notes' signature-level API references**, not
recovered. Every file says which it is, and `PROVENANCE.md` is the index.

## Layout

`lib/` is `code/shell-core/` — the consolidated renderer, catalogue, Basecoat
mapping, dock, mount, peer and theme bridge. The archives hold *superseded* copies
of the renderer; note 39 is explicit that shell-core is what the code actually is,
so the rungs are tested against it rather than against their own historical copies.

Each rung is a folder: `README.md` (the question and the answer), `tests/`, and
`src/` only where the rung owns code that is not in `lib/`.

## Running it

```bash
pnpm install --ignore-workspace   # the app is self-contained; see below
pnpm test                         # every rung
pnpm test 03-a2ui-binding         # one rung
pnpm typecheck
```

**Dependencies are pinned explicitly rather than through `catalog:`.** The app has
to install and pass on its own, and two of its pins fight the workspace catalog:
`typescript` is `5.9.3` because rung 04 uses the **compiler API**, which TypeScript 7
does not ship (the catalog is on 6.x), and `vitest`/`happy-dom` match what the rungs
were written against.
