import { describe, expect, it } from "vitest";

function worker() {
  return new Worker(new URL("./sqlite.worker.ts", import.meta.url), { type: "module" });
}
function ask<T>(w: Worker, msg: unknown, timeoutMs = 30_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    w.onmessage = (e) => {
      clearTimeout(t);
      resolve(e.data as T);
    };
    w.onerror = (e) => {
      clearTimeout(t);
      reject(new Error(e.message));
    };
    w.postMessage(msg);
  });
}

describe("R4 sqlite-wasm with an OPFS database in a Chromium Dedicated Worker", () => {
  it("R1 contract", async () => {
    const w = worker();
    const r = await ask<{ result?: { cases: number; failed: string[] }; error?: string }>(w, {
      op: "contract",
      path: "/x3a-contract.sqlite",
    });
    w.terminate();
    expect(r.error).toBeUndefined();
    expect(r.result?.cases).toBe(9);
    expect(r.result?.failed).toEqual([]);
  }, 60_000);
  it("R2 100 concurrent cas: exactly one winner", async () => {
    const w = worker();
    const r = await ask<{ winners?: number; error?: string }>(w, {
      op: "race",
      path: "/x3a-race.sqlite",
    });
    w.terminate();
    expect(r.error).toBeUndefined();
    expect(r.winners).toBe(1);
  }, 60_000);
  it("trap: a second worker cannot open an OPFS (sahpool) database another worker holds", async () => {
    const a = worker();
    expect(await ask(a, { op: "open", path: "/x3a-shared.sqlite" })).toEqual({ opened: true });
    const b = worker();
    const second: { opened?: boolean; error?: string } = await ask<{
      opened?: boolean;
      error?: string;
    }>(b, { op: "open", path: "/x3a-shared.sqlite" }, 20_000).catch((e) => ({ error: String(e) }));
    console.log("second worker on the same sahpool database:", JSON.stringify(second));
    a.terminate();
    b.terminate();
    // OPFS sync access handles are exclusive per file: one worker owns a sahpool database, so other
    // tabs/workers must reach it through that owner (SharedWorker or leader election).
    expect(second.opened).toBeUndefined();
    expect(second.error).toMatch(/NoModificationAllowedError|Access Handles cannot be created/);
  }, 60_000);
});
