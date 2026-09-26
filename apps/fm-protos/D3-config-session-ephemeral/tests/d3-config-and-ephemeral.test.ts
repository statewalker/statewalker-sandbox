import { CONFIG_VERSION, ConfigStore, degradedPanel, type SessionFile } from "@fm/app";
import { archiveSink, CheckpointStore, JobModel, readOnly, runCopyJob } from "@fm/core";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";

/** D3 — config, session, and the storages that exist for one job only. */

const read = async (api: MemFilesApi, path: string) => {
  let text = "";
  for await (const c of api.read(path)) text += new TextDecoder().decode(c);
  return text;
};

describe("D3 · two files, two write policies", () => {
  let disk: MemFilesApi;
  let config: ConfigStore;

  const session = (path: string): SessionFile => ({
    version: CONFIG_VERSION,
    panels: [{ id: "p1", storage: "mem://a", path, name: "src" }],
    activeId: "p1",
  });

  beforeEach(() => {
    disk = new MemFilesApi();
    config = new ConfigStore(disk, "/config", 20);
  });

  it("writes storages.json only when explicitly asked", async () => {
    await config.saveStorages([{ uri: "mem://a", adapter: "mem", options: {} }]);
    expect(config.storagesWrites).toBe(1);

    // Everything a session does — navigating, sorting, resizing — must not
    // touch a file the user maintains by hand.
    for (let i = 0; i < 50; i++) config.scheduleSession(session(`/p${i}`));
    await new Promise((r) => setTimeout(r, 60));

    expect(config.storagesWrites).toBe(1);
    expect(config.sessionWrites).toBe(1);
  });

  it("debounces the session: fifty changes cost one write", async () => {
    for (let i = 0; i < 50; i++) config.scheduleSession(session(`/p${i}`));
    await new Promise((r) => setTimeout(r, 60));

    expect(config.sessionWrites).toBe(1);
    const written = JSON.parse(await read(disk, "/config/session.json")) as SessionFile;
    expect(written.panels[0].path).toBe("/p49"); // the last state, not the first
  });

  it("does not write after dispose", async () => {
    // Without a single-timer guard every scheduled change leaves its own timer
    // behind, and `dispose()` can only cancel the last one — so a panel closed
    // mid-debounce writes a session for an app that is gone.
    for (let i = 0; i < 5; i++) config.scheduleSession(session(`/p${i}`));
    config.dispose();
    await new Promise((r) => setTimeout(r, 60));
    expect(config.sessionWrites).toBe(0);
  });

  it("round-trips both files", async () => {
    await config.saveStorages([{ uri: "mem://a", adapter: "mem", options: {}, batchSize: 4 }]);
    config.scheduleSession(session("/dir"));
    await config.flushSession();

    const storages = await config.loadStorages();
    expect(storages.version).toBe(CONFIG_VERSION);
    expect(storages.storages[0].batchSize).toBe(4);
    expect((await config.loadSession())!.panels[0].path).toBe("/dir");
  });

  it("returns an empty config rather than failing when nothing is saved yet", async () => {
    expect(await config.loadStorages()).toEqual({ version: CONFIG_VERSION, storages: [] });
    expect(await config.loadSession()).toBeUndefined();
  });

  describe("versioning", () => {
    it("REFUSES a storages.json from a newer build", async () => {
      await disk.write("/config/storages.json", [
        new TextEncoder().encode(JSON.stringify({ version: CONFIG_VERSION + 1, storages: [] })),
      ]);
      // Writing a v1 file over a v2 one destroys configuration the user may
      // have written by hand in a newer build. Refusing is the safe failure.
      await expect(config.loadStorages()).rejects.toThrow(/version/);
    });

    it("DISCARDS a session from another version, because a session is disposable", async () => {
      await disk.write("/config/session.json", [
        new TextEncoder().encode(JSON.stringify({ version: 99, panels: [] })),
      ]);
      expect(await config.loadSession()).toBeUndefined();
    });
  });

  it("keeps a panel whose storage is gone, named and marked", () => {
    const known = new Set(["mem://a"]);
    const alive = degradedPanel({ id: "p1", storage: "mem://a", path: "/", name: "src" }, known);
    expect(alive.error).toBeUndefined();

    const orphan = degradedPanel(
      { id: "p2", storage: "usb://photos", path: "/DCIM", name: "Photos" },
      known,
    );
    // The drive is unplugged; the user should see "Photos — unavailable", not
    // an app that failed to start.
    expect(orphan.name).toBe("Photos");
    expect(orphan.error).toMatch(/usb:\/\/photos/);
  });
});

describe("D3 · ephemeral storages", () => {
  it("makes a dropped source read-only, so ingest cannot write back to the OS", async () => {
    const dropped = readOnly(new MemFilesApi({ initialFiles: { "/drop/a.txt": "a" } }));
    expect(await dropped.exists("/drop/a.txt")).toBe(true);

    await expect(async () => dropped.write("/drop/b.txt", [] as never)).rejects.toThrow(
      /read-only/,
    );
    await expect(async () => dropped.remove("/drop/a.txt")).rejects.toThrow(/read-only/);
    await expect(async () => dropped.move("/drop/a.txt", "/x")).rejects.toThrow(/read-only/);
  });

  it("ingests a drop as an ordinary copy job, with progress and cancel", async () => {
    const dropped = readOnly(
      new MemFilesApi({ initialFiles: { "/drop/a.txt": "a", "/drop/b.txt": "b" } }),
    );
    const target = new MemFilesApi();
    const job = new JobModel("ingest");

    await runCopyJob({
      operation: "copy",
      source: { uri: "ephemeral://drop", api: dropped },
      target: { uri: "mem://b", api: target, path: "/dst" },
      roots: ["/drop"],
      batchSize: 1,
      job,
    });

    expect(job.status).toBe("done");
    expect(job.completed).toBe(2); // the same progress any copy reports
    expect(await target.exists("/dst/a.txt")).toBe(true);
  });

  describe("a write-only archive", () => {
    it("accepts writes and refuses everything else", async () => {
      const sink = archiveSink();
      await sink.write("/x.txt", [new TextEncoder().encode("hello")]);
      expect(sink.entries).toEqual([{ path: "/x.txt", bytes: 5 }]);
      await expect(async () => sink.list("/")).rejects.toThrow(/write-only/);
    });

    it("declares resumable:false, and the engine writes NO cursor for it", async () => {
      const source = new MemFilesApi({
        initialFiles: { "/src/a.txt": "a", "/src/b.txt": "b", "/src/c.txt": "c" },
      });
      // Counted, not inspected after the fact: a completed job clears its
      // cursor, so "no cursor at the end" is true whether or not one was ever
      // written. The question is whether the engine wrote at all.
      let checkpointWrites = 0;
      const store = new (class extends MemFilesApi {
        async write(path: string, content: never) {
          checkpointWrites++;
          return super.write(path, content);
        }
      })();
      const checkpoints = new CheckpointStore(store);
      const sink = archiveSink();
      const job = new JobModel("zip");

      await runCopyJob({
        operation: "copy",
        source: { uri: "mem://a", api: source },
        target: { uri: "archive://out", api: sink, path: "/archive" },
        roots: ["/src"],
        batchSize: 1,
        job,
        checkpoints,
        resumable: sink.resumable,
      });

      expect(job.status).toBe("done");
      expect(sink.entries).toHaveLength(3);
      // A cursor for a stream that cannot be re-opened is a promise that
      // cannot be kept, so none is written.
      expect(checkpointWrites).toBe(0);
      expect(await checkpoints.load("zip")).toBeUndefined();
      expect(await store.exists("/jobs/zip/cursor.json")).toBe(false);
    });

    it("still checkpoints when the target does not declare itself unresumable", async () => {
      const source = new MemFilesApi({ initialFiles: { "/src/a.txt": "a", "/src/b.txt": "b" } });
      const checkpoints = new CheckpointStore(new MemFilesApi());
      const job = new JobModel("normal");
      const run = runCopyJob({
        operation: "copy",
        source: { uri: "mem://a", api: source },
        target: { uri: "mem://b", api: new MemFilesApi(), path: "/dst" },
        roots: ["/src"],
        batchSize: 1,
        job,
        checkpoints,
      });
      await new Promise((r) => setTimeout(r, 0));
      job.cancel();
      await run;
      expect(await checkpoints.load("normal")).toBeDefined();
    });
  });
});
