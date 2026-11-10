import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { describe, expect, it } from "vitest";
import idxUrl from "../fixtures/sample.idx?url";
import packUrl from "../fixtures/sample.pack?url";
import { installPack } from "../src/index-pack.js";

describe("R5 index-pack in Chromium on OPFS", () => {
  it("the fixture pack is indexed byte-identically to git's .idx", async () => {
    const pack = new Uint8Array(await (await fetch(packUrl)).arrayBuffer());
    const idx = new Uint8Array(await (await fetch(idxUrl)).arrayBuffer());
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(`x6-${Date.now()}`, { create: true });
    const files = new BrowserFilesApi({ rootHandle: dir });
    const r = await installPack(
      files,
      "/objects/pack",
      (async function* () {
        for (let i = 0; i < pack.length; i += 4096) yield pack.subarray(i, i + 4096);
      })(),
    );
    expect(r.idx.length).toBe(idx.length);
    expect(r.idx.every((b, i) => b === idx[i])).toBe(true);
    const names: string[] = [];
    for await (const e of files.list("/objects/pack")) names.push(e.name);
    expect(names.sort()).toEqual([`pack-${r.packId}.idx`, `pack-${r.packId}.pack`]);
  });
});
