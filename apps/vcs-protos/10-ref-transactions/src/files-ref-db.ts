/**
 * X5 — git files backend over RefFiles: loose refs, `packed-refs`, `logs/`.
 *
 * Single-ref commands use the loose protocol (X2): lock `<ref>.lock` holding the new value, compare,
 * rename over the ref. Multi-ref batches follow JGit's PackedBatchRefUpdate so that readers see all
 * or nothing:
 *   1. lock every involved ref (sorted; a held lock is retried for refLockTimeoutMs, then `locked`),
 *   2. lock `packed-refs` and compare every expected old value (loose overrides packed),
 *   3. if any involved ref is loose, pack them first — write their current values into packed-refs
 *      and remove the loose files (readers see the same values) — and re-take packed-refs.lock,
 *   4. apply the batch to the packed entries and commit with ONE rename of packed-refs.lock,
 *   5. append reflogs, release the ref locks.
 * A crash before step 4's rename leaves every value old, after it every value new; stale locks
 * remain, as with git, until removed. Under the locks the batch re-dereferences symbolic refs and
 * re-runs the directory/file checks, counting other writers' lock files, so concurrent batches
 * cannot create `refs/x` and `refs/x/y` together. A detached HEAD (a name outside refs/) is never
 * packed: it may only be updated alone.
 *
 * Readers: a single read is loose-then-packed; `list` reads loose files, then packed-refs, then the
 * loose files again and retries if they changed, so it never combines a stale packed value with a
 * newer loose state (git reads loose before packed for the same reason).
 */
import {
  addHeadLogs,
  checkAtomic,
  checkBatch,
  checkNames,
  type Deref,
  defaultIdent,
  normalizeMessage,
  sleep,
} from "./batch-rules.js";
import type { BatchOptions, BatchResult, RefDb, ReflogEntry, RefValue } from "./ref-db.js";
import { ZERO_OID } from "./ref-db.js";
import { compareRefNames, isUpdatableNameOrSymTarget } from "./refname-helpers.js";

/** X2's AtomicFiles plus listing and overwriting a file the caller owns (a lock). */
export interface RefFiles {
  read(path: string): AsyncIterable<Uint8Array>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<boolean>;
  createExclusive(path: string, content: Uint8Array): Promise<boolean>;
  replace(source: string, target: string): Promise<void>;
  /** Overwrite a file this caller created (its own lock). */
  write(path: string, content: Uint8Array): Promise<void>;
  /** File paths (not directories) under `dir`, recursively. */
  list(dir: string): AsyncIterable<string>;
  /** Append to a file, creating it (and its directories) if absent — git's O_APPEND reflog write. */
  append(path: string, content: Uint8Array): Promise<void>;
  /** Remove `dir` if it is an empty directory; false otherwise (git: try_remove_empty_parents). */
  removeEmptyDir(dir: string): Promise<boolean>;
}

export interface FilesRefDbOptions {
  /** Retry a held ref lock for this long (git: core.filesRefLockTimeout, 100 ms). */
  refLockTimeoutMs?: number;
  /** Retry a held packed-refs.lock for this long (git: core.packedRefsTimeout, 1000 ms). */
  packedLockTimeoutMs?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const PACKED = "packed-refs";

interface PackedEntry {
  oid: string;
  peeled?: string;
}

function parsePacked(text: string | undefined): Map<string, PackedEntry> {
  const out = new Map<string, PackedEntry>();
  if (!text) return out;
  let last: PackedEntry | undefined;
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("^")) {
      if (last) last.peeled = line.slice(1).trim();
      continue;
    }
    const sp = line.indexOf(" ");
    if (sp !== 40) throw new Error(`malformed packed-refs line: ${line}`);
    last = { oid: line.slice(0, 40) };
    out.set(line.slice(41), last);
  }
  return out;
}

/** "sorted" only: peel lines are kept for untouched refs; git peels the others on demand. */
function serializePacked(entries: Map<string, PackedEntry>): Uint8Array {
  let s = "# pack-refs with: sorted \n";
  for (const name of [...entries.keys()].sort(compareRefNames)) {
    const e = entries.get(name) as PackedEntry;
    s += `${e.oid} ${name}\n`;
    if (e.peeled) s += `^${e.peeled}\n`;
  }
  return enc.encode(s);
}

function parseReflog(text: string | undefined): ReflogEntry[] {
  if (!text) return [];
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const head = tab < 0 ? line : line.slice(0, tab);
      return {
        old: head.slice(0, 40),
        new: head.slice(41, 81),
        ident: head.slice(82),
        message: tab < 0 ? "" : line.slice(tab + 1),
      };
    });
}

export function filesRefDb(files: RefFiles, opts: FilesRefDbOptions = {}): RefDb {
  const refLockTimeout = opts.refLockTimeoutMs ?? 100;
  const packedLockTimeout = opts.packedLockTimeoutMs ?? 1000;

  /** File text, or undefined if absent — also when it vanishes between the check and the read. */
  async function readText(path: string): Promise<string | undefined> {
    if (!(await files.exists(path))) return undefined;
    let t = "";
    let any = false;
    for await (const c of files.read(path)) {
      any = true;
      t += dec.decode(c, { stream: true });
    }
    if (!any && !(await files.exists(path))) return undefined;
    return t + dec.decode();
  }
  /** As git's parse_loose_ref_contents: `ref:` with optional spaces, or an id then whitespace/end. */
  async function readLoose(name: string): Promise<RefValue | undefined> {
    const text = await readText(name);
    if (text === undefined) return undefined;
    const sym = /^ref:\s*(\S+)/.exec(text);
    if (sym) return { symref: sym[1] as string };
    const m = /^([0-9a-f]{40})(?:\s|$)/.exec(text);
    if (!m) throw new Error(`${name} is broken: ${JSON.stringify(text.slice(0, 50))}`);
    return { oid: m[1] as string };
  }
  const readPacked = async () => parsePacked(await readText(PACKED));
  async function read(
    name: string,
    packed?: Map<string, PackedEntry>,
  ): Promise<RefValue | undefined> {
    const loose = await readLoose(name);
    if (loose) return loose;
    const e = (packed ?? (await readPacked())).get(name);
    return e ? { oid: e.oid } : undefined;
  }
  async function deref(name: string): Promise<{ target: string; via: string[] }> {
    const via: string[] = [];
    let cur = name;
    for (let i = 0; i < 5; i++) {
      const v = await readLoose(cur);
      if (!v || !("symref" in v)) return { target: cur, via };
      via.push(cur);
      cur = v.symref;
    }
    throw new Error(`symbolic ref ${name} nests too deeply`);
  }
  async function headTarget(): Promise<string | undefined> {
    const h = await readLoose("HEAD").catch(() => undefined);
    return h && "symref" in h ? (await deref("HEAD")).target : undefined;
  }
  /** Remove `path`, then its empty parent directories up to (not including) `stop`. */
  async function removeAndPrune(path: string): Promise<void> {
    await files.remove(path);
    const stop = path.startsWith("logs/") ? "logs" : "refs";
    for (
      let d = path.slice(0, path.lastIndexOf("/"));
      d.includes("/") && d !== stop;
      d = d.slice(0, d.lastIndexOf("/"))
    ) {
      if (!(await files.removeEmptyDir(d))) break;
    }
  }
  /** "ok", "held" (someone else's lock) or "conflict" (a file where a directory is needed). */
  async function lock(
    path: string,
    timeoutMs: number,
    content = new Uint8Array(0),
  ): Promise<"ok" | "held" | "conflict"> {
    const until = Date.now() + timeoutMs;
    for (let wait = 1; ; wait = Math.min(wait * 2, 20)) {
      try {
        if (await files.createExclusive(`${path}.lock`, content)) return "ok";
      } catch {
        return "conflict"; // e.g. ENOTDIR: refs/x is a file, so refs/x/y.lock cannot exist
      }
      if (Date.now() >= until) return "held";
      await sleep(wait);
    }
  }
  const unlock = (path: string) => removeAndPrune(`${path}.lock`).catch(() => {});
  /** Commit a lock over its target; an empty directory left at the target is removed first. */
  async function commit(path: string): Promise<void> {
    await files.removeEmptyDir(path);
    await files.replace(`${path}.lock`, path);
  }
  /** Reflogs are best effort after the decision, as JGit: a failure never fails a committed batch. */
  async function writeLogs(
    cmds: (Deref & { old: string | undefined })[],
    o: BatchOptions,
  ): Promise<void> {
    const ident = o.ident ?? defaultIdent();
    const message = normalizeMessage(o.message);
    for (const c of cmds) {
      try {
        if (c.new === null) {
          if (await files.exists(`logs/${c.name}`)) await removeAndPrune(`logs/${c.name}`);
          continue;
        }
        const old = c.old ?? ZERO_OID;
        if (old === c.new) continue; // git logs no no-op updates
        const line = enc.encode(`${old} ${c.new} ${ident}${message ? `\t${message}` : ""}\n`);
        for (const n of [c.name, ...c.via]) {
          await files.removeEmptyDir(`logs/${n}`);
          await files.append(`logs/${n}`, line);
        }
      } catch {
        // as git and JGit: the ref update stands without its reflog line
      }
    }
  }
  /**
   * Directory/file checks against the current state, counting other writers' lock files as
   * pending names (`mine` are this batch's own locks).
   */
  async function conflicts(cmds: Deref[], packed: Map<string, PackedEntry>, mine: Set<string>) {
    return checkBatch(
      cmds,
      async (n) =>
        (await read(n, packed)) !== undefined ||
        (!mine.has(n) && (await files.exists(`${n}.lock`))),
      async (n) => {
        for (const k of packed.keys()) if (k.startsWith(`${n}/`)) return true;
        for await (const p of files.list(n)) {
          if (!p.endsWith(".lock") || !mine.has(p.slice(0, -5))) return true;
        }
        return false;
      },
    );
  }
  /** Under the locks: every command still names the same target as when it was dereferenced. */
  async function sameTargets(cmds: Deref[]) {
    const out: BatchResult["rejected"] = [];
    for (const c of cmds)
      if (c.via.length && (await deref(c.orig)).target !== c.name)
        out.push({ name: c.orig, reason: "mismatch" });
    return out;
  }
  const fail = (rejected: BatchResult["rejected"]): BatchResult => ({ ok: false, rejected });

  async function single(c: Deref, o: BatchOptions): Promise<BatchResult> {
    const content = c.new === null ? new Uint8Array(0) : enc.encode(`${c.new}\n`);
    const extra = c.via.includes("HEAD") && c.name !== "HEAD" ? ["HEAD"] : [];
    const held: string[] = [];
    let ours = true;
    try {
      for (const n of [...extra, c.name]) {
        const r = await lock(n, refLockTimeout, n === c.name ? content : new Uint8Array(0));
        if (r !== "ok") return fail([{ name: n, reason: r === "held" ? "locked" : "df-conflict" }]);
        held.push(n);
      }
      const moved = await sameTargets([c]);
      if (moved.length) return fail(moved);
      const packed = await readPacked();
      const df = await conflicts([c], packed, new Set(held));
      if (df.length) return fail(df);
      const cur = await read(c.name, packed);
      const curOid = cur && "oid" in cur ? cur.oid : undefined;
      if (c.old !== undefined && (c.old === null ? cur !== undefined : curOid !== c.old)) {
        return fail([{ name: c.name, reason: "mismatch" }]);
      }
      if (c.new === null) {
        if (packed.has(c.name)) {
          // git's order: drop it from packed-refs first, then remove the loose file
          if ((await lock(PACKED, packedLockTimeout)) !== "ok")
            return fail([{ name: PACKED, reason: "locked" }]);
          let packedOurs = true;
          try {
            const fresh = await readPacked();
            fresh.delete(c.name);
            await files.write(`${PACKED}.lock`, serializePacked(fresh));
            await files.replace(`${PACKED}.lock`, PACKED);
            packedOurs = false;
          } finally {
            if (packedOurs) await files.remove(`${PACKED}.lock`).catch(() => false);
          }
        }
        if (await files.exists(c.name)) await removeAndPrune(c.name);
        await writeLogs([{ ...c, old: curOid }], o);
      } else {
        await writeLogs([{ ...c, old: curOid }], o); // under the ref lock, before the rename (as git)
        await commit(c.name);
        ours = false;
      }
      return { ok: true, rejected: [] };
    } finally {
      for (const n of held) if (n !== c.name || ours) await unlock(n);
    }
  }

  async function multi(cmds: Deref[], o: BatchOptions): Promise<BatchResult> {
    const extra = cmds.some((c) => c.via.includes("HEAD")) ? ["HEAD"] : [];
    const names = [...new Set([...extra, ...cmds.map((c) => c.name)])].sort(compareRefNames);
    const held: string[] = [];
    let packedHeld = false;
    try {
      for (const n of names) {
        const r = await lock(n, refLockTimeout);
        if (r !== "ok") return fail([{ name: n, reason: r === "held" ? "locked" : "df-conflict" }]);
        held.push(n);
      }
      if ((await lock(PACKED, packedLockTimeout)) !== "ok")
        return fail([{ name: PACKED, reason: "locked" }]);
      packedHeld = true;
      const moved = await sameTargets(cmds);
      if (moved.length) return fail(moved);
      let packed = await readPacked();
      const df = await conflicts(cmds, packed, new Set(held));
      if (df.length) return fail(df);
      const loose = new Map<string, string>();
      const current = new Map<string, string | undefined>();
      for (const c of cmds) {
        const l = await readLoose(c.name);
        if (l && "symref" in l) throw new Error(`${c.name} became a symbolic ref`);
        if (l) loose.set(c.name, l.oid);
        current.set(c.name, l?.oid ?? packed.get(c.name)?.oid);
      }
      const mismatched = cmds.filter(
        (c) =>
          c.old !== undefined &&
          (c.old === null ? current.get(c.name) !== undefined : current.get(c.name) !== c.old),
      );
      if (mismatched.length)
        return fail(mismatched.map((c) => ({ name: c.name, reason: "mismatch" as const })));
      if (loose.size) {
        // Phase 1: move the involved loose refs into packed-refs (values unchanged for readers),
        // committing packed-refs BEFORE removing the loose files.
        for (const [n, v] of loose) {
          const prev = packed.get(n);
          packed.set(n, prev?.oid === v ? prev : { oid: v });
        }
        await files.write(`${PACKED}.lock`, serializePacked(packed));
        await files.replace(`${PACKED}.lock`, PACKED);
        packedHeld = false;
        for (const n of loose.keys()) await removeAndPrune(n);
        if ((await lock(PACKED, packedLockTimeout)) !== "ok")
          return fail([{ name: PACKED, reason: "locked" }]);
        packedHeld = true;
        packed = await readPacked();
      }
      // Phase 2: the whole batch in one rename.
      for (const c of cmds) {
        if (c.new === null) packed.delete(c.name);
        else packed.set(c.name, { oid: c.new });
      }
      await files.write(`${PACKED}.lock`, serializePacked(packed));
      await files.replace(`${PACKED}.lock`, PACKED);
      packedHeld = false;
      await writeLogs(
        cmds.map((c) => ({ ...c, old: current.get(c.name) })),
        o,
      );
      return { ok: true, rejected: [] };
    } finally {
      if (packedHeld) await files.remove(`${PACKED}.lock`).catch(() => false);
      for (const n of held) await unlock(n);
    }
  }

  /** Direct loose refs under refs/ (broken or symbolic ones skipped, as for-each-ref warns and skips). */
  async function scanLoose(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for await (const p of files.list("refs")) {
      if (p.endsWith(".lock")) continue;
      try {
        const v = await readLoose(p);
        if (v && "oid" in v) out.set(p, v.oid);
        else if (v) out.set(p, "");
      } catch {
        // broken loose ref: skipped
      }
    }
    return out;
  }
  const sameMap = (a: Map<string, string>, b: Map<string, string>) =>
    a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

  return {
    read: (name) => read(name),
    async resolve(name) {
      const { target } = await deref(name);
      const v = await read(target);
      return v && "oid" in v ? v.oid : undefined;
    },
    async *list(prefix = "refs/") {
      let snapshot: Map<string, string> | undefined;
      for (let attempt = 0; attempt < 20 && !snapshot; attempt++) {
        const loose = await scanLoose();
        const packed = await readPacked();
        const again = await scanLoose();
        if (!sameMap(loose, again)) continue; // a writer moved loose refs meanwhile: read again
        const merged = new Map<string, string>();
        for (const [n, e] of packed) merged.set(n, e.oid);
        for (const [n, v] of loose) {
          if (v) merged.set(n, v);
          else merged.delete(n); // a loose symbolic ref hides a packed value of the same name
        }
        snapshot = merged;
      }
      if (!snapshot) throw new Error("refs kept changing while listing");
      for (const n of [...snapshot.keys()].sort(compareRefNames)) {
        if (n.startsWith(prefix) && n.startsWith("refs/"))
          yield { name: n, oid: snapshot.get(n) as string };
      }
    },
    async batch(commands, o = {}) {
      if (commands.length === 0) return { ok: true, rejected: [] };
      const bad = checkNames(commands);
      if (bad.length) return fail(bad);
      const cmds: Deref[] = [];
      for (const c of commands) {
        const { target, via } = c.noDeref ? { target: c.name, via: [] } : await deref(c.name);
        if (!isUpdatableNameOrSymTarget(target))
          return fail([{ name: c.name, reason: "invalid-name" }]);
        cmds.push({ ...c, orig: c.name, name: target, via });
      }
      const notAtomic = checkAtomic(cmds);
      if (notAtomic.length) return fail(notAtomic);
      addHeadLogs(cmds, await headTarget());
      const df = await conflicts(cmds, await readPacked(), new Set());
      if (df.length) return fail(df);
      return cmds.length === 1 ? single(cmds[0] as Deref, o) : multi(cmds, o);
    },
    async setSymref(name, target, expected) {
      if (
        !isUpdatableNameOrSymTarget(name) ||
        !target.startsWith("refs/") ||
        !isUpdatableNameOrSymTarget(target)
      ) {
        throw new Error(`invalid symbolic ref ${name} -> ${target}`);
      }
      if ((await lock(name, refLockTimeout, enc.encode(`ref: ${target}\n`))) !== "ok") return false;
      let ours = true;
      try {
        const cur = await read(name);
        if (expected === null && cur !== undefined) return false;
        if (typeof expected === "string" && !(cur && "symref" in cur && cur.symref === expected))
          return false;
        await commit(name);
        ours = false;
        return true;
      } finally {
        if (ours) await unlock(name);
      }
    },
    async reflog(name) {
      return parseReflog(await readText(`logs/${name}`));
    },
  };
}
