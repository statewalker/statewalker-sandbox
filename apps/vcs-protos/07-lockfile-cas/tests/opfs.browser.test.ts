import { describe, expect, it } from "vitest";
import { opfsAtomicFiles } from "../src/adapters/opfs.js";
import { casRef, readRef } from "../src/lockfile.js";

const oid = (n: number) => n.toString(16).padStart(40, "0");
const REF = "refs/heads/main";

async function freshDir(name: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(name, { recursive: true }).catch(() => {});
  return root.getDirectoryHandle(name, { create: true });
}

describe("R6 OPFS in Chromium", () => {
  it("R1 in one page: exactly one of 50 concurrent compare-and-sets wins", async () => {
    const files = opfsAtomicFiles(await freshDir("x2-page"));
    expect(await casRef(files, REF, undefined, oid(1))).toBe("ok");
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => casRef(files, REF, oid(1), oid(100 + i))),
    );
    const winners = results.flatMap((r, i) => (r === "ok" ? [i] : []));
    expect(winners.length).toBe(1);
    expect(await readRef(files, REF)).toBe(oid(100 + (winners[0] ?? -1)));
    expect(await files.exists(`${REF}.lock`)).toBe(false);
  });

  it("two Dedicated Workers racing on the same OPFS directory: exactly one wins", async () => {
    const dir = "x2-workers";
    const files = opfsAtomicFiles(await freshDir(dir));
    expect(await casRef(files, REF, undefined, oid(1))).toBe("ok");
    const startAt = Date.now() + 300;
    const race = (next: string) =>
      new Promise<string>((resolve, reject) => {
        const w = new Worker(new URL("./opfs.worker.ts", import.meta.url), { type: "module" });
        w.onmessage = (e) => {
          w.terminate();
          if (e.data.error) reject(new Error(e.data.error));
          else resolve(e.data.result);
        };
        w.postMessage({ dir, expected: oid(1), next, startAt });
      });
    const results = await Promise.all([
      race(oid(201)),
      race(oid(202)),
      race(oid(203)),
      race(oid(204)),
    ]);
    expect(results.filter((r) => r === "ok").length, results.join(",")).toBe(1);
    const winner = [201, 202, 203, 204][results.indexOf("ok")] ?? 0;
    expect(await readRef(files, REF)).toBe(oid(winner));
  });
});
