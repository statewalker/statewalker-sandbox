/**
 * X18 — safe gc: git's `gc` (repack what is reachable into one pack) and `prune` (delete what has
 * been unreachable longer than a grace period), on X16a's stores, resumable and safe with
 * concurrent writers.
 *
 * Phases, each persisted (its state in files under the store's `gc/` directory) before the next:
 *  - snapshot: the packs and loose objects present now — the only ones gc may delete;
 *  - mark: X6c's walk from the roots — every ref, HEAD, every reflog entry, linked worktrees'
 *    HEADs and reflogs, the blobs and cache-trees of the index files; the repository's shallow
 *    commits bound the walk — also the repack list;
 *  - repack: X6e's search over the marked objects into X6b's install: one new pack;
 *  - ledger: when each snapshot object was first seen unreachable (grace without mtimes: SQL rows
 *    have none); an object reachable again, or written again (git freshens: the store leaves a
 *    marker under gc/fresh), starts over;
 *  - sweep: gc's flag (owned, renewed) is taken — another live sweep defers this one — then the
 *    leases are checked (a live one defers); the roots are walked again, and what unexpired
 *    unreachable objects reach is kept too (git's recent objects); then snapshot objects the new
 *    pack holds, or that stayed unreachable for the grace, are deleted — loose ones one by one,
 *    packs only when every object in them may go and no `.keep` protects them.
 * A writer that may reuse old objects holds a lease (`withLease`, renewed while held): it writes
 * the lease, then waits while a sweep runs; the sweep writes its flag, then checks the leases —
 * each checks after it writes, so one of them sees the other.
 */
import type { FilesApi } from "@statewalker/webrun-files";
import { readCommit, readTree } from "../../17-repository/src/commands.js";
import { parseTagTarget } from "../../17-repository/src/git-format.js";
import type { GcAccess, Repository } from "../../17-repository/src/object-store.js";
import { listObjectsWithEdges, type ToSend } from "../../18-pack-export/src/export.js";
import { writePackSearching } from "../../20-delta-search/src/export-search.js";

export type GcPhase = "snapshot" | "mark" | "repack" | "ledger" | "sweep" | "done";
export interface GcStats {
  reachable: number;
  packed: number;
  removedLoose: number;
  removedPacks: number;
  keptUnreachable: number;
}
export interface GcOptions {
  /** unreachable objects are deleted after this long. Default 14 days (git's gc.pruneExpire). */
  graceMs?: number;
  now?: () => number;
  /** phases per call (gcStep). Default: all. */
  units?: number;
  /** tests: called after each phase (a concurrent writer, a crash) */
  afterPhase?: (phase: GcPhase) => Promise<void>;
  /** tests: called inside the sweep, after its flag is set and the leases checked, before deleting */
  duringSweep?: () => Promise<void>;
  /** the sweep flag's lifetime between renewals. Default 10 minutes. */
  sweepTtlMs?: number;
  /** tests: called after each deletion in the sweep (a crash mid-sweep) */
  afterDelete?: () => Promise<void>;
}
export interface GcStep {
  phase: GcPhase;
  done: boolean;
  deferred?: boolean;
  stats: GcStats;
}

interface GcState {
  phase: Exclude<GcPhase, "snapshot">;
  packs: string[];
  newPack?: string;
  stats: GcStats;
}

const ZERO = "0".repeat(40);
const OID = /^[0-9a-f]{40}$/;
const enc = new TextEncoder();
const dec = new TextDecoder();
const DEFAULT_TTL_MS = 10 * 60_000;
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function access(repo: Repository): GcAccess {
  const a = repo.objects.gc;
  if (!a) throw new Error("this object store does not support gc");
  return a;
}

async function readBytes(files: FilesApi, path: string): Promise<Uint8Array | undefined> {
  if (!(await files.exists(path))) return undefined;
  const parts: Uint8Array[] = [];
  for await (const c of files.read(path)) parts.push(c);
  return new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
}
async function readText(files: FilesApi, path: string): Promise<string | undefined> {
  const b = await readBytes(files, path);
  return b ? dec.decode(b) : undefined;
}
/** Written to a temporary name, then moved: a crash leaves the old content or the new. */
async function writeText(files: FilesApi, path: string, text: string) {
  const tmp = `${path}.${randomId()}.tmp`;
  await files.write(tmp, [enc.encode(text)]);
  await files.move(tmp, path);
}
async function listNames(files: FilesApi, dir: string): Promise<string[]> {
  if (!(await files.exists(dir))) return [];
  const out: string[] = [];
  for await (const e of files.list(dir)) {
    const entry = e as { path: string; name?: string };
    out.push(entry.name ?? entry.path.slice(entry.path.lastIndexOf("/") + 1));
  }
  return out;
}
const newStats = (): GcStats => ({
  reachable: 0,
  packed: 0,
  removedLoose: 0,
  removedPacks: 0,
  keptUnreachable: 0,
});
function randomId() {
  return hexOf(crypto.getRandomValues(new Uint8Array(8)));
}

/** The blobs and cache-tree trees of a git index (v2, v3; v4's prefix-compressed paths refused). */
function indexObjects(bytes: Uint8Array): string[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dec.decode(bytes.subarray(0, 4)) !== "DIRC") throw new Error("not a git index");
  const version = dv.getUint32(4);
  if (version !== 2 && version !== 3)
    throw new Error(`index version ${version} is not read by gc (its objects cannot be kept)`);
  const n = dv.getUint32(8);
  const out: string[] = [];
  let p = 12;
  for (let i = 0; i < n; i++) {
    const start = p;
    out.push(hexOf(bytes.subarray(start + 40, start + 60)));
    const flags = dv.getUint16(start + 60);
    let q = start + 62;
    if (version === 3 && flags & 0x4000) q += 2;
    const nul = bytes.indexOf(0, q);
    p = start + Math.ceil((nul + 1 - start) / 8) * 8; // entries are padded to a multiple of 8
  }
  // extensions: TREE (the cache-tree) names trees
  while (p + 8 <= bytes.length - 20) {
    const sig = dec.decode(bytes.subarray(p, p + 4));
    const len = dv.getUint32(p + 4);
    if (sig === "TREE") {
      const body = bytes.subarray(p + 8, p + 8 + len);
      let q = 0;
      while (q < body.length) {
        const nul = body.indexOf(0, q);
        const nl = body.indexOf(0x0a, nul);
        const [count] = dec.decode(body.subarray(nul + 1, nl)).split(" ");
        q = nl + 1;
        if (Number(count) >= 0) {
          out.push(hexOf(body.subarray(q, q + 20)));
          q += 20;
        }
      }
    }
    p += 8 + len;
  }
  return out;
}

/**
 * git's roots: every ref, HEAD (also detached), every reflog entry, linked worktrees' HEADs and
 * reflogs, and the index files' objects — only ids present here.
 */
async function roots(repo: Repository, a: GcAccess): Promise<string[]> {
  const out = new Set<string>();
  const names: string[] = ["HEAD"];
  for await (const r of repo.refs.list("refs/")) {
    out.add(r.oid);
    names.push(r.name);
  }
  const head = await repo.refs.resolve("HEAD");
  if (head) out.add(head);
  for (const n of names)
    for (const e of await repo.refs.reflog(n).catch(() => []))
      for (const id of [e.old, e.new]) if (id && id !== ZERO && OID.test(id)) out.add(id);
  const logIds = (text: string) => {
    for (const line of text.split("\n")) {
      const [o, n] = line.split(" ");
      for (const id of [o, n]) if (id && id !== ZERO && OID.test(id)) out.add(id);
    }
  };
  const indexes = [`${a.root}/index`];
  for (const wt of await listNames(a.files, `${a.root}/worktrees`)) {
    const base = `${a.root}/worktrees/${wt}`;
    const h = (await readText(a.files, `${base}/HEAD`))?.trim();
    if (h && OID.test(h)) out.add(h);
    else if (h?.startsWith("ref: ")) {
      const id = await repo.refs.resolve(h.slice(5));
      if (id) out.add(id);
    }
    const log = await readText(a.files, `${base}/logs/HEAD`);
    if (log) logIds(log);
    indexes.push(`${base}/index`);
  }
  for (const path of indexes) {
    const bytes = await readBytes(a.files, path);
    if (bytes) for (const id of indexObjects(bytes)) out.add(id);
  }
  const present: string[] = [];
  for (const id of out) if (await repo.objects.has(id)) present.push(id);
  return present;
}

async function shallowOf(a: GcAccess): Promise<string[]> {
  const text = await readText(a.files, `${a.root}/shallow`);
  return (text ?? "").split("\n").filter((l) => OID.test(l));
}

async function mark(repo: Repository, a: GcAccess): Promise<ToSend[]> {
  const r = await roots(repo, a);
  if (!r.length) return [];
  return (await listObjectsWithEdges(repo, r, [], { shallow: await shallowOf(a) })).objects;
}

/** Everything `starts` reach, tolerating missing objects (git's recent-objects traversal). */
async function closure(repo: Repository, starts: Iterable<string>, stop: Set<string>) {
  const seen = new Set<string>();
  const stack = [...starts];
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id) || stop.has(id)) continue;
    seen.add(id);
    const o = await repo.objects.get(id).catch(() => undefined);
    if (!o) continue;
    const type = o.type;
    const parts: Uint8Array[] = [];
    if (type === "tag") for await (const c of o.content) parts.push(c);
    else await o.content[Symbol.asyncIterator]().return?.();
    try {
      if (type === "commit") {
        const c = await readCommit(repo, id);
        stack.push(c.tree, ...c.parents);
      } else if (type === "tree") {
        for (const e of await readTree(repo, id))
          if (Number.parseInt(e.mode, 8) !== 0o160000) stack.push(e.oid);
      } else if (type === "tag") {
        stack.push(
          parseTagTarget(new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer())).object,
        );
      }
    } catch {
      // a broken object: what it would reach stays unknown
    }
  }
  return seen;
}

const paths = (dir: string) => ({
  state: `${dir}/state.json`,
  loose: `${dir}/snapshot-loose`,
  reachable: `${dir}/reachable`,
  ledger: `${dir}/ledger.json`,
  leases: `${dir}/leases`,
  sweeping: `${dir}/sweeping`,
  fresh: `${dir}/fresh`,
});

async function liveLeases(files: FilesApi, dir: string): Promise<number> {
  let n = 0;
  for (const name of await listNames(files, dir)) {
    if (!name.endsWith(".json")) continue; // a temporary being written
    const path = `${dir}/${name}`;
    let expires: number;
    try {
      expires = Number(JSON.parse((await readText(files, path)) ?? "{}").expires ?? 0);
    } catch {
      expires = Date.now() + 1; // unreadable: count it live
    }
    if (expires > Date.now()) n++;
    else await files.remove(path).catch(() => false); // expired: its holder stopped renewing
  }
  return n;
}

/** Freshened ids (markers left by the store): loose ids and the ids of freshened packs. */
async function freshened(a: GcAccess, dir: string) {
  const ids = new Set<string>();
  const names = await listNames(a.files, dir);
  const packs = new Map(a.packs().map((r) => [r.packId, r]));
  for (const n of names) {
    if (n.startsWith("l-")) ids.add(n.slice(2));
    else if (n.startsWith("p-")) for (const id of packs.get(n.slice(2))?.ids() ?? []) ids.add(id);
  }
  return { ids, names };
}

const flagOf = (text: string | undefined): { token?: string; expires: number } => {
  if (!text) return { expires: 0 };
  try {
    const f = JSON.parse(text);
    return { token: f.token, expires: Number(f.expires) };
  } catch {
    return { expires: Date.now() + 1 }; // half written: live
  }
};

export async function gcStep(repo: Repository, opts: GcOptions = {}): Promise<GcStep> {
  const a = access(repo);
  await a.refresh(); // another handle may have changed the packs
  const p = paths(a.dir);
  const now = opts.now ?? Date.now;
  const graceMs = opts.graceMs ?? 14 * 24 * 3600_000;
  const sweepTtl = opts.sweepTtlMs ?? DEFAULT_TTL_MS;
  let units = opts.units ?? Number.POSITIVE_INFINITY;
  const stateText = await readText(a.files, p.state);
  let state: GcState | undefined = stateText ? JSON.parse(stateText) : undefined;
  const save = async (s: GcState) => {
    state = s;
    await writeText(a.files, p.state, JSON.stringify(s));
  };
  const after = async (phase: GcPhase) => {
    await opts.afterPhase?.(phase);
  };

  while (units-- > 0) {
    if (!state) {
      // --- snapshot (the ledger exists from now: the store starts leaving freshen markers)
      if (!(await a.files.exists(p.ledger))) await writeText(a.files, p.ledger, "{}");
      const packs = a.packs().map((x) => x.packId);
      const loose: string[] = [];
      for await (const id of a.loose()) loose.push(id);
      await writeText(a.files, p.loose, loose.join("\n"));
      await save({ phase: "mark", packs, stats: newStats() });
      await after("snapshot");
      continue;
    }
    const s: GcState = state;
    if (s.phase === "mark") {
      const objects = await mark(repo, a);
      await writeText(a.files, p.reachable, objects.map((o) => JSON.stringify(o)).join("\n"));
      await save({ ...s, phase: "repack", stats: { ...s.stats, reachable: objects.length } });
      await after("mark");
    } else if (s.phase === "repack") {
      const text = (await readText(a.files, p.reachable)) ?? "";
      const objects: ToSend[] = text ? text.split("\n").map((l) => JSON.parse(l)) : [];
      let newPack: string | undefined;
      let packed = 0;
      if (objects.length) {
        const r = await repo.objects.installPack(writePackSearching(repo, objects));
        newPack = r.packId;
        packed = r.count;
      }
      await save({ ...s, phase: "ledger", newPack, stats: { ...s.stats, packed } });
      await after("repack");
    } else if (s.phase === "ledger") {
      const reachable = await reachableSet(a);
      const ledger: Record<string, number> = JSON.parse(
        (await readText(a.files, p.ledger)) ?? "{}",
      );
      const t = now();
      const snapshot = await snapshotIds(a, p, s);
      const fresh = await freshened(a, p.fresh);
      // written again (freshened) or gone from the snapshot: the record starts over
      for (const id of Object.keys(ledger))
        if (!snapshot.has(id) || fresh.ids.has(id)) delete ledger[id];
      for (const id of snapshot) {
        if (reachable.has(id)) delete ledger[id];
        else ledger[id] ??= t;
      }
      await writeText(a.files, p.ledger, JSON.stringify(ledger));
      for (const n of fresh.names) await a.files.remove(`${p.fresh}/${n}`).catch(() => false);
      await save({ ...s, phase: "sweep" });
      await after("ledger");
    } else if (s.phase === "sweep") {
      // gc's flag: owned (a token) and renewed; another sweep's live flag defers this one
      const token = randomId();
      const other = flagOf(await readText(a.files, p.sweeping).catch(() => undefined));
      if (other.expires > Date.now())
        return { phase: "sweep", done: false, deferred: true, stats: s.stats };
      const writeFlag = () =>
        writeText(a.files, p.sweeping, JSON.stringify({ token, expires: Date.now() + sweepTtl }));
      await writeFlag();
      if (flagOf(await readText(a.files, p.sweeping)).token !== token)
        return { phase: "sweep", done: false, deferred: true, stats: s.stats };
      const renew = setInterval(() => void writeFlag().catch(() => {}), Math.max(10, sweepTtl / 3));
      try {
        if (await liveLeases(a.files, p.leases))
          return { phase: "sweep", done: false, deferred: true, stats: s.stats };
        await opts.duringSweep?.();
        const ledger: Record<string, number> = JSON.parse(
          (await readText(a.files, p.ledger)) ?? "{}",
        );
        // walked again: a ref moved during gc keeps what it now reaches
        const reachableNow = new Set((await mark(repo, a)).map((o) => o.oid));
        const inNewPack = new Set<string>();
        if (s.newPack)
          for (const r of a.packs())
            if (r.packId === s.newPack) for (const id of r.ids()) inNewPack.add(id);
        const freshNow = (await freshened(a, p.fresh)).ids; // written again since the ledger phase
        const t = now();
        const expired = (id: string) =>
          !reachableNow.has(id) &&
          !freshNow.has(id) &&
          ledger[id] !== undefined &&
          (ledger[id] as number) + graceMs <= t;
        // git's recent objects: what an unexpired unreachable object reaches is kept as well
        const snapshot = await snapshotIds(a, p, s);
        const young: string[] = [];
        for (const id of snapshot)
          if (!reachableNow.has(id) && !inNewPack.has(id) && !expired(id)) young.push(id);
        const protectedIds = await closure(repo, young, reachableNow);
        const deletable = (id: string) =>
          inNewPack.has(id) || (expired(id) && !protectedIds.has(id));
        const stats = { ...s.stats };
        const kept = new Set<string>();
        const loose = ((await readText(a.files, p.loose)) ?? "").split("\n").filter(Boolean);
        for (const id of loose) {
          if (deletable(id)) {
            await a.removeLoose(id).catch(() => {});
            stats.removedLoose++;
            await opts.afterDelete?.();
          } else if (!reachableNow.has(id)) kept.add(id);
        }
        const keep = await a.keptPacks();
        const doomed: string[] = [];
        for (const r of a.packs()) {
          if (r.packId === s.newPack || !s.packs.includes(r.packId) || keep.has(r.packId)) continue;
          let all = true;
          for (const id of r.ids())
            if (!deletable(id)) {
              all = false;
              if (!reachableNow.has(id)) kept.add(id);
            }
          if (all) doomed.push(r.packId);
        }
        for (const id of doomed) {
          await a.removePacks([id]);
          await opts.afterDelete?.();
        }
        // the ledger forgets what is gone: a re-added object starts a new grace
        for (const id of snapshot) if (!kept.has(id)) delete ledger[id];
        await writeText(a.files, p.ledger, JSON.stringify(ledger));
        stats.removedPacks = doomed.length;
        stats.keptUnreachable = kept.size;
        for (const f of [p.loose, p.reachable]) await a.files.remove(f).catch(() => false);
        await a.files.remove(p.state);
        state = undefined;
        await after("sweep");
        return { phase: "done", done: true, stats };
      } finally {
        clearInterval(renew);
        if (flagOf(await readText(a.files, p.sweeping).catch(() => undefined)).token === token)
          await a.files.remove(p.sweeping).catch(() => false);
      }
    }
  }
  return { phase: state?.phase ?? "snapshot", done: false, stats: state?.stats ?? newStats() };
}

async function reachableSet(a: GcAccess): Promise<Set<string>> {
  const text = (await readText(a.files, paths(a.dir).reachable)) ?? "";
  return new Set<string>(text ? text.split("\n").map((l) => (JSON.parse(l) as ToSend).oid) : []);
}

async function snapshotIds(
  a: GcAccess,
  p: ReturnType<typeof paths>,
  s: GcState,
): Promise<Set<string>> {
  const ids = new Set(((await readText(a.files, p.loose)) ?? "").split("\n").filter(Boolean));
  for (const r of a.packs()) if (s.packs.includes(r.packId)) for (const id of r.ids()) ids.add(id);
  return ids;
}

/** Runs the steps until gc is done, or deferred by a live lease or another sweep. */
export async function gc(repo: Repository, opts: GcOptions = {}): Promise<GcStep> {
  for (;;) {
    const s = await gcStep(repo, { ...opts, units: 1 });
    if (s.done || s.deferred) return s;
  }
}

/**
 * Runs `fn` holding a lease (renewed while held): a running sweep is waited for; a sweep starting
 * meanwhile defers.
 */
export async function withLease<T>(
  repo: Repository,
  fn: () => Promise<T>,
  opts: { ttlMs?: number } = {},
): Promise<T> {
  const a = access(repo);
  const p = paths(a.dir);
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const lease = `${p.leases}/${randomId()}.json`;
  const write = () => writeText(a.files, lease, JSON.stringify({ expires: Date.now() + ttl }));
  await write();
  const renew = setInterval(() => void write().catch(() => {}), Math.max(10, ttl / 3));
  try {
    // the lease first, then the flag: a sweep running now has not seen this lease
    while (flagOf(await readText(a.files, p.sweeping).catch(() => undefined)).expires > Date.now())
      await new Promise((r) => setTimeout(r, 25));
    return await fn();
  } finally {
    clearInterval(renew);
    await a.files.remove(lease).catch(() => false);
  }
}
