import { newBrowserSqliteDb } from "@statewalker/db-sqlite-browser";
import { memKvStore } from "@statewalker/webrun-storage";
import { describe, expect, it } from "vitest";
import { opfsRefFiles } from "../src/adapters/opfs.js";
import { filesRefDb } from "../src/files-ref-db.js";
import { kvRefDb } from "../src/kv-ref-db.js";
import { runRefContract } from "../src/ref-contract.js";
import { sqlRefDb } from "../src/sql-ref-db.js";

const CASES = 12;

describe("R8 the X5 contract in Chromium", () => {
  it("git files on OPFS (Web Lock exclusive create)", async () => {
    const root = await navigator.storage.getDirectory();
    let n = 0;
    const r = await runRefContract(async () => {
      const dir = await root.getDirectoryHandle(`x5-${Date.now()}-${n++}`, { create: true });
      return filesRefDb(opfsRefFiles(dir));
    });
    expect(r.cases).toBe(CASES);
    expect(r.failed).toEqual([]);
  }, 120_000);
  it("SQL on sqlite-wasm (in memory)", async () => {
    const db = await newBrowserSqliteDb();
    let n = 0;
    const r = await runRefContract(async () => sqlRefDb(db, `t${n++}_`));
    expect(r.cases).toBe(CASES);
    expect(r.failed).toEqual([]);
  });
  it("KV on memKvStore", async () => {
    const r = await runRefContract(async () => kvRefDb(memKvStore()));
    expect(r.cases).toBe(CASES);
    expect(r.failed).toEqual([]);
  });
});
