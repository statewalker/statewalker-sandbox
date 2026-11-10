import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { describe, expect, it } from "vitest";
import idxUrl from "../../12-index-pack/fixtures/sample.idx?url";
import packUrl from "../../12-index-pack/fixtures/sample.pack?url";
import { openPack } from "../src/pack-reader.js";

describe("R5 reading a pack in Chromium on OPFS", () => {
  it("every object of the fixture pack reads with verify", async () => {
    const pack = new Uint8Array(await (await fetch(packUrl)).arrayBuffer());
    const idx = new Uint8Array(await (await fetch(idxUrl)).arrayBuffer());
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(`x6r-${Date.now()}`, { create: true });
    const files = new BrowserFilesApi({ rootHandle: dir });
    await files.write("/p.pack", [pack]);
    await files.write("/p.idx", [idx]);
    const reader = await openPack(files, "/p.pack", "/p.idx");
    let verified = 0;
    for (const oid of reader.ids()) {
      const o = await reader.get(oid, { verify: true });
      for await (const _ of o?.content ?? []);
      verified++;
    }
    expect(verified).toBe(reader.count);
    expect(reader.count).toBeGreaterThan(200);
  });
});
