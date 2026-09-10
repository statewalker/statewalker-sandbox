/**
 * C0.5 — what each real adapter can and cannot exhibit.
 *
 * This table is not documentation sitting next to the tests: the ported suites
 * READ it, and a suite asserts the difference rather than ignoring it. That is
 * the difference between a documented capability and a weakened assertion —
 * a capability is a fact a test checks, an excuse is a fact a test avoids.
 *
 * Nothing here is probed. `StorageRegistry.caps()` already established that
 * capability is declared (P2), and these are the same kind of claim one level
 * down: properties of the ADAPTER rather than of the storage it is pointed at.
 */

/** The adapters the ported core suites run against. `mem` is the control. */
export type AdapterId = "mem" | "opfs" | "node";

export interface AdapterCapabilities {
  readonly id: AdapterId;
  /** Human name, used in test titles so a failure names the adapter. */
  readonly label: string;

  /**
   * Does `write()` commit bytes as they arrive, or buffer the whole stream and
   * write once?
   *
   * This decides whether "a failed write leaves a partial target" is even
   * observable. `BrowserFilesApi` opens a `FileSystemWritableFileStream` and
   * closes it in a `finally`, so a source that throws mid-stream leaves a
   * SHORT FILE COMMITTED — and `runCopyJob`'s removal of it is a real
   * rollback. `NodeFilesApi` and `MemFilesApi` drain the whole iterable into
   * one buffer first, so a throw means `fs.writeFile` is never called and no
   * target is created at all — the rollback is a no-op over nothing.
   *
   * Both are correct. Only one of them can SHOW the rollback working, which is
   * why mem hid it for seven rungs.
   */
  readonly commitsPartialWrites: boolean;

  /**
   * Does the adapter honour `ReadOptions.signal`?
   *
   * NONE of the three do, as of `webrun-files@0.7.0` —
   * `MemFilesApi`, `NodeFilesApi` and `BrowserFilesApi` all accept
   * `ReadOptions` and all three ignore `signal`. `fm-core` therefore may not
   * rely on it, and does not: see `abortableSource` in
   * `fm-core/src/copy-job.ts`, which is the fix this capability row forced.
   */
  readonly honoursReadSignal: boolean;

  /**
   * Can a write be denied by the storage while a job is running, without the
   * test reaching into the adapter?
   *
   * Node: yes — `chmod` the target directory and `fs.writeFile` raises a real
   * `EACCES`. OPFS: no — the Origin Private File System has no per-directory
   * permission model at all, and its root grant cannot be narrowed from script.
   * Mem: no.
   */
  readonly canDenyWriteMidJob: boolean;

  /**
   * Can a handle or root become invalid between `enqueue()` and the job's
   * start, for real?
   *
   * OPFS: yes — remove the directory a live `FileSystemDirectoryHandle` points
   * at and every later call on it raises `NotFoundError`. Node: yes — remove
   * or `chmod` the root directory. Mem: no; a `MemFilesApi` is a Map and there
   * is nothing to revoke.
   */
  readonly canRevokeRootMidFlight: boolean;

  /**
   * Does `read()` deliver a file as MORE THAN ONE chunk?
   *
   * `MemFilesApi` yields the whole file in a single `yield`, at any size. There
   * is therefore no "mid-stream" in it at all, and an interruption can only land
   * before the first chunk or after the last — which is the second, quieter
   * reason seven rungs never observed a partial write. `NodeFilesApi` and
   * `BrowserFilesApi` both read in 8 KiB chunks.
   */
  readonly readsInChunks: boolean;

  /**
   * Does a transfer suspend on a macrotask, so that an abort can land INSIDE a
   * batch rather than only at a batch boundary?
   *
   * This is the whole of "real latency". `MemFilesApi` resolves every
   * operation on the microtask queue, so a batch started in a turn always
   * finishes in that turn and a cancellation can only ever be seen at the top
   * of the loop. Real I/O does not have that property, and two assertions in
   * the adopted P3 suite are true only because of it — see `ADAPTERS.md`.
   */
  readonly suspendsMidBatch: boolean;
}

const CAPABILITIES: Record<AdapterId, AdapterCapabilities> = {
  mem: {
    id: "mem",
    label: "MemFilesApi",
    commitsPartialWrites: false,
    honoursReadSignal: false,
    canDenyWriteMidJob: false,
    canRevokeRootMidFlight: false,
    readsInChunks: false,
    suspendsMidBatch: false,
  },
  opfs: {
    id: "opfs",
    label: "BrowserFilesApi over OPFS",
    commitsPartialWrites: true,
    honoursReadSignal: false,
    canDenyWriteMidJob: false,
    canRevokeRootMidFlight: true,
    readsInChunks: true,
    suspendsMidBatch: true,
  },
  node: {
    id: "node",
    label: "NodeFilesApi over a real directory",
    commitsPartialWrites: false,
    honoursReadSignal: false,
    canDenyWriteMidJob: true,
    canRevokeRootMidFlight: true,
    readsInChunks: true,
    suspendsMidBatch: true,
  },
};

export function capabilitiesOf(id: AdapterId): AdapterCapabilities {
  return CAPABILITIES[id];
}
