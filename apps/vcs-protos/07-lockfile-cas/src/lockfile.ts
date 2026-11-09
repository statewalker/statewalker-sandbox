/**
 * X2 — git's lock-file protocol for a loose-ref compare-and-set, over FilesApi plus two primitives.
 *
 * Same steps as git (refs/files-backend.c) and JGit (LockFile, RefDirectoryUpdate):
 *   1. create `<ref>.lock` exclusively, already holding the new value `<oid>\n` — an existing lock
 *      means another writer (or a crashed one) holds the ref: report `locked`, never steal it;
 *   2. under the lock, read the current value and compare it with the expected one;
 *   3. commit: rename the lock over the ref (or, for a delete, remove the ref, then the lock);
 *      on mismatch or any error, remove the lock (JGit's unlock()).
 * A process that dies between 1 and 3 leaves the lock behind; like git, later writers see `locked`
 * until someone removes it explicitly (`breakLock`).
 */

/** The FilesApi subset the protocol needs, plus the two primitives this prototype proposes. */
export interface AtomicFiles {
  read(path: string): AsyncIterable<Uint8Array>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<boolean>;
  /** Create `path` with `content` only if nothing exists there; `false` (unchanged) otherwise. */
  createExclusive(path: string, content: Uint8Array): Promise<boolean>;
  /** Atomically make `target` hold `source`'s content and remove `source` (rename-over). */
  replace(source: string, target: string): Promise<void>;
}

export type CasResult = "ok" | "mismatch" | "locked";

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function readRef(files: AtomicFiles, ref: string): Promise<string | undefined> {
  if (!(await files.exists(ref))) return undefined;
  let text = "";
  for await (const chunk of files.read(ref)) text += dec.decode(chunk, { stream: true });
  text += dec.decode();
  const value = text.trim();
  return value === "" ? undefined : value;
}

export async function casRef(
  files: AtomicFiles,
  ref: string,
  expected: string | undefined,
  next: string | undefined,
): Promise<CasResult> {
  const lock = `${ref}.lock`;
  const content = next === undefined ? new Uint8Array(0) : enc.encode(`${next}\n`);
  if (!(await files.createExclusive(lock, content))) return "locked";
  let committed = false;
  try {
    const current = await readRef(files, ref);
    if (current !== expected) return "mismatch";
    if (next === undefined) {
      await files.remove(ref);
      await files.remove(lock);
    } else {
      await files.replace(lock, ref);
    }
    committed = true;
    return "ok";
  } finally {
    if (!committed) {
      try {
        await files.remove(lock);
      } catch {
        // The lock stays; later writers see `locked`, as with git.
      }
    }
  }
}

/** Explicitly remove a stale lock (git requires the same manual step). */
export async function breakLock(files: AtomicFiles, ref: string): Promise<boolean> {
  return files.remove(`${ref}.lock`);
}
