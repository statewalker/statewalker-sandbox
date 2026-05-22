import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { buildFilesViews } from "../../src/lib/build-files-views.js";
import { FilesApiSecretStore } from "../../src/lib/files-api-secret-store.js";

describe("FilesApiSecretStore", () => {
  let rootFiles: MemFilesApi;
  let systemFiles: ReturnType<typeof buildFilesViews>["systemFiles"];

  beforeEach(() => {
    rootFiles = new MemFilesApi();
    systemFiles = buildFilesViews(rootFiles).systemFiles;
  });

  describe("Scenario: set then get within one instance", () => {
    it("get returns the value just set", async () => {
      const store = new FilesApiSecretStore({ systemFiles });
      await store.set("GEMINI_API_KEY", "AIza-test-1");
      expect(await store.get("GEMINI_API_KEY")).toBe("AIza-test-1");
    });
  });

  describe("Scenario: persisted value survives store re-instantiation", () => {
    it("a fresh store reading the same FilesApi sees the previously set value", async () => {
      const s1 = new FilesApiSecretStore({ systemFiles });
      await s1.set("GEMINI_API_KEY", "AIza-test-2");
      const s2 = new FilesApiSecretStore({ systemFiles });
      expect(await s2.get("GEMINI_API_KEY")).toBe("AIza-test-2");
    });
  });

  describe("Scenario: delete removes the key from list", () => {
    it("list includes only the remaining keys", async () => {
      const store = new FilesApiSecretStore({ systemFiles });
      await store.set("A", "x");
      await store.set("B", "y");
      await store.delete("A");
      const keys = await store.list();
      expect(keys).toContain("B");
      expect(keys).not.toContain("A");
    });
  });

  describe("Scenario: asEnv materialises a plain record", () => {
    it("returns a plain object of all stored keys", async () => {
      const store = new FilesApiSecretStore({ systemFiles });
      await store.set("GEMINI_API_KEY", "AIza-test-3");
      const env = await store.asEnv();
      expect(env).toEqual({ GEMINI_API_KEY: "AIza-test-3" });
    });

    it("applies a prefix when one is provided", async () => {
      const store = new FilesApiSecretStore({ systemFiles });
      await store.set("KEY", "v");
      const env = await store.asEnv("APP_");
      expect(env).toEqual({ APP_KEY: "v" });
    });
  });

  describe("Corruption tolerance", () => {
    it("treats malformed JSON on disk as empty store", async () => {
      await writeText(systemFiles, "/.settings/secrets.json", "{not valid json");
      const store = new FilesApiSecretStore({ systemFiles });
      expect(await store.get("KEY")).toBeUndefined();
      expect(await store.list()).toEqual([]);
    });

    it("recovers from corruption: next set overwrites the malformed file", async () => {
      await writeText(systemFiles, "/.settings/secrets.json", "<<garbage>>");
      const store = new FilesApiSecretStore({ systemFiles });
      await store.set("RECOVERED", "ok");
      expect(await store.get("RECOVERED")).toBe("ok");
    });
  });

  describe("Concurrent writes", () => {
    it("serialised set calls compose into deterministic final state", async () => {
      const store = new FilesApiSecretStore({ systemFiles });
      // Without serialisation, both sets read the same empty cache, mutate
      // their own copies, and the slower writer would clobber the other.
      await Promise.all([store.set("A", "1"), store.set("B", "2")]);
      const keys = await store.list();
      expect(keys.sort()).toEqual(["A", "B"]);
      expect(await store.get("A")).toBe("1");
      expect(await store.get("B")).toBe("2");
    });
  });

  describe("Storage location", () => {
    it("writes to /.settings/secrets.json by default", async () => {
      const store = new FilesApiSecretStore({ systemFiles });
      await store.set("X", "y");
      expect(await systemFiles.exists("/.settings/secrets.json")).toBe(true);
    });

    it("honours a custom path", async () => {
      const store = new FilesApiSecretStore({ systemFiles, path: "/.settings/keys.json" });
      await store.set("X", "y");
      expect(await systemFiles.exists("/.settings/keys.json")).toBe(true);
    });
  });
});
