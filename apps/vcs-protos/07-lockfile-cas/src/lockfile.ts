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
  /** Make `target` hold `source`'s content in one atomic step, then remove `source` (rename-over;
   *  on OPFS the source removal may lag the target update). */
  replace(source: string, target: string): Promise<void>;
}

export type CasResult = "ok" | "mismatch" | "locked";

const enc = new TextEncoder();
const dec = new TextDecoder();

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

async function readText(files: AtomicFiles, path: string): Promise<string | undefined> {
  if (!(await files.exists(path))) return undefined;
  let text = "";
  for await (const chunk of files.read(path)) text += dec.decode(chunk, { stream: true });
  return text + dec.decode();
}

/** The value of `ref` in `packed-refs`, if listed (lines `<oid> <ref>`, `^<oid>` peel lines, `#` header). */
async function readPackedRef(files: AtomicFiles, ref: string): Promise<string | undefined> {
  const text = await readText(files, "packed-refs");
  if (text === undefined) return undefined;
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#") || line.startsWith("^")) continue;
    const sp = line.indexOf(" ");
    if (sp > 0 && line.slice(sp + 1) === ref) return line.slice(0, sp);
  }
  return undefined;
}

/**
 * Current value of a ref: the loose file if present, else its `packed-refs` entry (git's order:
 * a loose ref overrides a packed one). An empty or non-OID loose file is a broken ref and a
 * `ref: …` line a symbolic ref; both are errors, never read as "absent" or as a value.
 */
export async function readRef(files: AtomicFiles, ref: string): Promise<string | undefined> {
  const text = await readText(files, ref);
  if (text === undefined) return readPackedRef(files, ref);
  const value = text.trim();
  if (value.startsWith("ref:"))
    throw new Error(`${ref} is a symbolic ref; symrefs are handled in X5`);
  if (!OID.test(value)) throw new Error(`${ref} is broken: not an object id`);
  return value;
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
  // Once the rename (or the ref removal) has started, the lock path is no longer ours to remove:
  // another writer may already own it (JGit never unlocks after a commit). A throw from here on
  // means "outcome unknown"; re-read the ref to learn it.
  let ours = true;
  try {
    const current = await readRef(files, ref);
    if (current !== expected) return "mismatch";
    if (next === undefined) {
      if ((await readPackedRef(files, ref)) !== undefined) {
        // git also rewrites packed-refs under packed-refs.lock; until X5, refuse rather than
        // remove the loose ref and resurrect the packed value.
        throw new Error(`${ref} is in packed-refs; deleting packed refs is handled in X5`);
      }
      ours = false;
      await files.remove(ref);
      await files.remove(lock);
    } else {
      ours = false;
      await files.replace(lock, ref);
    }
    return "ok";
  } finally {
    if (ours) {
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
