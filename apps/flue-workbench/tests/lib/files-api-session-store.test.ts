import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { buildFilesViews } from "./build-files-views.js";
import { FilesApiSessionStore, type SessionDataLike } from "./files-api-session-store.js";

// The store only round-trips a JSON blob; we don't construct a real
// Flue `MessageEntry` here. Cast through unknown to keep the fixture
// schema-agnostic — what matters is that whatever we save comes back.
const sampleSessionData = (): SessionDataLike =>
  ({
    version: 3,
    entries: [
      {
        type: "message",
        id: "m1",
        parentId: null,
        message: { role: "user", content: "hello" },
      },
    ],
    leafId: "m1",
    metadata: {},
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:01.000Z",
  }) as unknown as SessionDataLike;

describe("FilesApiSessionStore", () => {
  let rootFiles: MemFilesApi;
  let systemFiles: ReturnType<typeof buildFilesViews>["systemFiles"];

  beforeEach(() => {
    rootFiles = new MemFilesApi();
    systemFiles = buildFilesViews(rootFiles).systemFiles;
  });

  it("save then load round-trips by id", async () => {
    const store = new FilesApiSessionStore({ files: systemFiles });
    const id = "workbench/repo-foo/main";
    const data = sampleSessionData();
    await store.save(id, data);
    const loaded = await store.load(id);
    expect(loaded).toEqual(data);
  });

  it("load returns null for unknown ids", async () => {
    const store = new FilesApiSessionStore({ files: systemFiles });
    expect(await store.load("workbench/never-saved/main")).toBeNull();
  });

  it("delete removes the persisted session", async () => {
    const store = new FilesApiSessionStore({ files: systemFiles });
    const id = "workbench/repo-foo/main";
    await store.save(id, sampleSessionData());
    await store.delete(id);
    expect(await store.load(id)).toBeNull();
  });

  it("session persists across store re-instantiation against the same FilesApi", async () => {
    const id = "workbench/repo-foo/main";
    const data = sampleSessionData();
    const s1 = new FilesApiSessionStore({ files: systemFiles });
    await s1.save(id, data);
    const s2 = new FilesApiSessionStore({ files: systemFiles });
    expect(await s2.load(id)).toEqual(data);
  });

  it("encodes the id so slashes in it don't collide with FilesApi path separators", async () => {
    // The session id `workbench/repo-foo/main` contains slashes. The store must encode it.
    const store = new FilesApiSessionStore({ files: systemFiles, root: "/.settings/sessions" });
    await store.save("workbench/repo-foo/main", sampleSessionData());
    const names: string[] = [];
    for await (const entry of systemFiles.list("/.settings/sessions")) names.push(entry.name);
    // Exactly one file at the configured root — slashes in the id did not create nested directories.
    expect(names).toHaveLength(1);
  });

  it("writes under /.settings/sessions by default", async () => {
    const store = new FilesApiSessionStore({ files: systemFiles });
    await store.save("workbench/x/main", sampleSessionData());
    expect(await systemFiles.exists("/.settings/sessions")).toBe(true);
  });
});
