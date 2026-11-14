import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { describe, expect, it } from "vitest";
import completedUrl from "../fixtures/completed.idx?url";
import thinUrl from "../fixtures/thin.pack?url";
import { fixtureBase } from "../src/fixture-base.js";
import { installPack } from "../src/index-pack.js";

describe("R7 thin pack completed in Chromium on OPFS", () => {
  it("the fixture thin pack completes to the committed .idx", async () => {
    const thin = new Uint8Array(await (await fetch(thinUrl)).arrayBuffer());
    const completed = new Uint8Array(await (await fetch(completedUrl)).arrayBuffer());
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(`x6b-${Date.now()}`, { create: true });
    const files = new BrowserFilesApi({ rootHandle: dir });
    const r = await installPack(
      files,
      "/objects/pack",
      (async function* () {
        for (let i = 0; i < thin.length; i += 4096) yield thin.subarray(i, i + 4096);
      })(),
      { externalBase: fixtureBase },
    );
    expect(r.stats.appended).toBeGreaterThan(0);
    expect(r.idx.length).toBe(completed.length);
    expect(r.idx.every((b, i) => b === completed[i])).toBe(true);
    const names: string[] = [];
    for await (const e of files.list("/objects/pack")) names.push(e.name);
    expect(names.sort()).toEqual([`pack-${r.packId}.idx`, `pack-${r.packId}.pack`]);
  });
});
