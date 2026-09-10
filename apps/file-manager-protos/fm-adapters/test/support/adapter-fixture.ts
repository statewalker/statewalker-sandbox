/**
 * C0.5 — the contract every adapter fixture satisfies, so the ported core suite
 * is ONE file rather than one per adapter.
 *
 * This is the whole reason "the suites pass unchanged against two non-mem
 * adapters" can be a checkable claim rather than a promise: the suite body in
 * `core-suite.ts` is literally the same source for mem, OPFS and Node. A
 * transcription per adapter would let a weakened assertion hide in the one
 * nobody re-read.
 *
 * Pure: no `node:`, no DOM. Each platform's fixture supplies those.
 */

import type { FilesApi } from "@statewalker/webrun-files";
import type { AdapterCapabilities } from "../../src/capabilities.js";
import type { SecretProvider } from "../../src/secrets.js";

/** One storage: a real, empty root on the adapter under test. */
export interface StorageFixture {
  /** The `storageURI` — the registry's identity for this storage (P2). */
  readonly uri: string;
  /** A live `FilesApi` on it, for tests that do not go through the registry. */
  readonly api: FilesApi;
  /**
   * The registry's async route to this storage's root: what
   * `{ $secret }` resolves to. Throws, for real, once `revoke()` has run.
   */
  readonly rootSecret: SecretProvider;
  /** The `$secret` key this storage's config references. */
  readonly secretKey: string;
  /** The `options` a config carries for this storage. */
  readonly configOptions: Record<string, unknown>;
  /**
   * Makes the root genuinely unusable — an OPFS directory removed from under a
   * live handle, a real directory `chmod`-ed away. Not a flag the fixture reads
   * back: the next `rootSecret()` fails because the platform refuses.
   */
  revoke(): Promise<void>;
}

export interface AdapterFixture {
  readonly caps: AdapterCapabilities;
  /** A fresh, empty storage. `label` only has to be unique within one test. */
  storage(label: string): Promise<StorageFixture>;
  /**
   * Denies writes into an existing storage WITHOUT touching its root handle, so
   * a job already running keeps its `FilesApi` and fails at the next write.
   * Absent when the adapter has no permission model — `caps.canDenyWriteMidJob`
   * says which, and the suite asserts the absence rather than skipping.
   */
  denyWrites?(storage: StorageFixture): Promise<void>;
  /** Undoes `denyWrites`, so teardown can delete what it created. */
  allowWrites?(storage: StorageFixture): Promise<void>;
  /** Removes everything this fixture made. */
  cleanup(): Promise<void>;
}

/** Writes `n` small files under `root`, named so sort order is obvious. */
export async function seed(api: FilesApi, n: number, root = "/src"): Promise<void> {
  for (let i = 0; i < n; i++) {
    await api.write(`${root}/f${String(i).padStart(4, "0")}.txt`, [
      new TextEncoder().encode(`body-${i}`),
    ]);
  }
}

export async function writeText(api: FilesApi, path: string, text: string): Promise<void> {
  await api.write(path, [new TextEncoder().encode(text)]);
}

export async function readText(api: FilesApi, path: string): Promise<string> {
  let out = "";
  for await (const chunk of api.read(path)) out += new TextDecoder().decode(chunk);
  return out;
}

export async function listPaths(api: FilesApi, path: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const info of api.list(path, { recursive: true })) {
    if (info.kind === "file") paths.push(info.path);
  }
  return paths.sort();
}

/**
 * A delegating `FilesApi` that records what the engine asked for, over a REAL
 * adapter underneath.
 *
 * The adopted P3 suite's `SpyFilesApi` wraps a `MemFilesApi`; this wraps
 * whatever the fixture handed over, so every byte still goes through the real
 * filesystem and only the bookkeeping is local. `failOn` is kept because one
 * adopted case needs a write to fail at a NAMED path — the real-failure cases
 * are separate tests that do not use it, and the two are not interchangeable.
 */
export class SpyFiles implements FilesApi {
  readonly writes: string[] = [];
  readonly removed: string[] = [];
  nativeCopies = 0;
  nativeMoves = 0;
  failOn?: string;
  constructor(private readonly inner: FilesApi) {}
  read(p: string, o?: Parameters<FilesApi["read"]>[1]) {
    return this.inner.read(p, o);
  }
  async write(p: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of content as AsyncIterable<Uint8Array>) {
      if (this.failOn === p) throw new Error(`write failed: ${p}`);
      chunks.push(chunk);
    }
    this.writes.push(p);
    return this.inner.write(p, chunks);
  }
  mkdir(p: string) {
    return this.inner.mkdir(p);
  }
  list(p: string, o?: Parameters<FilesApi["list"]>[1]) {
    return this.inner.list(p, o);
  }
  stats(p: string) {
    return this.inner.stats(p);
  }
  exists(p: string) {
    return this.inner.exists(p);
  }
  async remove(p: string) {
    this.removed.push(p);
    return this.inner.remove(p);
  }
  async move(s: string, t: string) {
    this.nativeMoves++;
    return this.inner.move(s, t);
  }
  async copy(s: string, t: string) {
    this.nativeCopies++;
    return this.inner.copy(s, t);
  }
}

/** Counts bytes and calls, so P4's O(1)-per-batch claim is measured on real I/O. */
export class CountingFiles implements FilesApi {
  bytes = 0;
  writes = 0;
  constructor(private readonly inner: FilesApi) {}
  read(p: string, o?: Parameters<FilesApi["read"]>[1]) {
    return this.inner.read(p, o);
  }
  async write(p: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of content as AsyncIterable<Uint8Array>) chunks.push(chunk);
    this.writes++;
    this.bytes += chunks.reduce((n, c) => n + c.length, 0);
    return this.inner.write(p, chunks);
  }
  mkdir(p: string) {
    return this.inner.mkdir(p);
  }
  list(p: string, o?: Parameters<FilesApi["list"]>[1]) {
    return this.inner.list(p, o);
  }
  stats(p: string) {
    return this.inner.stats(p);
  }
  exists(p: string) {
    return this.inner.exists(p);
  }
  remove(p: string) {
    return this.inner.remove(p);
  }
  move(s: string, t: string) {
    return this.inner.move(s, t);
  }
  copy(s: string, t: string) {
    return this.inner.copy(s, t);
  }
}
