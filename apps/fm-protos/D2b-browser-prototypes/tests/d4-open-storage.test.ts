import { registerStorageOpener } from "@fm/app";
import { StorageRegistry, storagesOpen } from "@fm/core";
import { Commands } from "@statewalker/shared-commands";
import { getOPFSFilesApi } from "@statewalker/webrun-files-browser";
import { describe, expect, it } from "vitest";

/**
 * D4 (browser) — the same command, answered by a real browser filesystem.
 *
 * The production handler is `showDirectoryPicker()`, which needs a user gesture
 * and a native chooser Playwright cannot drive. What IS testable here is the
 * other half: that a genuine browser `FilesApi` — OPFS — flows through
 * `storages:open` and comes out usable, with no code path of its own.
 */
describe("D4 · opening a real browser filesystem by command", () => {
  it("adopts an OPFS filesystem returned by the handler", async () => {
    const commands = new Commands();
    const registry = new StorageRegistry(
      [],
      {},
      {
        async get() {
          return undefined;
        },
      },
    );

    registerStorageOpener(commands, registry, async () => ({
      api: await getOPFSFilesApi(),
      name: "Origin private",
    }));

    const result = await commands.call(storagesOpen, { mode: "readwrite" }).promise;
    expect(result.cancelled).toBe(false);
    expect(registry.isAdopted(result.uri!)).toBe(true);

    const handle = await registry.acquire(result.uri!, "panel:p1");
    const dir = `/opened-${Math.random().toString(36).slice(2)}`;
    await handle.api.write(`${dir}/hello.txt`, [new TextEncoder().encode("hi")]);
    expect(await handle.api.exists(`${dir}/hello.txt`)).toBe(true);
  });

  it("reports a dismissed picker as cancelled, exactly as in Node", async () => {
    const commands = new Commands();
    const registry = new StorageRegistry(
      [],
      {},
      {
        async get() {
          return undefined;
        },
      },
    );
    // What `showDirectoryPicker()` does when the user presses Escape: it
    // rejects with AbortError, which the handler reports as a dismissal.
    registerStorageOpener(commands, registry, async () => {
      try {
        throw Object.assign(new Error("The user aborted a request."), { name: "AbortError" });
      } catch (err) {
        if ((err as Error).name === "AbortError") return undefined;
        throw err;
      }
    });

    expect(await commands.call(storagesOpen, { mode: "read" }).promise).toEqual({
      cancelled: true,
    });
  });
});
