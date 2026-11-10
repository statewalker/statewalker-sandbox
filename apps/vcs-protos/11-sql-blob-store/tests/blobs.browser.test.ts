import { newBrowserSqliteDb } from "@statewalker/db-sqlite-browser";
import { describe, expect, it } from "vitest";
import json from "../../09-git-objects/fixtures/corpus.json";
import { decodeCorpus } from "../../09-git-objects/src/corpus.js";
import { runObjectContract } from "../../09-git-objects/src/object-contract.js";
import { runBlobContract } from "../src/blob-contract.js";
import { sqlBlobStore } from "../src/sql-blob-store.js";

describe("R1/R2 on sqlite-wasm in Chromium", () => {
  it("blob contract", async () => {
    const db = await newBrowserSqliteDb();
    let n = 0;
    const r = await runBlobContract(
      () => sqlBlobStore(db, { prefix: `t${n++}_`, chunkSize: 4096 }),
      4096,
    );
    expect(r.cases).toBe(22);
    expect(r.failed).toEqual([]);
  });
  it("X4 object contract", async () => {
    const db = await newBrowserSqliteDb();
    let n = 0;
    const r = await runObjectContract(
      () => sqlBlobStore(db, { prefix: `o${n++}_` }),
      decodeCorpus(json),
    );
    expect(r.cases).toBe(20);
    expect(r.failed).toEqual([]);
  });
});
