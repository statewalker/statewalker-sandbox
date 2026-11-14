/** Dedicated Worker for R4: sqlite-wasm with an OPFS (sahpool) database. */
import { newBrowserSqliteDb } from "@statewalker/db-sqlite-browser";
import { runKvContract } from "../src/kv-contract.js";
import { sqlKvStore } from "../src/sql-kv-store.js";

self.onmessage = async (e: MessageEvent<{ op: "contract" | "race" | "open"; path: string }>) => {
  try {
    const db = await newBrowserSqliteDb({ path: e.data.path });
    if (e.data.op === "open") {
      self.postMessage({ opened: true });
      return; // keep it open: the test then tries a second worker
    }
    if (e.data.op === "contract") {
      self.postMessage({ result: await runKvContract(() => sqlKvStore(db)) });
      return;
    }
    const kv = await sqlKvStore(db);
    const enc = new TextEncoder();
    await kv.put("ref", enc.encode("v0"));
    const r = await Promise.all(
      Array.from({ length: 100 }, (_, i) => kv.cas("ref", enc.encode("v0"), enc.encode(`w${i}`))),
    );
    self.postMessage({ winners: r.filter(Boolean).length });
  } catch (err) {
    self.postMessage({ error: String(err) });
  }
};
