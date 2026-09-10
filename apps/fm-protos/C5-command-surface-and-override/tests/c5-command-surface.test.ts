import { beforeEach, describe, expect, it } from "vitest";
import { Commands, CommandError, CommandsRegistry } from "@statewalker/shared-commands";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import {
  FILE_COMMANDS, JobQueue, StorageRegistry, filesCopy, filesDelete, filesMkdir,
  filesMove, filesRename, filesResolveActions, registerFileCommands,
} from "@fm/core";

/** C5 — the whole namespace, its override convention, and its error kinds. */

const ref = (path: string, storage = "mem://a") => ({ storage, path, kind: "file" as const });

describe("C5 · command surface", () => {
  let commands: Commands;
  let instances: Record<string, MemFilesApi>;
  let registry: StorageRegistry;
  let queue: JobQueue;

  beforeEach(() => {
    instances = {
      "mem://a": new MemFilesApi({ initialFiles: { "/src/a.txt": "a", "/src/b.txt": "b" } }),
      "mem://b": new MemFilesApi(),
    };
    registry = new StorageRegistry(
      ["mem://a", "mem://b"].map((uri) => ({ uri, adapter: "mem", options: {} })),
      { mem: (uri) => instances[uri] },
      { async get() { return undefined; } },
    );
    queue = new JobQueue(registry, { batchSize: 2 });
    commands = new Commands();
    registerFileCommands(commands, { queue, resolve: (uri) => instances[uri] });
  });

  describe("the uniform payload contract", () => {
    it("takes an array even for one file, so panels never branch", async () => {
      const { jobId } = await commands.call(filesCopy, {
        files: [ref("/src/a.txt")],
        target: { storage: "mem://b", path: "/dst" },
      }).promise;
      await queue.get(jobId).done;
      expect(await instances["mem://b"].exists("/dst/a.txt")).toBe(true);
    });

    it("rejects a payload that breaks the schema, before any handler runs", async () => {
      const err = await commands
        .call(filesRename, { files: [ref("/src/a.txt"), ref("/src/b.txt")], name: "x" })
        .promise.then(() => null, (e) => e);
      expect(err).toBeInstanceOf(CommandError);
      expect((err as CommandError).kind).toBe("input-validation");
    });

    it("carries no panel identity — an agent can call it with resolved locations", async () => {
      for (const declaration of FILE_COMMANDS) {
        const schema = await declaration.inputJsonSchema;
        expect(JSON.stringify(schema), declaration.key).not.toMatch(/panelId/);
      }
    });
  });

  describe("every operation is claimed by the core", () => {
    it("copies, moves, deletes, mkdirs and renames", async () => {
      const a = instances["mem://a"];

      const copy = await commands.call(filesCopy, {
        files: [ref("/src/a.txt")], target: { storage: "mem://b", path: "/dst" },
      }).promise;
      await queue.get(copy.jobId).done;
      expect(await instances["mem://b"].exists("/dst/a.txt")).toBe(true);

      const move = await commands.call(filesMove, {
        files: [ref("/src/b.txt")], target: { storage: "mem://b", path: "/dst" },
      }).promise;
      await queue.get(move.jobId).done;
      expect(await a.exists("/src/b.txt")).toBe(false);

      const del = await commands.call(filesDelete, { files: [ref("/src/a.txt")] }).promise;
      await queue.get(del.jobId).done;
      expect(await a.exists("/src/a.txt")).toBe(false);

      const dir = await commands.call(filesMkdir, {
        target: { storage: "mem://a", path: "/src" }, name: "new",
      }).promise;
      expect(dir.path).toBe("/src/new");
      expect(await a.exists("/src/new")).toBe(true);

      await a.write("/src/old.txt", [new TextEncoder().encode("o")]);
      const renamed = await commands.call(filesRename, {
        files: [ref("/src/old.txt")], name: "new.txt",
      }).promise;
      expect(renamed.path).toBe("/src/new.txt");
      expect(await a.exists("/src/new.txt")).toBe(true);
    });
  });

  describe("the negative-priority convention", () => {
    it("lets a host reroute delete to a trash mount without touching app code", async () => {
      const trashed: string[] = [];
      commands.listen(
        filesDelete,
        async (cmd) => {
          for (const file of cmd.payload.files) {
            await instances["mem://a"].move(file.path, `/trash${file.path}`);
            trashed.push(file.path);
          }
          return { jobId: "trash" };
        },
        { priority: 0 },
      );

      const { jobId } = await commands.call(filesDelete, { files: [ref("/src/a.txt")] }).promise;
      expect(jobId).toBe("trash");
      expect(trashed).toEqual(["/src/a.txt"]);
      // The core handler never ran: the file was moved, not destroyed.
      expect(await instances["mem://a"].exists("/trash/src/a.txt")).toBe(true);
    });

    it("lets a host add an approval step that can decline", async () => {
      commands.listen(filesCopy, () => Promise.reject(new Error("denied by policy")), { priority: 0 });
      const err = await commands
        .call(filesCopy, { files: [ref("/src/a.txt")], target: { storage: "mem://b", path: "/dst" } })
        .promise.then(() => null, (e) => e);
      // A rejecting listener surfaces as listener-threw, with the reason as
      // the cause — the caller sees a failure, not a silent fallthrough.
      expect((err as CommandError).kind).toBe("listener-threw");
      expect(String((err as CommandError).cause)).toMatch(/denied by policy/);
      expect(await instances["mem://b"].exists("/dst/a.txt")).toBe(false);
    });

    it("registers every file command at negative priority, not just copy", async () => {
      // The override convention is only real if it holds for the whole
      // namespace; one command left at priority 0 is an unoverridable hole.
      for (const declaration of [filesCopy, filesMove, filesDelete, filesMkdir, filesRename]) {
        let claimed = false;
        const off = commands.listen(declaration as never, (() => {
          claimed = true;
          return Promise.resolve({ jobId: "host", path: "/host" });
        }) as never, { priority: 0 });
        await commands.call(declaration as never, {
          files: [ref("/src/a.txt")],
          target: { storage: "mem://b", path: "/dst" },
          name: "n",
        } as never).promise.catch(() => undefined);
        off();
        expect(claimed, `${declaration.key} must be overridable`).toBe(true);
      }
    });
  });

  describe("applicability is asked, not encoded", () => {
    it("offers the whole namespace when no host claims the question", async () => {
      const { keys } = await commands.call(filesResolveActions, { files: [ref("/src/a.txt")] }).promise;
      expect(keys).toEqual(FILE_COMMANDS.map((c) => c.key));
    });

    it("lets a host narrow the applicable set per selection", async () => {
      commands.listen(
        filesResolveActions,
        async (cmd) => ({
          keys: cmd.payload.files.every((f) => f.path.endsWith(".txt"))
            ? ["files:copy", "files:rename"]
            : [],
        }),
        { priority: 0 },
      );
      const { keys } = await commands.call(filesResolveActions, { files: [ref("/src/a.txt")] }).promise;
      expect(keys).toEqual(["files:copy", "files:rename"]);
    });
  });

  describe("what counts as a claim", () => {
    it("a host returning a PLAIN OBJECT does not claim, and the fallback answers", async () => {
      // Only `true` or a thenable claims; anything else is observe-only. This
      // is the sharpest edge in the whole override convention: a host author
      // writing `(cmd) => ({ keys: [...] })` gets silently ignored.
      commands.listen(filesResolveActions, () => ({ keys: ["files:copy"] }) as never, { priority: 0 });
      const { keys } = await commands.call(filesResolveActions, { files: [ref("/src/a.txt")] }).promise;
      expect(keys).toEqual(FILE_COMMANDS.map((c) => c.key));
    });

    it("a claimed command still runs the lower-priority listeners, so they must decline", async () => {
      // Dispatch breaks only on `cmd.settled`, which cannot happen
      // synchronously. Without the `cmd.claimed` guard the core would enqueue
      // a second job and sometimes win the race to resolve.
      commands.listen(filesDelete, async () => ({ jobId: "host" }), { priority: 0 });
      const { jobId } = await commands.call(filesDelete, { files: [ref("/src/a.txt")] }).promise;
      expect(jobId).toBe("host");
      expect(queue.active()).toEqual([]); // the core enqueued nothing
      expect(await instances["mem://a"].exists("/src/a.txt")).toBe(true);
    });
  });

  describe("error kinds are distinguishable", () => {
    it("no-handlers when nothing is registered at all", async () => {
      const bare = new Commands();
      const err = await bare
        .call(filesDelete, { files: [ref("/src/a.txt")] })
        .promise.then(() => null, (e) => e);
      expect((err as CommandError).kind).toBe("no-handlers");
    });

    it("listener-threw short-circuits rather than silently falling through", async () => {
      commands.listen(filesDelete, () => { throw new Error("boom"); }, { priority: 0 });
      const err = await commands
        .call(filesDelete, { files: [ref("/src/a.txt")] })
        .promise.then(() => null, (e) => e);
      expect((err as CommandError).kind).toBe("listener-threw");
      // The core fallback must NOT have run: a throwing host is a visible
      // failure, not an invitation to do it anyway.
      expect(await instances["mem://a"].exists("/src/a.txt")).toBe(true);
    });
  });

  describe("the registry is the menu, and the agent tool list", () => {
    it("exposes declarations with labels for the menu", () => {
      const reg = CommandsRegistry.create(...FILE_COMMANDS);
      expect(reg.list().map((d) => d.label)).toEqual([
        "Copy", "Move", "Delete", "New folder", "Rename",
      ]);
    });

    it("notifies when a host adds or removes a command at runtime", () => {
      const reg = CommandsRegistry.create(...FILE_COMMANDS);
      let updates = 0;
      reg.onUpdate(() => { updates++; });
      reg.remove("files:delete");
      expect(reg.get("files:delete")).toBeUndefined();
      expect(updates).toBeGreaterThan(0);
    });

    it("composes a host's own commands alongside the core's", () => {
      const host = CommandsRegistry.create();
      const composed = CommandsRegistry.compose(CommandsRegistry.create(...FILE_COMMANDS), host);
      expect(composed.list().length).toBe(FILE_COMMANDS.length);
      expect(composed.get("files:copy")).toBeDefined();
    });

    it("projects to agent tools with no extra bridge", async () => {
      // `inputJsonSchema` exists on every declaration precisely for this: the
      // package derives JSON Schema for AI tool projection, so the same
      // declarations that draw the menu are the agent's tool list.
      const tools = await Promise.all(
        FILE_COMMANDS.map(async (d) => ({
          name: d.key.replace(":", "_"),
          description: d.description ?? d.label,
          input_schema: await d.inputJsonSchema,
        })),
      );
      expect(tools.map((t) => t.name)).toEqual([
        "files_copy", "files_move", "files_delete", "files_mkdir", "files_rename",
      ]);
      expect(tools[0].description).toMatch(/Copy the selected files/);
      expect(tools.every((t) => t.input_schema.type === "object")).toBe(true);
      expect(JSON.stringify(tools[0].input_schema)).toMatch(/files/);
    });
  });
});
