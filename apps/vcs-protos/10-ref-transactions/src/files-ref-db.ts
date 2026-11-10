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
 * remain, as with git, until removed.
 */
import { checkBatch, checkNames, defaultIdent, sleep } from "./batch-rules.js";
import type {
  BatchOptions,
  BatchResult,
  RefCommand,
  RefDb,
  ReflogEntry,
  RefValue,
} from "./ref-db.js";
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
}

export interface FilesRefDbOptions {
  /** Retry a held ref lock for this long (git: core.filesRefLockTimeout, 100 ms). */
  refLockTimeoutMs?: number;
  /** Retry a held packed-refs.lock for this long (git: core.packedRefsTimeout, 1000 ms). */
  packedLockTimeoutMs?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const OID = /^[0-9a-f]{40}$/;
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

  async function readText(path: string): Promise<string | undefined> {
    if (!(await files.exists(path))) return undefined;
    let t = "";
    for await (const c of files.read(path)) t += dec.decode(c, { stream: true });
    return t + dec.decode();
  }
  async function readLoose(name: string): Promise<RefValue | undefined> {
    const text = await readText(name);
    if (text === undefined) return undefined;
    const v = text.trim();
    if (v.startsWith("ref: ")) return { symref: v.slice(5).trim() };
    if (!OID.test(v)) throw new Error(`${name} is broken: ${JSON.stringify(v.slice(0, 50))}`);
    return { oid: v };
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
  /** Final target name of a (possibly symbolic) ref, at most 5 hops, and the symrefs passed. */
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
  async function lock(
    path: string,
    timeoutMs: number,
    content = new Uint8Array(0),
  ): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    for (let wait = 1; ; wait = Math.min(wait * 2, 20)) {
      if (await files.createExclusive(`${path}.lock`, content)) return true;
      if (Date.now() >= until) return false;
      await sleep(wait);
    }
  }
  async function appendLog(
    name: string,
    old: string,
    next: string,
    ident: string,
    message: string,
  ) {
    const path = `logs/${name}`;
    const line = `${old} ${next} ${ident}\t${message.replace(/\n/g, " ")}\n`;
    const full = enc.encode(((await readText(path)) ?? "") + line);
    if (!(await files.createExclusive(`${path}.lock`, full))) return; // another writer logging: skip, as git warns
    await files.replace(`${path}.lock`, path);
  }
  async function writeLogs(
    cmds: { name: string; via: string[]; old: string | undefined; new: string | null }[],
    o: BatchOptions,
  ) {
    const ident = o.ident ?? defaultIdent();
    const message = o.message ?? "";
    for (const c of cmds) {
      if (c.new === null) {
        await files.remove(`logs/${c.name}`);
        continue;
      }
      for (const n of [c.name, ...c.via])
        await appendLog(n, c.old ?? ZERO_OID, c.new, ident, message);
    }
  }
  async function hasChildren(name: string, packed: Map<string, PackedEntry>): Promise<boolean> {
    for (const n of packed.keys()) if (n.startsWith(`${name}/`)) return true;
    for await (const p of files.list(name)) if (!p.endsWith(".lock")) return true;
    return false;
  }

  async function single(c: RefCommand & { via: string[] }, o: BatchOptions): Promise<BatchResult> {
    const content = c.new === null ? new Uint8Array(0) : enc.encode(`${c.new}\n`);
    if (!(await lock(c.name, refLockTimeout, content)))
      return { ok: false, rejected: [{ name: c.name, reason: "locked" }] };
    let ours = true;
    try {
      const packed = await readPacked();
      const cur = await read(c.name, packed);
      const curOid = cur && "oid" in cur ? cur.oid : undefined;
      if (c.old !== undefined && (c.old === null ? cur !== undefined : curOid !== c.old)) {
        return { ok: false, rejected: [{ name: c.name, reason: "mismatch" }] };
      }
      if (c.new === null) {
        if (packed.has(c.name)) {
          if (!(await lock(PACKED, packedLockTimeout)))
            return { ok: false, rejected: [{ name: PACKED, reason: "locked" }] };
          let packedOurs = true;
          try {
            const fresh = await readPacked();
            fresh.delete(c.name);
            await files.write(`${PACKED}.lock`, serializePacked(fresh));
            packedOurs = false;
            await files.replace(`${PACKED}.lock`, PACKED);
          } finally {
            if (packedOurs) await files.remove(`${PACKED}.lock`).catch(() => false);
          }
        }
        await files.remove(c.name);
        await writeLogs([{ ...c, old: curOid }], o);
      } else {
        await writeLogs([{ ...c, old: curOid }], o); // under the ref lock, before the rename (as git)
        ours = false;
        await files.replace(`${c.name}.lock`, c.name);
      }
      return { ok: true, rejected: [] };
    } finally {
      if (ours) await files.remove(`${c.name}.lock`).catch(() => false);
    }
  }

  async function multi(
    cmds: (RefCommand & { via: string[] })[],
    o: BatchOptions,
  ): Promise<BatchResult> {
    const names = cmds.map((c) => c.name).sort(compareRefNames);
    const held: string[] = [];
    let packedHeld = false;
    try {
      for (const n of names) {
        if (!(await lock(n, refLockTimeout)))
          return { ok: false, rejected: [{ name: n, reason: "locked" }] };
        held.push(n);
      }
      if (!(await lock(PACKED, packedLockTimeout)))
        return { ok: false, rejected: [{ name: PACKED, reason: "locked" }] };
      packedHeld = true;
      let packed = await readPacked();
      const loose = new Map<string, string>();
      const current = new Map<string, string | undefined>();
      for (const n of names) {
        const l = await readLoose(n);
        if (l && "symref" in l) throw new Error(`${n} became a symbolic ref`);
        if (l) loose.set(n, l.oid);
        current.set(n, l?.oid ?? packed.get(n)?.oid);
      }
      const mismatched = cmds.filter(
        (c) =>
          c.old !== undefined &&
          (c.old === null ? current.get(c.name) !== undefined : current.get(c.name) !== c.old),
      );
      if (mismatched.length)
        return {
          ok: false,
          rejected: mismatched.map((c) => ({ name: c.name, reason: "mismatch" as const })),
        };
      if (loose.size) {
        // Phase 1: move the involved loose refs into packed-refs (values unchanged for readers).
        for (const [n, v] of loose)
          packed.set(n, {
            oid: v,
            ...(packed.get(n)?.oid === v ? { peeled: packed.get(n)?.peeled } : {}),
          });
        await files.write(`${PACKED}.lock`, serializePacked(packed));
        packedHeld = false;
        await files.replace(`${PACKED}.lock`, PACKED);
        for (const n of loose.keys()) await files.remove(n);
        if (!(await lock(PACKED, packedLockTimeout)))
          return { ok: false, rejected: [{ name: PACKED, reason: "locked" }] };
        packedHeld = true;
        packed = await readPacked();
      }
      // Phase 2: the whole batch in one rename.
      for (const c of cmds) {
        if (c.new === null) packed.delete(c.name);
        else packed.set(c.name, { oid: c.new });
      }
      await files.write(`${PACKED}.lock`, serializePacked(packed));
      packedHeld = false;
      await files.replace(`${PACKED}.lock`, PACKED);
      await writeLogs(
        cmds.map((c) => ({ ...c, old: current.get(c.name) })),
        o,
      );
      return { ok: true, rejected: [] };
    } finally {
      if (packedHeld) await files.remove(`${PACKED}.lock`).catch(() => false);
      for (const n of held) await files.remove(`${n}.lock`).catch(() => false);
    }
  }

  return {
    read: (name) => read(name),
    async resolve(name) {
      const { target } = await deref(name);
      const v = await read(target);
      return v && "oid" in v ? v.oid : undefined;
    },
    async *list(prefix = "refs/") {
      const packed = await readPacked();
      const out = new Map<string, string>();
      for (const [n, e] of packed) if (n.startsWith(prefix)) out.set(n, e.oid);
      const dir = prefix.endsWith("/")
        ? prefix.slice(0, -1)
        : prefix.slice(0, prefix.lastIndexOf("/"));
      for await (const p of files.list(dir)) {
        if (!p.startsWith(prefix) || p.endsWith(".lock")) continue;
        const v = await readLoose(p);
        if (v && "oid" in v) out.set(p, v.oid);
        else if (v) out.delete(p);
      }
      for (const n of [...out.keys()].sort(compareRefNames))
        yield { name: n, oid: out.get(n) as string };
    },
    async batch(commands, o = {}) {
      const bad = checkNames(commands);
      if (bad.length) return { ok: false, rejected: bad };
      const cmds: (RefCommand & { via: string[] })[] = [];
      for (const c of commands) {
        const { target, via } = await deref(c.name);
        if (!isUpdatableNameOrSymTarget(target))
          return { ok: false, rejected: [{ name: c.name, reason: "invalid-name" }] };
        cmds.push({ ...c, name: target, via });
      }
      const packed = await readPacked();
      const conflicts = await checkBatch(
        cmds,
        async (n) => (await read(n, packed)) !== undefined,
        (n) => hasChildren(n, packed),
      );
      if (conflicts.length) return { ok: false, rejected: conflicts };
      return cmds.length === 1
        ? single(cmds[0] as RefCommand & { via: string[] }, o)
        : multi(cmds, o);
    },
    async setSymref(name, target, expected) {
      if (
        !isUpdatableNameOrSymTarget(name) ||
        !target.startsWith("refs/") ||
        !isUpdatableNameOrSymTarget(target)
      ) {
        throw new Error(`invalid symbolic ref ${name} -> ${target}`);
      }
      if (!(await lock(name, refLockTimeout, enc.encode(`ref: ${target}\n`)))) return false;
      let ours = true;
      try {
        const cur = await read(name);
        if (expected === null && cur !== undefined) return false;
        if (typeof expected === "string" && !(cur && "symref" in cur && cur.symref === expected))
          return false;
        ours = false;
        await files.replace(`${name}.lock`, name);
        return true;
      } finally {
        if (ours) await files.remove(`${name}.lock`).catch(() => false);
      }
    },
    async reflog(name) {
      return parseReflog(await readText(`logs/${name}`));
    },
  };
}
