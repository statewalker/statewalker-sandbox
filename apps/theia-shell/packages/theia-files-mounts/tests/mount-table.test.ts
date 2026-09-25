import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { MountTable } from "../src/common/mount-table";
import {
  type MountConfig,
  type MountType,
  NeedsUserGesture,
  SecretsLocked,
} from "../src/common/mount-types";

function fakeTypes() {
  const created: string[] = [];
  const failing = new Set<string>();
  const gesture = new Set<string>();
  const type: MountType = {
    id: "mem",
    label: "Memory",
    fields: [],
    isAvailable: () => true,
    create: async (mount, ctx) => {
      created.push(mount.key);
      if (failing.has(mount.key)) throw new Error("boom");
      if (gesture.has(mount.key) && !ctx.interactive) throw new NeedsUserGesture();
      if (mount.config.needsSecret && !(await ctx.secret("token"))) {
        throw ctx.locked ? new SecretsLocked() : new Error("missing token");
      }
      return new MemFilesApi();
    },
  };
  return { type, created, failing, gesture };
}

const mount = (key: string, config: Record<string, string> = {}): MountConfig => ({
  key,
  name: key.toUpperCase(),
  type: "mem",
  config,
});

async function rootNames(table: MountTable): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of table.composite().list("/")) found.push(entry.name);
  return found.sort();
}

describe("MountTable", () => {
  it("lists every mount, fixed ones included, as a root folder", async () => {
    const { type } = fakeTypes();
    const table = new MountTable(
      () => type,
      async () => undefined,
    );
    const main = new MemFilesApi();
    await table.apply([mount("a"), mount("b")], {
      fixed: [{ config: { key: "browser", name: "Browser", type: "main", config: {} }, api: main }],
    });
    expect(await rootNames(table)).toEqual(["a", "b", "browser"]);
    await writeText(table.composite(), "/browser/x.md", "hi");
    expect(await readText(main, "/x.md")).toBe("hi");
  });

  it("mounts a failing type as a placeholder and keeps the others", async () => {
    const t = fakeTypes();
    t.failing.add("bad");
    const table = new MountTable(
      () => t.type,
      async () => undefined,
    );
    await table.apply([mount("bad"), mount("good")]);
    expect(table.status("bad")).toEqual({ state: "failed", message: "boom" });
    expect(table.status("good")).toEqual({ state: "mounted" });
    expect(await rootNames(table)).toEqual(["bad", "good"]);
    await expect(writeText(table.composite(), "/bad/x", "")).rejects.toThrow();
  });

  it("reports needs-access and locked, and recreates them on request", async () => {
    const t = fakeTypes();
    t.gesture.add("folder");
    let token: string | undefined;
    let locked = true;
    const table = new MountTable(
      () => t.type,
      async () => token,
      () => locked,
    );
    const configs = [mount("folder"), mount("cloud", { needsSecret: "yes" })];
    await table.apply(configs);
    expect(table.status("folder")).toEqual({ state: "needs-access" });
    expect(table.status("cloud")).toEqual({ state: "locked" });
    token = "t";
    locked = false;
    await table.apply(configs, { recreate: (_key, status) => status.state === "locked" });
    expect(table.status("cloud")).toEqual({ state: "mounted" });
    expect(table.status("folder")).toEqual({ state: "needs-access" });
    await table.apply(configs, { interactive: true, recreate: (key) => key === "folder" });
    expect(table.status("folder")).toEqual({ state: "mounted" });
  });

  it("calls a missing secret 'failed', not 'locked', while the vault is unlocked", async () => {
    const t = fakeTypes();
    const table = new MountTable(
      () => t.type,
      async () => undefined,
      () => false,
    );
    await table.apply([mount("cloud", { needsSecret: "yes" })]);
    expect(table.status("cloud")).toEqual({ state: "failed", message: "missing token" });
  });

  it("re-creates only what changed and reports it", async () => {
    const t = fakeTypes();
    const table = new MountTable(
      () => t.type,
      async () => undefined,
    );
    expect(await table.apply([mount("a"), mount("b")])).toEqual(
      expect.arrayContaining([
        { type: "added", path: "/a" },
        { type: "added", path: "/b" },
      ]),
    );
    t.created.length = 0;
    const changes = await table.apply([mount("a"), mount("b", { flavour: "new" })]);
    expect(t.created).toEqual(["b"]);
    expect(changes).toEqual([{ type: "updated", path: "/b" }]);
  });

  it("treats a key change with the same type and config as a rename: same files", async () => {
    const t = fakeTypes();
    const table = new MountTable(
      () => t.type,
      async () => undefined,
    );
    await table.apply([mount("old")]);
    await writeText(table.composite(), "/old/keep.md", "kept");
    t.created.length = 0;
    const changes = await table.apply([{ ...mount("new"), name: "Renamed" }]);
    expect(t.created).toEqual([]);
    expect(await readText(table.composite(), "/new/keep.md")).toBe("kept");
    expect(changes).toEqual(
      expect.arrayContaining([
        { type: "deleted", path: "/old" },
        { type: "added", path: "/new" },
      ]),
    );
    expect(table.configs().map((c) => c.name)).toEqual(["Renamed"]);
  });

  it("unmounts what is no longer configured", async () => {
    const t = fakeTypes();
    const table = new MountTable(
      () => t.type,
      async () => undefined,
    );
    await table.apply([mount("a"), mount("b")]);
    expect(await table.apply([mount("a")])).toEqual([{ type: "deleted", path: "/b" }]);
    expect(await rootNames(table)).toEqual(["a"]);
    expect(table.status("b")).toBeUndefined();
  });

  it("gives up on a mount that never answers, as failed, and mounts the rest", async () => {
    const hanging: MountType = {
      id: "hang",
      label: "Hangs",
      fields: [],
      isAvailable: () => true,
      create: () => new Promise(() => {}),
    };
    const { type } = fakeTypes();
    const table = new MountTable(
      (id) => (id === "hang" ? hanging : type),
      async () => undefined,
      () => false,
      {
        createTimeout: 50,
      },
    );
    await table.apply([{ ...mount("slow"), type: "hang" }, mount("ok")]);
    expect(table.status("slow")).toEqual({ state: "failed", message: "No answer after 0.05 s" });
    expect(table.status("ok")).toEqual({ state: "mounted" });
  });

  it("fails an unknown type without throwing", async () => {
    const table = new MountTable(
      () => undefined,
      async () => undefined,
    );
    await table.apply([mount("x")]);
    expect(table.status("x")).toEqual({ state: "failed", message: 'Unknown mount type "mem"' });
  });
});
