import { PanelController, PanelModel, type Picker, registerStorageOpener } from "@fm/app";
import { JobQueue, StorageRegistry, storagesOpen } from "@fm/core";
import { type CommandError, Commands } from "@statewalker/shared-commands";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";

/* Ported: the packages live under `lib/` in this app, not `packages/`. */
const FM_SRC = new URL("../../lib/", import.meta.url).pathname;

/**
 * D4 — a filesystem is opened by CALLING A COMMAND.
 *
 * The picker is the only thing that differs between a test and a browser: here
 * it hands back an in-memory filesystem, in production it calls
 * `showDirectoryPicker()`. Everything downstream is the same code.
 */

describe("D4 · opening a filesystem", () => {
  let commands: Commands;
  let registry: StorageRegistry;
  let picked: MemFilesApi;
  let requests: { mode: string; suggestedName?: string }[];

  const inMemoryPicker: Picker = async (request) => {
    requests.push(request);
    return { api: picked, name: "Documents" };
  };

  const wire = (pick: Picker = inMemoryPicker) => registerStorageOpener(commands, registry, pick);

  beforeEach(() => {
    commands = new Commands();
    registry = new StorageRegistry(
      [],
      {},
      {
        async get() {
          return undefined;
        },
      },
    );
    picked = new MemFilesApi({ initialFiles: { "/a.txt": "a", "/sub/b.txt": "b" } });
    requests = [];
  });

  it("fails loudly when the environment wired no picker at all", async () => {
    // There is no sensible default filesystem to invent, so the core registers
    // no fallback: an unwired app says so instead of opening something.
    const err = await commands.call(storagesOpen, { mode: "read" }).promise.then(
      () => null,
      (e) => e,
    );
    expect((err as CommandError).kind).toBe("no-handlers");
  });

  it("returns a URI the registry can already resolve", async () => {
    wire();
    const result = await commands.call(storagesOpen, { mode: "read" }).promise;

    expect(result.cancelled).toBe(false);
    expect(result.name).toBe("Documents");
    expect(registry.isAdopted(result.uri!)).toBe(true);
    expect(registry.nameOf(result.uri!)).toBe("Documents");

    const handle = await registry.acquire(result.uri!, "panel:p1");
    expect(await handle.api.exists("/a.txt")).toBe(true);
  });

  it("passes the caller's intent to the picker", async () => {
    wire();
    await commands.call(storagesOpen, { mode: "readwrite", suggestedName: "Backups" }).promise;
    expect(requests).toEqual([{ mode: "readwrite", suggestedName: "Backups" }]);
  });

  it("treats a dismissed dialog as a normal outcome, registering nothing", async () => {
    wire(async () => undefined);
    const result = await commands.call(storagesOpen, { mode: "read" }).promise;
    expect(result).toEqual({ cancelled: true });
    expect(registry.isAdopted("picked://1/Documents")).toBe(false);
  });

  it("declares read-only capabilities when read access was asked for", async () => {
    wire();
    const { uri } = await commands.call(storagesOpen, { mode: "read" }).promise;
    const caps = registry.caps(uri!);
    expect(caps.read).toBe(true);
    expect(caps.write).toBe(false);
    expect(caps.remove).toBe(false);
  });

  it("grants write capabilities when readwrite was asked for", async () => {
    wire();
    const { uri } = await commands.call(storagesOpen, { mode: "readwrite" }).promise;
    expect(registry.caps(uri!).write).toBe(true);
  });

  it("lets a host replace the picker without touching app code", async () => {
    wire();
    commands.listen(
      storagesOpen,
      async () => ({ cancelled: false, uri: "host://mount", name: "Host mount" }),
      { priority: 0 },
    );
    const result = await commands.call(storagesOpen, { mode: "read" }).promise;
    expect(result.uri).toBe("host://mount");
    expect(requests).toHaveLength(0); // the app's picker never ran
  });

  describe("an opened storage behaves like any other", () => {
    it("backs a panel that lists it", async () => {
      wire();
      const { uri } = await commands.call(storagesOpen, { mode: "read" }).promise;
      const handle = await registry.acquire(uri!, "panel:p1");

      const model = new PanelModel("p1", "left", uri!, "/");
      const controller = new PanelController(model, handle.api, commands, () => {});
      await controller.refresh();

      expect(model.entries.map((e) => e.name).sort()).toEqual(["a.txt", "sub"]);
    });

    it("is a valid job endpoint", async () => {
      wire();
      const { uri } = await commands.call(storagesOpen, { mode: "read" }).promise;
      const target = new MemFilesApi();
      registry.adopt("mem://target", target, { name: "target" });

      const queue = new JobQueue(registry, { batchSize: 2 });
      const job = queue.enqueue({
        operation: "copy",
        sourceUri: uri!,
        targetUri: "mem://target",
        roots: ["/"],
        targetPath: "/dst",
      });
      await job.done;

      expect(job.status).toBe("done");
      expect(await target.exists("/dst/a.txt")).toBe(true);
    });
  });

  describe("an opened storage is runtime-only", () => {
    it("cannot be re-acquired once every holder has released it", async () => {
      wire();
      const { uri } = await commands.call(storagesOpen, { mode: "read" }).promise;
      await registry.acquire(uri!, "panel:p1");
      registry.release(uri!, "panel:p1");

      // A directory handle is not serialisable and its permission does not
      // survive being dropped, so re-acquiring must say so rather than
      // constructing an empty stand-in under a familiar name.
      await expect(registry.acquire(uri!, "panel:p2")).rejects.toThrow(/open it again/);
    });

    it("stays alive while any holder remains", async () => {
      wire();
      const { uri } = await commands.call(storagesOpen, { mode: "read" }).promise;
      await registry.acquire(uri!, "panel:p1");
      await registry.acquire(uri!, "job:j1");
      registry.release(uri!, "panel:p1");

      expect(registry.isLive(uri!)).toBe(true);
      const still = await registry.acquire(uri!, "panel:p2");
      expect(await still.api.exists("/a.txt")).toBe(true);
    });

    it("refuses to adopt the same URI twice", async () => {
      wire();
      const { uri } = await commands.call(storagesOpen, { mode: "read" }).promise;
      expect(() => registry.adopt(uri!, new MemFilesApi(), {})).toThrow(/already registered/);
    });
  });

  it("does not replace an existing opener: the first registered fallback wins", async () => {
    const first = new MemFilesApi({ initialFiles: { "/first.txt": "1" } });
    const second = new MemFilesApi({ initialFiles: { "/second.txt": "2" } });
    const off = registerStorageOpener(commands, registry, async () => ({
      api: first,
      name: "First",
    }));
    registerStorageOpener(commands, registry, async () => ({ api: second, name: "Second" }));

    // Both are fallbacks at the same priority and both decline once claimed,
    // so registration order decides. Replacing an opener means disposing the
    // previous one — or claiming at priority 0, as a host would.
    expect((await commands.call(storagesOpen, { mode: "read" }).promise).name).toBe("First");

    off();
    expect((await commands.call(storagesOpen, { mode: "read" }).promise).name).toBe("Second");
  });

  it("keeps the app free of any direct filesystem construction", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    for (const file of readdirSync(`${FM_SRC}fm-app/src`).filter((f) => f.endsWith(".ts"))) {
      const code = readFileSync(`${FM_SRC}fm-app/src/${file}`, "utf8").replace(
        /\/\*[\s\S]*?\*\/|\/\/.*/g,
        "",
      );
      // No `new SomethingFilesApi(...)` and no picker call anywhere in the app
      // layer: both arrive through `storages:open`.
      expect(code, file).not.toMatch(/new\s+\w*FilesApi\s*\(/);
      expect(code, file).not.toMatch(/showDirectoryPicker/);
    }
  });
});
