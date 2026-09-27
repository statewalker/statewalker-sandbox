import { type SecretStore, type StorageConfig, StorageRegistry } from "@fm/core";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";

/** P2 — storageURI identity, shared refcounted instances, secrets by reference. */

let constructions: Record<string, number> = {};
let auths: Record<string, number> = {};

function config(): StorageConfig[] {
  constructions = {};
  auths = {};
  return [
    { uri: "mem://left", adapter: "mem", options: {}, caps: { stat: { size: true, mtime: true } } },
    { uri: "mem://right", adapter: "mem", options: {} },
    {
      uri: "s3://bucket",
      adapter: "fake-remote",
      options: { token: { $secret: "s3.token" } },
      caps: { stat: { size: true, mtime: false } },
    },
    {
      uri: "zip://out",
      adapter: "sink",
      options: {},
      caps: { read: false, list: false, write: true },
    },
  ];
}

const secrets: SecretStore = {
  async get(key) {
    return key === "s3.token" ? "tok-123" : undefined;
  },
};

const factories = {
  mem: (uri: string) => {
    constructions[uri] = (constructions[uri] ?? 0) + 1;
    return new MemFilesApi({ initialFiles: { "/a.txt": "a" } });
  },
  "fake-remote": (uri: string, options: Record<string, unknown>) => {
    constructions[uri] = (constructions[uri] ?? 0) + 1;
    if (!options.token) throw new Error("no credential");
    auths[uri] = (auths[uri] ?? 0) + 1;
    return new MemFilesApi();
  },
  sink: (uri: string) => {
    constructions[uri] = (constructions[uri] ?? 0) + 1;
    return new MemFilesApi();
  },
};

const make = (cfg = config()) => new StorageRegistry(cfg, factories, secrets);

describe("P2 · storage registry", () => {
  it("constructs at most one instance per storageURI", async () => {
    const reg = make();
    const a = await reg.acquire("mem://left", "panel:p1");
    const b = await reg.acquire("mem://left", "panel:p2");
    const c = await reg.acquire("mem://left", "job:j1");
    expect(a.api).toBe(b.api);
    expect(b.api).toBe(c.api);
    expect(constructions["mem://left"]).toBe(1);
  });

  it("authenticates a remote backend once no matter how many panels use it", async () => {
    const reg = make();
    for (const holder of ["p1", "p2", "p3", "p4"])
      await reg.acquire("s3://bucket", `panel:${holder}`);
    expect(auths["s3://bucket"]).toBe(1);
  });

  it("disposes only when the last holder releases", async () => {
    const reg = make();
    await reg.acquire("mem://left", "panel:p1");
    await reg.acquire("mem://left", "panel:p2");
    await reg.acquire("mem://left", "job:j1");

    reg.release("mem://left", "panel:p1");
    reg.release("mem://left", "panel:p2");
    expect(reg.isLive("mem://left")).toBe(true); // the job still holds it

    reg.release("mem://left", "job:j1");
    expect(reg.isLive("mem://left")).toBe(false);
  });

  it("re-acquiring after full release constructs a fresh instance", async () => {
    const reg = make();
    await reg.acquire("mem://left", "panel:p1");
    reg.release("mem://left", "panel:p1");
    await reg.acquire("mem://left", "panel:p2");
    expect(constructions["mem://left"]).toBe(2);
  });

  it("release by an unknown holder is a no-op, not a decrement", async () => {
    const reg = make();
    await reg.acquire("mem://left", "panel:p1");
    reg.release("mem://left", "panel:nobody");
    reg.release("mem://left", "panel:nobody");
    expect(reg.isLive("mem://left")).toBe(true);
  });

  describe("secrets", () => {
    it("resolves credential references by key and keeps them out of the config", async () => {
      const cfg = config();
      const reg = make(cfg);
      await reg.acquire("s3://bucket", "panel:p1");
      expect(auths["s3://bucket"]).toBe(1);
      // The config object is unchanged: no secret value was written back into it.
      expect(JSON.stringify(cfg)).not.toContain("tok-123");
      expect(JSON.stringify(cfg)).toContain("s3.token");
    });

    it("registers a storage whose credential is missing in a failed state", async () => {
      const reg = new StorageRegistry(config(), factories, {
        async get() {
          return undefined;
        },
      });
      const result = await reg.acquire("s3://bucket", "panel:p1").then(
        () => null,
        (e) => e,
      );
      expect(result).toBeInstanceOf(Error);
      expect(reg.status("s3://bucket")).toBe("failed");
      expect(reg.failure("s3://bucket")).toMatch(/credential/i);
    });

    it("a failed storage does not take the others down", async () => {
      const reg = new StorageRegistry(config(), factories, {
        async get() {
          return undefined;
        },
      });
      await reg.acquire("s3://bucket", "panel:p1").catch(() => undefined);
      const left = await reg.acquire("mem://left", "panel:p2");
      expect(left.api).toBeDefined();
      expect(reg.status("mem://left")).toBe("ready");
    });
  });

  describe("capabilities are declared, not probed", () => {
    it("defaults to full capability and never calls the adapter to find out", () => {
      const reg = make();
      expect(reg.caps("mem://right")).toEqual({
        read: true,
        write: true,
        list: true,
        move: true,
        copy: true,
        remove: true,
        stat: { size: true, mtime: true },
      });
      expect(constructions["mem://right"]).toBeUndefined(); // nothing was constructed
    });

    it("lets a pseudo-storage declare that most operations are unavailable", () => {
      const reg = make();
      const caps = reg.caps("zip://out");
      expect(caps.write).toBe(true);
      expect(caps.read).toBe(false);
      expect(caps.list).toBe(false);
    });

    it("degrades the UI per storage: no date sort when mtime is not reported", () => {
      const reg = make();
      expect(reg.sortColumns("mem://left")).toEqual(["name", "size", "date"]);
      expect(reg.sortColumns("s3://bucket")).toEqual(["name", "size"]);
      expect(reg.sortColumns("zip://out")).toEqual(["name", "size", "date"]);
    });
  });

  it("serialisation key for the job queue is the storageURI itself", async () => {
    const reg = make();
    const a = await reg.acquire("mem://left", "job:j1");
    const b = await reg.acquire("mem://left", "job:j2");
    expect(a.uri).toBe(b.uri);
  });
});
