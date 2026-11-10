import { newBrowserSqliteDb } from "@statewalker/db-sqlite-browser";
import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { SqliteFilesApi } from "@statewalker/webrun-files-sqlite";
import { memBlobStore } from "@statewalker/webrun-storage";
import { describe, expect, it } from "vitest";
import json from "../fixtures/corpus.json";
import { decodeCorpus } from "../src/corpus.js";
import { runObjectContract } from "../src/object-contract.js";
import { filesStagingStore, withStaging } from "../src/staging.js";

const corpus = decodeCorpus(json);
const CASES = 13;

describe("R6 the X4 contract in Chromium", () => {
  it("memBlobStore with generic staging", async () => {
    const r = await runObjectContract(async () => withStaging(memBlobStore()), corpus);
    expect(r.cases).toBe(CASES);
    expect(r.failed).toEqual([]);
  });
  it("BrowserFilesApi on OPFS", async () => {
    const root = await navigator.storage.getDirectory();
    let n = 0;
    const r = await runObjectContract(async () => {
      const name = `x4-${Date.now()}-${n++}`;
      await root.removeEntry(name, { recursive: true }).catch(() => {});
      const dir = await root.getDirectoryHandle(name, { create: true });
      return filesStagingStore(new BrowserFilesApi({ rootHandle: dir }), "/objects");
    }, corpus);
    expect(r.cases).toBe(CASES);
    expect(r.failed).toEqual([]);
  });
  it("SqliteFilesApi on sqlite-wasm (in memory)", async () => {
    const db = await newBrowserSqliteDb();
    let n = 0;
    const r = await runObjectContract(async () => {
      const fs = new SqliteFilesApi(db, { tablePrefix: `t${n++}_`, compression: null });
      await fs.init();
      return filesStagingStore(fs, "/objects");
    }, corpus);
    expect(r.cases).toBe(CASES);
    expect(r.failed).toEqual([]);
  });
});
