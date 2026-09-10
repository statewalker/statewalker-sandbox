import {
  type ActionKey,
  agentTools,
  bootstrap,
  commandRegistry,
  type FileRef,
  fileRef,
  filesCopy,
  filesDelete,
  filesMkdir,
  filesMove,
  filesRename,
  filesResolveActions,
  menuItems,
  panelsClose,
  panelsNavigate,
  panelsRefresh,
  panelsSelect,
  panelsSetSort,
  resolveActions,
  uiShowJob,
  uiShowPanel,
} from "@fm/app";
import { Command, CommandError, Commands, CommandsRegistry } from "@statewalker/shared-commands";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * C5 — the command surface and override.
 *
 * P0 already proved override and `not-claimed` on ONE command. This rung
 * generalises to the whole namespace and adds the registry's runtime `onUpdate`,
 * rather than re-proving the mechanism.
 */

const ref = (path: string, kind: "file" | "directory" = "file"): FileRef => ({
  storage: "left",
  path,
  kind,
});

interface App {
  commands: Commands;
  instance: Awaited<ReturnType<typeof bootstrap>>;
  left: MemFilesApi;
  right: MemFilesApi;
}

async function app(): Promise<App> {
  const commands = new Commands();
  commands.listen(uiShowPanel, () => true);
  commands.listen(uiShowJob, () => true);
  const left = new MemFilesApi({
    initialFiles: { "/src/a.txt": "aaa", "/src/b.txt": "bbb", "/src/sub/c.txt": "ccc" },
  });
  const right = new MemFilesApi({ initialFiles: { "/dst/keep.txt": "keep" } });
  const instance = await bootstrap({
    commands,
    storages: { left, right },
    panels: [
      { id: "p1", slot: "left", storage: "left", path: "/src" },
      { id: "p2", slot: "right", storage: "right", path: "/dst" },
    ],
  });
  return { commands, instance, left, right };
}

const read = async (api: MemFilesApi, path: string) => {
  let text = "";
  for await (const chunk of api.read(path)) text += new TextDecoder().decode(chunk);
  return text;
};

describe("C5 · every file operation is declared, and every one is overridable", () => {
  const all = [filesCopy, filesMove, filesDelete, filesMkdir, filesRename];

  it("declares the whole namespace under files:", () => {
    expect(all.map((d) => d.key).sort()).toEqual([
      "files:copy",
      "files:delete",
      "files:mkdir",
      "files:move",
      "files:rename",
    ]);
  });

  it("uses required policy on all of them, so a missing handler is an error not a hang", () => {
    for (const decl of all) {
      expect(decl.policy, decl.key).toEqual({
        onNoHandlers: "reject",
        onAllObserveOnly: "reject",
      });
    }
  });

  it("takes a selection as { files: FileRef[] } — and mkdir takes a LOCATION", async () => {
    // The uniform contract governs commands that act on a SELECTION, so single
    // and multi-file paths never branch in the panel. `mkdir` has no selection:
    // it creates something that does not exist yet, and a FileRef for it would
    // be a lie.
    for (const decl of [filesCopy, filesMove, filesDelete, filesRename]) {
      const issues = decl.inputSchema["~standard"].validate({ files: "not-an-array" });
      expect(issues, decl.key).toHaveProperty("issues");
    }
    const ok = filesMkdir.inputSchema["~standard"].validate({
      storage: "left",
      path: "/src/fresh",
    });
    expect(ok).not.toHaveProperty("issues");
  });

  it("takes the uniform payload: always an array, even for one file", async () => {
    const { commands, instance, right } = await app();
    // Single-file and multi-file paths never branch in the panel, because the
    // shape is the same.
    await commands.call(filesCopy, {
      files: [ref("/src/a.txt")],
      target: { storage: "right", path: "/dst" },
    }).promise;
    await instance.settled();
    await instance.jobs.get(instance.jobs.lastJobId() as string).done;

    const { jobId } = await commands.call(filesCopy, {
      files: [ref("/src/a.txt"), ref("/src/b.txt")],
      target: { storage: "right", path: "/dst" },
    }).promise;
    await instance.jobs.get(jobId).done;

    expect(await right.exists("/dst/a.txt")).toBe(true);
    expect(await right.exists("/dst/b.txt")).toBe(true);
    instance.dispose();
  });

  // Each declaration has its own payload and its own answer shape, so the host's
  // reply has to satisfy that declaration's output schema. A single blob reused
  // across four commands tests the validator, not the override.
  const overrides = [
    {
      decl: filesMove,
      payload: { files: [ref("/src/a.txt")], target: { storage: "right", path: "/dst" } },
      answer: { jobId: "host-job" },
    },
    {
      decl: filesDelete,
      payload: { files: [ref("/src/a.txt")] },
      answer: { removed: 0 },
    },
    {
      decl: filesMkdir,
      payload: { storage: "left", path: "/src/newdir" },
      answer: { path: "/trash/newdir" },
    },
    {
      decl: filesRename,
      payload: { files: [ref("/src/a.txt")], name: "renamed.txt" },
      answer: { path: "/src/a.txt" },
    },
  ] as const;

  for (const { decl, payload, answer } of overrides) {
    it(`lets a host override ${decl.key} at priority 0, and the core then does nothing`, async () => {
      const { commands, instance, left } = await app();
      const seen: string[] = [];
      commands.listen(
        decl as never,
        (async () => {
          seen.push(decl.key);
          return answer;
        }) as never,
        { priority: 0 },
      );

      const result = await commands.call(decl as never, payload as never).promise;
      await instance.settled();

      expect(seen).toEqual([decl.key]);
      expect(result).toEqual(answer);
      // Asserted by the file system being untouched, not by the answer alone:
      // route delete to a trash mount, add an approval step, block a write.
      expect(await read(left, "/src/a.txt")).toBe("aaa");
      expect(await left.exists("/src/newdir")).toBe(false);
      expect(await left.exists("/src/renamed.txt")).toBe(false);
      instance.dispose();
    });
  }

  it("registers the core handlers at negative priority, so priority 0 wins", () => {
    // The package's documented fallback convention: the core never competes at 0.
    expect(commandRegistry().corePriority).toBe(-1);
  });
});

describe("C5 · files:resolve-actions is the applicability mechanism", () => {
  it("offers the whole namespace when no handler claims it", async () => {
    const commands = new Commands();
    const keys = await resolveActions(commands, [ref("/src/a.txt")]);

    // A registry is a flat catalog with no notion of applicability. When nobody
    // answers, everything is offered — the app owns no MIME table and invents no
    // extension rules.
    expect(keys).toEqual([
      "files:copy",
      "files:delete",
      "files:mkdir",
      "files:move",
      "files:rename",
    ]);
  });

  it("returns exactly what the host says applies, and nothing else", async () => {
    const commands = new Commands();
    commands.listen(filesResolveActions, async () => ({
      actions: ["files:copy", "files:delete"] as ActionKey[],
    }));

    const keys = await resolveActions(commands, [ref("/src/a.txt")]);
    expect(keys).toEqual(["files:copy", "files:delete"]);
  });

  it("passes the selection through unchanged, as the uniform array payload", async () => {
    const commands = new Commands();
    const seen: FileRef[][] = [];
    commands.listen(filesResolveActions, async (cmd) => {
      seen.push(cmd.payload.files);
      return { actions: [] as ActionKey[] };
    });

    await resolveActions(commands, [ref("/src/a.txt"), ref("/src/sub", "directory")]);
    expect(seen).toEqual([[ref("/src/a.txt"), ref("/src/sub", "directory")]]);
  });

  it("offers nothing when the host says nothing applies", async () => {
    const commands = new Commands();
    commands.listen(filesResolveActions, async () => ({ actions: [] as ActionKey[] }));
    expect(await resolveActions(commands, [])).toEqual([]);
  });
});

describe("C5 · CommandError.kind discipline", () => {
  it("rejects as not-claimed when the panel is gone — expected, not scary", async () => {
    const { commands, instance } = await app();
    await instance.panels.remove("p2");

    const err = await commands.call(panelsNavigate, { panelId: "p2", path: "/" }).promise.then(
      () => null,
      (e) => e,
    );

    expect(err).toBeInstanceOf(CommandError);
    expect((err as CommandError).kind).toBe("not-claimed");
    instance.dispose();
  });

  it("rejects as no-handlers when nothing is listening at all", async () => {
    const commands = new Commands();
    const err = await commands.call(panelsRefresh, { panelId: "p1" }).promise.then(
      () => null,
      (e) => e,
    );
    expect((err as CommandError).kind).toBe("no-handlers");
  });

  it("rejects as input-validation on a malformed payload", async () => {
    const { commands, instance } = await app();
    const err = await commands
      .call(panelsNavigate, { panelId: 7, path: "/" } as never)
      .promise.then(
        () => null,
        (e) => e,
      );
    expect((err as CommandError).kind).toBe("input-validation");
    instance.dispose();
  });

  it("surfaces a throwing listener as listener-threw, never as a silent no-op", async () => {
    const { commands, instance } = await app();
    commands.listen(
      filesDelete,
      () => {
        throw new Error("host policy refused");
      },
      { priority: 0 },
    );

    const err = await commands.call(filesDelete, { files: [ref("/src/a.txt")] }).promise.then(
      () => null,
      (e) => e,
    );

    // A listener that throws short-circuits dispatch, so this must be visible.
    expect((err as CommandError).kind).toBe("listener-threw");
    expect(((err as CommandError).cause as Error).message).toBe("host policy refused");
    instance.dispose();
  });

  it("short-circuits dispatch: a thrower at 0 stops the core from running", async () => {
    const { commands, instance, left } = await app();
    commands.listen(
      filesDelete,
      () => {
        throw new Error("refused");
      },
      { priority: 0 },
    );
    await commands.call(filesDelete, { files: [ref("/src/a.txt")] }).promise.catch(() => undefined);
    await instance.settled();

    expect(await left.exists("/src/a.txt")).toBe(true);
    instance.dispose();
  });
});

describe("C5 · panel-scoped commands and the panelId guard", () => {
  const scoped = [panelsNavigate, panelsSetSort, panelsSelect, panelsRefresh, panelsClose];

  it("declares the coarse panel actions, and only those", () => {
    // The test is: would a host ever want to override it, or an agent ever want
    // to invoke it? Navigate yes, scroll no.
    expect(scoped.map((d) => d.key)).toEqual([
      "panels:navigate",
      "panels:set-sort",
      "panels:select",
      "panels:refresh",
      "panels:close",
    ]);
  });

  it("declares no command for continuous view state", () => {
    const keys = commandRegistry()
      .registry.list()
      .map((d) => d.key);
    expect(keys).not.toContain("panels:set-cursor");
    expect(keys).not.toContain("panels:set-scroll");
  });

  it("has exactly one panel claim a panelId-addressed command", async () => {
    const { commands, instance } = await app();
    await commands.call(panelsNavigate, { panelId: "p1", path: "/" }).promise;
    expect(instance.panels.get("p1").path).toBe("/");
    expect(instance.panels.get("p2").path).toBe("/dst");
    instance.dispose();
  });

  it("routes every panel-scoped command by panelId, not to whoever listens first", async () => {
    const { commands, instance } = await app();
    await commands.call(panelsSetSort, { panelId: "p2", sortBy: "size" }).promise;
    expect(instance.panels.get("p2").input.sortBy).toBe("size");
    expect(instance.panels.get("p1").input.sortBy).toBe("name");

    await commands.call(panelsSelect, { panelId: "p1", paths: ["/src/a.txt"] }).promise;
    expect(instance.panels.get("p1").input.selection).toEqual(["/src/a.txt"]);
    expect(instance.panels.get("p2").input.selection).toEqual([]);
    instance.dispose();
  });

  it("refreshes only the panel addressed, and demonstrably not the other one", async () => {
    const { commands, instance } = await app();
    const p1Before = instance.panels.get("p1").lastListedAt as number;
    const p2Before = instance.panels.get("p2").lastListedAt as number;
    await new Promise((r) => setTimeout(r, 2));
    await commands.call(panelsRefresh, { panelId: "p1" }).promise;
    await instance.settled();

    expect(instance.panels.get("p1").lastListedAt as number).toBeGreaterThan(p1Before);
    // Both halves of the pair: exactly one panel claims, so the other must be
    // untouched. Asserting only the addressed one passes with no guard at all.
    expect(instance.panels.get("p2").lastListedAt as number).toBe(p2Before);
    instance.dispose();
  });

  it("closes the panel addressed, and its view settles", async () => {
    const { commands, instance } = await app();
    await commands.call(panelsClose, { panelId: "p2" }).promise;
    expect(() => instance.panels.get("p2")).toThrow();
    expect(instance.panels.get("p1").id).toBe("p1");
    instance.dispose();
  });

  it("survives a listener whose own panel is broken: the guard is the FIRST statement", async () => {
    const { commands, instance } = await app();

    // A panel that throws on anything it touches, registered BEFORE the real
    // panels in dispatch order. If its guard ran second, the command meant for
    // p1 would die with it.
    commands.listen(panelsNavigate, (cmd) => {
      if (cmd.payload.panelId !== "ghost") return;
      throw new Error("disposed model touched");
    });

    await commands.call(panelsNavigate, { panelId: "p1", path: "/" }).promise;
    expect(instance.panels.get("p1").path).toBe("/");
    instance.dispose();
  });
});

describe("C5 · the registry projects menus, and updates at runtime", () => {
  it("renders items from declarations, with label and icon as i18n fallbacks", () => {
    const items = menuItems(commandRegistry().registry);
    const copy = items.find((i) => i.key === "files:copy");
    expect(copy).toEqual({
      key: "files:copy",
      labelKey: "command.files:copy.label",
      label: "Copy",
      description: undefined,
      icon: undefined,
    });
  });

  it("prefers the catalogue key over the declaration's own label", () => {
    // `.label` on the declaration is the FALLBACK; `command.{key}.label` is what
    // a translator overrides. The view layer resolves, so the controller only
    // hands over both.
    const items = menuItems(commandRegistry().registry, {
      "command.files:copy.label": "Kopieren",
    });
    expect(items.find((i) => i.key === "files:copy")?.label).toBe("Kopieren");
  });

  it("re-renders when a host command appears, and again when it disappears", () => {
    const core = commandRegistry().registry;
    const host = CommandsRegistry.create();
    const composed = CommandsRegistry.compose(core, host);
    let renders = 0;
    const off = composed.onUpdate(() => {
      renders++;
    });

    const hostCommand = Command.required("host:compress")
      .input(z.object({ files: z.array(fileRef) }))
      .output(z.object({ archive: z.string() }))
      .label("Compress")
      .build();

    expect(menuItems(composed).map((i) => i.key)).not.toContain("host:compress");

    host.set(hostCommand);
    expect(renders).toBe(1);
    expect(menuItems(composed).map((i) => i.key)).toContain("host:compress");
    // The label comes off the host's own declaration: the app has no table of
    // host commands to keep in step.
    expect(menuItems(composed).find((i) => i.key === "host:compress")?.label).toBe("Compress");

    host.remove("host:compress");
    expect(renders).toBe(2);
    expect(menuItems(composed).map((i) => i.key)).not.toContain("host:compress");
    // The core surface is untouched by either event.
    expect(menuItems(composed).map((i) => i.key)).toContain("files:copy");

    off();
  });

  it("filters a namespace down for a host that offers only part of it", () => {
    const readOnly = CommandsRegistry.filter(
      commandRegistry().registry,
      (decl) => decl.key !== "files:delete",
    );
    const keys = menuItems(readOnly).map((i) => i.key);
    expect(keys).toContain("files:copy");
    expect(keys).not.toContain("files:delete");
  });
});

describe("C5 · the agent-tool projection, with no extra bridge", () => {
  it("projects the same declarations as tools with JSON Schema input", async () => {
    const tools = await agentTools(commandRegistry().registry);
    const copy = tools.find((t) => t.name === "files:copy");
    expect(copy).toBeDefined();
    expect(copy?.description).toBe("Copy");
    expect(copy?.inputSchema).toMatchObject({ type: "object" });
  });

  it("lets an agent supply a resolved target and skip the picker entirely", async () => {
    const { commands, instance, right } = await app();
    const tools = await agentTools(commandRegistry().registry);
    const copy = tools.find((t) => t.name === "files:copy");
    if (!copy) throw new Error("files:copy was not projected");

    // The target-panel picker runs before dispatch, in the view. A caller that
    // already knows the target never meets it — which is the whole reason the
    // payload carries resolved locations and never panel identity.
    const result = (await copy.invoke(commands, {
      files: [ref("/src/a.txt")],
      target: { storage: "right", path: "/dst" },
    })) as { jobId: string };
    await instance.jobs.get(result.jobId).done;

    expect(await right.exists("/dst/a.txt")).toBe(true);
    instance.dispose();
  });

  it("projects no panel-scoped command as a tool, because panelId is not an agent's to know", async () => {
    const tools = await agentTools(commandRegistry().registry);
    expect(tools.map((t) => t.name)).not.toContain("panels:navigate");
    expect(tools.map((t) => t.name).sort()).toEqual([
      "files:copy",
      "files:delete",
      "files:mkdir",
      "files:move",
      "files:rename",
    ]);
  });
});

describe("C5 · the core operations actually do their work", () => {
  let a: App;

  beforeEach(async () => {
    a = await app();
  });

  it("moves files, leaving nothing behind at the source", async () => {
    const { jobId } = await a.commands.call(filesMove, {
      files: [ref("/src/a.txt")],
      target: { storage: "right", path: "/dst" },
    }).promise;
    await a.instance.jobs.get(jobId).done;

    expect(await a.right.exists("/dst/a.txt")).toBe(true);
    expect(await a.left.exists("/src/a.txt")).toBe(false);
    a.instance.dispose();
  });

  it("deletes every file in the uniform array", async () => {
    await a.commands.call(filesDelete, {
      files: [ref("/src/a.txt"), ref("/src/b.txt")],
    }).promise;

    expect(await a.left.exists("/src/a.txt")).toBe(false);
    expect(await a.left.exists("/src/b.txt")).toBe(false);
    a.instance.dispose();
  });

  it("makes a directory", async () => {
    await a.commands.call(filesMkdir, { storage: "left", path: "/src/fresh" }).promise;
    expect(await a.left.exists("/src/fresh")).toBe(true);
    a.instance.dispose();
  });

  it("renames within the same directory", async () => {
    await a.commands.call(filesRename, {
      files: [ref("/src/a.txt")],
      name: "renamed.txt",
    }).promise;

    expect(await a.left.exists("/src/renamed.txt")).toBe(true);
    expect(await a.left.exists("/src/a.txt")).toBe(false);
    expect(await read(a.left, "/src/renamed.txt")).toBe("aaa");
    a.instance.dispose();
  });

  it("refuses to rename more than one file at a time, as validation", async () => {
    const err = await a.commands
      .call(filesRename, { files: [ref("/src/a.txt"), ref("/src/b.txt")], name: "x.txt" })
      .promise.then(
        () => null,
        (e) => e,
      );
    expect((err as CommandError).kind).toBe("listener-threw");
    expect(await a.left.exists("/src/a.txt")).toBe(true);
    a.instance.dispose();
  });

  it("refuses a rename whose name is really a move", async () => {
    // file 08 §7's own example is `fm.rename.slash`: a name with a separator in
    // it is a different operation wearing a rename's clothes.
    const err = await a.commands
      .call(filesRename, { files: [ref("/src/a.txt")], name: "../escaped.txt" })
      .promise.then(
        () => null,
        (e) => e,
      );
    expect((err as CommandError).kind).toBe("listener-threw");
    expect(await a.left.exists("/src/a.txt")).toBe(true);
    a.instance.dispose();
  });

  it("publishes BOTH ends of a rename, because it is a removal and a creation", async () => {
    const seen: { path: string; kind: string }[] = [];
    a.instance.changes.observe({
      storage: "left",
      path: "/src",
      applyChanges: (changes) => {
        for (const c of changes) seen.push({ path: c.path, kind: c.kind });
      },
    });

    await a.commands.call(filesRename, {
      files: [ref("/src/a.txt")],
      name: "renamed.txt",
    }).promise;
    await a.instance.settled();

    expect(seen).toEqual(
      expect.arrayContaining([
        { path: "/src/a.txt", kind: "removed" },
        { path: "/src/renamed.txt", kind: "created" },
      ]),
    );
    a.instance.dispose();
  });

  it("publishes a move's source removals, so the source panel can mark them", async () => {
    const seen: { path: string; kind: string; jobId?: string }[] = [];
    a.instance.changes.observe({
      storage: "left",
      path: "/src",
      applyChanges: (changes) => {
        for (const c of changes) seen.push({ path: c.path, kind: c.kind, jobId: c.jobId });
      },
    });

    const { jobId } = await a.commands.call(filesMove, {
      files: [ref("/src/a.txt")],
      target: { storage: "right", path: "/dst" },
    }).promise;
    await a.instance.jobs.get(jobId).done;
    await a.instance.settled();

    // The source end carries the job id, which is what the per-row
    // pending-delete decoration is re-paired through.
    expect(seen).toEqual(expect.arrayContaining([{ path: "/src/a.txt", kind: "removed", jobId }]));
    a.instance.dispose();
  });

  it("announces no removal for a move whose source removal failed", async () => {
    // "wrote" and "removed" both carry the SOURCE path on a move, so publishing
    // on the wrong phase is invisible until the removal fails — and then it
    // announces a deletion that never happened.
    class StubbornFilesApi extends MemFilesApi {
      async remove(path: string): Promise<boolean> {
        if (path.startsWith("/src/")) throw new Error("source is pinned");
        return super.remove(path);
      }
    }
    const commands = new Commands();
    commands.listen(uiShowPanel, () => true);
    commands.listen(uiShowJob, () => true);
    const left = new StubbornFilesApi({ initialFiles: { "/src/a.txt": "aaa" } });
    const right = new MemFilesApi({ initialFiles: { "/dst/keep.txt": "k" } });
    const instance = await bootstrap({
      commands,
      storages: { left, right },
      panels: [{ id: "p1", slot: "left", storage: "left", path: "/src" }],
    });

    const seen: string[] = [];
    instance.changes.observe({
      storage: "left",
      path: "/src",
      applyChanges: (changes) => {
        for (const c of changes) if (c.kind === "removed") seen.push(c.path);
      },
    });

    const { jobId } = await commands.call(filesMove, {
      files: [ref("/src/a.txt")],
      target: { storage: "right", path: "/dst" },
    }).promise;
    await instance.jobs.get(jobId).done;
    await instance.settled();

    expect(instance.jobs.get(jobId).status).toBe("failed");
    expect(seen).toEqual([]);
    expect(await left.exists("/src/a.txt")).toBe(true);
    instance.dispose();
  });

  it("tells the panels showing the directory, through the same notifier", async () => {
    await a.commands.call(filesMkdir, { storage: "left", path: "/src/fresh" }).promise;
    await a.instance.settled();

    // Every operation is a producer of invalidations, not just copy.
    expect(a.instance.panels.get("p1").entries.map((e) => e.name)).toContain("fresh");
    a.instance.dispose();
  });

  it("reports a delete of a missing file rather than failing silently", async () => {
    const err = await a.commands.call(filesDelete, { files: [ref("/src/nope.txt")] }).promise.then(
      () => null,
      (e) => e,
    );
    expect((err as CommandError).kind).toBe("listener-threw");
    a.instance.dispose();
  });
});
