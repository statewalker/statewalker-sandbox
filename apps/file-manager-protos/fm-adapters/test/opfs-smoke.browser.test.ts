/**
 * C0.5 · leg 0 — the harness itself, asserted before anything is built on it.
 *
 * A browser-mode suite that silently fell back to a polyfill, or ran in an
 * insecure context where `navigator.storage` is absent, would make every test
 * after it meaningless while still reporting green. So the first thing asserted
 * is that this really is the Origin Private File System in a real Chromium, and
 * that the three capabilities the later tests depend on are present: a writable
 * stream that commits on close, a permission query, and native `move()`.
 */
import { describe, expect, it } from "vitest";
import { hasOpfs } from "../src/opfs.js";

describe("C0.5 · the OPFS harness is real", () => {
  it("runs in a secure context with an Origin Private File System", () => {
    expect(globalThis.isSecureContext).toBe(true);
    expect(hasOpfs()).toBe(true);
  });

  it("has the three File System Access capabilities the suites depend on", () => {
    expect(typeof FileSystemFileHandle.prototype.createWritable).toBe("function");
    expect(typeof FileSystemHandle.prototype.queryPermission).toBe("function");
    // Chrome 110+. `BrowserFilesApi.move()` takes the native path when present,
    // and the copy-then-delete fallback when not; which one ran is a real
    // difference and P3 asserts move() was used at all.
    expect(typeof FileSystemFileHandle.prototype.move).toBe("function");
  });

  it("commits bytes written before close, which is what makes a partial write visible", async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("smoke", { create: true });
    const handle = await dir.getFileHandle("partial.bin", { create: true });
    const writable = await handle.createWritable();
    await writable.write(new Uint8Array(10));
    // Closed without ever writing the rest: exactly what `BrowserFilesApi.write`
    // does in its `finally` when the source iterable throws.
    await writable.close();
    expect((await handle.getFile()).size).toBe(10);
    await root.removeEntry("smoke", { recursive: true });
  });

  it("revokes a live handle when its directory is removed", async () => {
    const root = await navigator.storage.getDirectory();
    const doomed = await root.getDirectoryHandle("doomed", { create: true });
    await root.removeEntry("doomed", { recursive: true });
    const error = await doomed.getFileHandle("x", { create: true }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error).toBeDefined();
    expect(error?.name).toBe("NotFoundError");
  });
});
