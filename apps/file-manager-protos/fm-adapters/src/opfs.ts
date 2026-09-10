/**
 * C0.5 — the OPFS storage adapter, wired to the P2 registry through the seam
 * P2 already has.
 *
 * THE BROWSER GLOBALS LIVE HERE AND NOWHERE ELSE. `fm-core` may touch no DOM
 * global (§6.1, and `test/boundaries.test.ts` greps for it), yet this unit's
 * whole subject is two browser filesystems. The resolution is the seam P2 built
 * and nothing else: `AdapterFactory` is `(uri, options) => FilesApi`, so every
 * storage the core ever sees is a `FilesApi`, and which API produced it is the
 * registry's configuration rather than the core's knowledge. So this file is a
 * FOURTH source root — `fm-adapters` — outside both `fm-core` and `fm-app`, and
 * the grep is extended to cover it rather than loosened to permit it. See
 * `test/boundaries-adapters.test.ts`.
 *
 * ROOT RESOLUTION GOES THROUGH THE SECRET STORE, which is not a pun.
 * `AdapterFactory` is synchronous; `navigator.storage.getDirectory()` is not.
 * The registry's one async step before construction is `_resolveOptions`,
 * which resolves `{ $secret }` references — and what a `FileSystemDirectoryHandle`
 * carries that a path does not is exactly a PERMISSION GRANT. Resolving it
 * there means a revoked handle fails at `acquire()`, is recorded as
 * `status: "failed"` with a reason, and does not take the other storages down —
 * which is P2's behaviour, unchanged, now reached by a real revocation instead
 * of a fake factory that throws.
 */

import type { FilesApi } from "@statewalker/webrun-files";
import { BrowserFilesApi, isHandlerAccessible } from "@statewalker/webrun-files-browser";
import type { AdapterFactory } from "../../fm-core/src/storage-registry.js";
import { createLease } from "./handle-lease.js";

/** One lease table per process. `pinned` is what a §6.6 test reads. */
export const opfsLease = createLease<FileSystemDirectoryHandle>();

/** True when this runtime has an Origin Private File System at all. */
export function hasOpfs(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  if (!hasOpfs()) throw new Error("no Origin Private File System in this runtime");
  return navigator.storage.getDirectory();
}

/**
 * Resolves one storage's own directory inside OPFS, verifying it is reachable.
 *
 * `create: false` is the load-bearing default. A provider that created the
 * directory on demand could never report a revoked root — it would silently
 * make a new empty one, and "re-acquisition failed" would read as "the storage
 * is suddenly empty", which is the worse of the two failures by a wide margin.
 */
export function opfsDirectoryProvider(
  name: string,
  options: { create?: boolean } = {},
): () => Promise<FileSystemDirectoryHandle> {
  return () =>
    opfsLease.acquire(`opfs:${name}`, async () => {
      const root = await opfsRoot();
      let handle: FileSystemDirectoryHandle;
      try {
        handle = await root.getDirectoryHandle(name, { create: options.create ?? false });
      } catch (err) {
        throw new Error(`OPFS root ${name} unavailable: ${(err as Error).name}`);
      }
      // The handle resolved; it may still be stale. `isHandlerAccessible` does a
      // real read, which is the only thing that tells the two apart.
      if (!(await isHandlerAccessible(handle))) {
        throw new Error(`OPFS root ${name} is no longer accessible`);
      }
      return handle;
    });
}

/**
 * The `AdapterFactory` for every `BrowserFilesApi` storage, OPFS or picked
 * directory alike — the class does not know which root it was handed, and that
 * is the point of it taking a handle rather than opening one.
 */
export const browserFilesFactory: AdapterFactory = (uri, options) => {
  const rootHandle = options.rootHandle as FileSystemDirectoryHandle | undefined;
  if (!rootHandle) throw new Error(`${uri}: no rootHandle in options`);
  return new BrowserFilesApi({ rootHandle }) as FilesApi;
};

/** Creates (or clears and recreates) a storage directory. Test setup, not production. */
export async function resetOpfsDirectory(name: string): Promise<FileSystemDirectoryHandle> {
  const root = await opfsRoot();
  await root.removeEntry(name, { recursive: true }).catch(() => undefined);
  return root.getDirectoryHandle(name, { create: true });
}

/**
 * Removes a storage directory outright, which is how a live handle to it is
 * REVOKED for real: every later call on that handle raises `NotFoundError`.
 */
export async function removeOpfsDirectory(name: string): Promise<void> {
  const root = await opfsRoot();
  await root.removeEntry(name, { recursive: true }).catch(() => undefined);
}
