/**
 * C0.5 — the Node filesystem storage adapter, wired to the P2 registry the same
 * way `opfs.ts` is.
 *
 * WHY A SECOND REAL ADAPTER IS NODE AND NOT A SECOND BROWSER ROOT. Of the five
 * re-checks C0.5 asks for, one — PERMISSION DENIAL MID-JOB — cannot be produced
 * in OPFS at all: the Origin Private File System has no per-directory
 * permission model, and its root grant is not narrowable from script. A real
 * directory on a real filesystem has `chmod`, so `fs.writeFile` raises a real
 * `EACCES` in the middle of a real job. That is the reason this adapter is here,
 * and it is a property of the question rather than a convenience.
 *
 * It is also the only one of the three that can show the OTHER half of the
 * partial-write pair: `NodeFilesApi.write()` drains the whole source iterable
 * into one buffer before calling `fs.writeFile`, so a source that throws leaves
 * NO target at all — where `BrowserFilesApi` leaves a short one. §5.3's
 * symmetric-pair rule applied to adapters: both sides of that pair are
 * exercised, on a real filesystem each time.
 */

import { access, constants, mkdir, rm } from "node:fs/promises";
import type { FilesApi } from "@statewalker/webrun-files";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import type { AdapterFactory } from "../../fm-core/src/storage-registry.js";
import { createLease } from "./handle-lease.js";

/** One lease table per process, mirroring `opfsLease`. §6.6 applies to both. */
export const nodeRootLease = createLease<string>();

/**
 * Resolves one storage's root directory, verifying it is readable AND writable.
 *
 * `access(R_OK | W_OK)` is what makes a `chmod`-ed directory fail HERE, at
 * `acquire()`, rather than at the first write deep inside a job — which is the
 * difference between "storage unavailable, reported" and "job failed for
 * reasons". Both happen in this unit, deliberately, and they are different
 * tests.
 */
export function nodeRootProvider(dir: string): () => Promise<string> {
  return () =>
    nodeRootLease.acquire(`node:${dir}`, async () => {
      try {
        await access(dir, constants.R_OK | constants.W_OK);
      } catch (err) {
        throw new Error(`node root ${dir} unavailable: ${(err as { code?: string }).code ?? err}`);
      }
      return dir;
    });
}

export const nodeFilesFactory: AdapterFactory = (uri, options) => {
  const rootDir = options.rootDir as string | undefined;
  if (!rootDir) throw new Error(`${uri}: no rootDir in options`);
  return new NodeFilesApi({ rootDir }) as FilesApi;
};

/** Test setup: an empty directory, whatever was there before. */
export async function resetNodeDirectory(dir: string): Promise<string> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}
