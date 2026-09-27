// DERIVED-FROM-NOTE: 16-Prototypes 4 and 5 API Reference.md §3
// DERIVED-FROM-NOTE: 15-Prototypes 4 and 5: Manifest Generation and Activation.md §3
//
// RECONSTRUCTION, NOT RECOVERED TESTS. The original suite (9 tests) is inside
// the corrupt archive `14-prototype-05-activation-events.tar.gz`. These are
// rebuilt from note 15's "Activation semantics established" table and note
// 16's "Activation contract", "Live declaration recovery" and "Loader
// contract" sections.
//
// PROTOTYPE 5 — can a contribution render before its module is imported?
//
// Note 15: "The central assertion is negative. The loader is an instrumented
// spy. After registering a manifest and rendering a menu — labels, icons,
// groups, ordering, and the command palette — the test asserts `loader` was
// NEVER called. 'Was it imported?' is the entire question."
//
// So `imported` below is the instrument. Every test that touches a non-
// importing method asserts `imported` is empty, and it is asserted as hard as
// the positive case.

import { Command, CommandError, Commands } from "@statewalker/shared-commands";
import { Slots } from "@statewalker/shared-slots";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActivationContext,
  type AppManifest,
  createActivationHost,
  type Loader,
} from "../src/host.js";

// --- fake modules -----------------------------------------------------------
// Note 15 §6: "Prototype 5 uses FAKE MODULES ONLY; no real application, no
// DOM, no rendering." A fake module is any object; the loader maps ids to
// them, which is exactly the explicit module map note 16's loader contract
// calls for.

const NewNoteCommand = Command.required("notes:new")
  .input(z.object({ title: z.string() }))
  .output(z.object({ id: z.string() }))
  .build();

const DeleteNoteCommand = Command.required("notes:delete")
  .input(z.object({ id: z.string() }))
  .output(z.object({ deleted: z.boolean() }))
  .build();

const ConnectCommand = Command.required("mesh:connect")
  .input(z.object({ peer: z.string() }))
  .output(z.object({ connected: z.boolean() }))
  .build();

/** The notes application. Its default export registers the handlers. */
function notesModule(log: string[]): Record<string, unknown> {
  return {
    NewNoteCommand,
    DeleteNoteCommand,
    default: ({ listen }: ActivationContext) => {
      log.push("activated:notes");
      listen(NewNoteCommand, (cmd) => Promise.resolve({ id: `note-${cmd.payload.title}` }));
      listen(DeleteNoteCommand, (cmd) => {
        // A PLAIN SYNCHRONOUS RETURN. Note 39: "A plain synchronous return
        // does not claim a command." Under `required` this rejects
        // `not-claimed`; the value below is silently discarded.
        void cmd;
        return { deleted: true } as unknown as void;
      });
    },
  };
}

/** The mesh application — eager, and with no default export at all. */
function meshModule(log: string[]): Record<string, unknown> {
  return {
    ConnectCommand,
    // No `default`. Note 16 says the default export is invoked "if callable".
    notCallable: 42,
    onLoad: () => log.push("activated:mesh"),
  };
}

const notesManifest: AppManifest = {
  id: "notes",
  module: "app:notes",
  commands: [
    {
      key: "notes:new",
      policy: "required",
      label: "New Note",
      icon: "plus",
      export: "NewNoteCommand",
    },
    {
      key: "notes:delete",
      policy: "required",
      label: "Delete Note",
      icon: "trash",
      export: "DeleteNoteCommand",
    },
  ],
  menus: [
    { location: "editor:title", command: "notes:new", group: "navigation", order: 1 },
    { location: "editor:title", command: "notes:delete", group: "edit", order: 2 },
    { location: "explorer:context", command: "notes:delete" },
  ],
  activation: ["onCommand:notes:new", "onCommand:notes:delete"],
};

const meshManifest: AppManifest = {
  id: "mesh",
  module: "app:mesh",
  commands: [
    { key: "mesh:connect", policy: "required", label: "Connect", export: "ConnectCommand" },
  ],
  menus: [
    { location: "editor:title", command: "mesh:connect", group: "edit", order: 1 },
    { location: "editor:title", command: "mesh:connect", group: "zzz" },
  ],
  activation: ["onStartup"],
};

// --- harness ----------------------------------------------------------------

function makeHost(opts?: { failFirst?: boolean }) {
  const log: string[] = [];
  /** THE INSTRUMENT. One entry per import, in order, carrying the module id
   * the host asked for. Empty means nothing was imported. */
  const imported: string[] = [];
  let failures = opts?.failFirst ? 1 : 0;

  const modules: Record<string, () => Record<string, unknown>> = {
    "app:notes": () => notesModule(log),
    "app:mesh": () => meshModule(log),
  };

  const loader: Loader = async (moduleId) => {
    imported.push(moduleId);
    if (failures > 0) {
      failures -= 1;
      throw new Error(`network: ${moduleId}`);
    }
    const make = modules[moduleId];
    if (!make) throw new Error(`no such module: ${moduleId}`);
    return make();
  };

  const commands = new Commands();
  const host = createActivationHost({ slots: new Slots(), commands, loader });
  return { host, imported, log, commands };
}

// --- 1. the negative assertion: rendering without importing ------------------

describe("rendering happens before, and without, the import", () => {
  it("renders a menu with labels, icons, groups and order from the manifest alone — the loader is never called", () => {
    const { host, imported } = makeHost();
    host.register(notesManifest);
    host.register(meshManifest);

    const entries = host.menu("editor:title");

    expect(entries).toContainEqual({
      command: "notes:new",
      label: "New Note",
      icon: "plus",
      group: "navigation",
      order: 1,
    });
    expect(entries).toContainEqual({
      command: "notes:delete",
      label: "Delete Note",
      icon: "trash",
      group: "edit",
      order: 2,
    });
    // A command with no icon renders without one rather than with `undefined`.
    expect(entries).toContainEqual({
      command: "mesh:connect",
      label: "Connect",
      group: "edit",
      order: 1,
    });

    // The whole rung, in one line.
    expect(imported).toEqual([]);
    expect(host.isActivated("notes")).toBe(false);
    expect(host.isActivated("mesh")).toBe(false);
  });

  it("orders entries navigation-first, then group lexicographically, then order — still without importing", () => {
    const { host, imported } = makeHost();
    host.register(notesManifest);
    host.register(meshManifest);

    expect(host.menu("editor:title").map((e) => e.command)).toEqual([
      "notes:new", // group "navigation" pins first
      "mesh:connect", // group "edit", order 1
      "notes:delete", // group "edit", order 2
      "mesh:connect", // group "zzz"
    ]);
    // An ungrouped entry in another location still renders.
    expect(host.menu("explorer:context")).toEqual([
      { command: "notes:delete", label: "Delete Note", icon: "trash" },
    ]);
    expect(imported).toEqual([]);
  });

  it("lists the command palette from every registered manifest — the loader is never called", () => {
    const { host, imported } = makeHost();
    host.register(notesManifest);
    host.register(meshManifest);

    expect(host.palette().map((c) => c.key)).toEqual(["notes:new", "notes:delete", "mesh:connect"]);
    // The palette carries UX metadata and the export name, straight from the
    // manifest — nothing here required executing the application.
    expect(host.palette()[0]).toMatchObject({ label: "New Note", export: "NewNoteCommand" });
    expect(imported).toEqual([]);
  });

  it("renders the same menu before and after activation", async () => {
    const { host, imported } = makeHost();
    host.register(notesManifest);

    const before = host.menu("editor:title");
    await host.invoke("notes:new", { title: "a" });
    const after = host.menu("editor:title");

    expect(imported).toEqual(["app:notes"]);
    expect(after).toEqual(before);
  });
});

// --- 2. the activation contract ---------------------------------------------

describe("activation contract", () => {
  it("imports once, on the first invoke, however many invokes follow", async () => {
    const { host, imported, log } = makeHost();
    host.register(notesManifest);

    expect(await host.invoke("notes:new", { title: "one" })).toEqual({ id: "note-one" });
    await host.invoke("notes:new", { title: "two" });
    await host.invoke("notes:new", { title: "three" });

    expect(imported).toEqual(["app:notes"]);
    expect(log).toEqual(["activated:notes"]);
    expect(host.isActivated("notes")).toBe(true);
  });

  it("shares one import across concurrent invokes", async () => {
    const { host, imported } = makeHost();
    host.register(notesManifest);

    const results = await Promise.all([
      host.invoke("notes:new", { title: "a" }),
      host.invoke("notes:new", { title: "b" }),
      host.invoke("notes:new", { title: "c" }),
    ]);

    expect(results).toEqual([{ id: "note-a" }, { id: "note-b" }, { id: "note-c" }]);
    expect(imported).toEqual(["app:notes"]);
  });

  it("leaves no half-activated application when the load fails", async () => {
    const { host, imported } = makeHost({ failFirst: true });
    host.register(notesManifest);

    await expect(host.invoke("notes:new", { title: "a" })).rejects.toThrow(/network/);

    expect(imported).toEqual(["app:notes"]);
    expect(host.isActivated("notes")).toBe(false);
  });

  it("retries after a failed load, because the memo is cleared on rejection", async () => {
    const { host, imported } = makeHost({ failFirst: true });
    host.register(notesManifest);

    await expect(host.invoke("notes:new", { title: "a" })).rejects.toThrow(/network/);
    // Memoising the rejected promise would make this second call fail too, and
    // one transient failure would disable the application permanently.
    expect(await host.invoke("notes:new", { title: "b" })).toEqual({ id: "note-b" });

    expect(imported).toEqual(["app:notes", "app:notes"]);
    expect(host.isActivated("notes")).toBe(true);
  });

  it("refuses a command with no matching activation event WITHOUT calling the loader", async () => {
    const { host, imported } = makeHost();
    host.register({
      ...notesManifest,
      // The manifest declares both commands but only activates on one.
      activation: ["onCommand:notes:new"],
    });

    await expect(host.invoke("notes:delete", { id: "x" })).rejects.toThrow(/not activatable/);
    expect(imported).toEqual([]);

    // ...and a key no manifest declares at all is a different failure.
    await expect(host.invoke("nothing:here", {})).rejects.toThrow(/unknown command/);
    expect(imported).toEqual([]);
  });

  it("imports nothing until startup(), which imports only the apps declaring onStartup", async () => {
    const { host, imported, log } = makeHost();
    host.register(notesManifest); // onCommand only
    host.register(meshManifest); // onStartup

    expect(imported).toEqual([]);

    await host.startup();

    expect(imported).toEqual(["app:mesh"]);
    expect(host.isActivated("mesh")).toBe(true);
    expect(host.isActivated("notes")).toBe(false);
    // The mesh module has no callable default export; activation still
    // completes, and nothing was invoked on its behalf.
    expect(log).toEqual([]);
  });

  it("hands the module's default export a `listen`, and dispatches through the handlers it registers", async () => {
    const { host, commands } = makeHost();
    host.register(notesManifest);

    const seen: unknown[] = [];
    // A shell-side listener on the same bus proves the app registered on the
    // host's bus rather than one of its own.
    commands.listen(NewNoteCommand, (cmd) => {
      seen.push(cmd.payload);
    });

    await host.invoke("notes:new", { title: "spec" });
    expect(seen).toEqual([{ title: "spec" }]);
  });
});

// --- 3. live declaration recovery -------------------------------------------

describe("live declaration recovery", () => {
  it("dispatches through the declaration found at mod[export], with no global registry", async () => {
    const { host } = makeHost();
    host.register(notesManifest);

    // `notes:new` is dispatched only if the host recovered the live
    // declaration exported as `NewNoteCommand` — the manifest is JSON and
    // carries no schema, so payload validation could not happen otherwise.
    expect(await host.invoke("notes:new", { title: "ok" })).toEqual({ id: "note-ok" });

    // The recovered declaration is the real one, schemas included: a bad
    // payload is rejected by the bus at the input boundary.
    await expect(host.invoke("notes:new", { title: 7 })).rejects.toMatchObject({
      kind: "input-validation",
    });
  });

  it("survives a manifest naming an export the module does not have", async () => {
    const { host } = makeHost();
    host.register({
      ...notesManifest,
      commands: [
        { key: "notes:new", policy: "required", label: "New Note", export: "NewNoteCommand" },
        { key: "notes:ghost", policy: "required", label: "Ghost", export: "GhostCommand" },
      ],
      activation: ["onCommand:notes:new", "onCommand:notes:ghost"],
    });

    // The stale entry does not poison the application.
    expect(await host.invoke("notes:new", { title: "ok" })).toEqual({ id: "note-ok" });
    expect(host.isActivated("notes")).toBe(true);
    await expect(host.invoke("notes:ghost", {})).rejects.toThrow(/no live declaration/);
  });

  it("does not treat a plain synchronous return as a claim", async () => {
    const { host } = makeHost();
    host.register(notesManifest);

    // `notes:delete`'s handler returns `{ deleted: true }` synchronously. It
    // looks like an answer and is not one: only `true`, a promise, or a direct
    // `cmd.resolve` claims. Under `required` policy the bus rejects.
    const err = await host.invoke("notes:delete", { id: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect((err as CommandError).kind).toBe("not-claimed");
  });
});

// --- 4. the loader contract -------------------------------------------------

describe("loader contract", () => {
  it("passes the manifest's module id through verbatim, with nothing concatenated", async () => {
    const { host, imported } = makeHost();
    host.register({ ...notesManifest, module: "peer:QmAbc/notes@2" });

    // The id is opaque to the host: it is resolved by the caller's module map
    // or route table, never joined onto a base path here. A host that built a
    // path would break this id, and Vite could not analyse the import anyway.
    await expect(host.invoke("notes:new", { title: "a" })).rejects.toThrow(/no such module/);
    expect(imported).toEqual(["peer:QmAbc/notes@2"]);
  });
});
