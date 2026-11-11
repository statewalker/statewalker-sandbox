/**
 * X18 — safe gc: git's `gc` (repack what is reachable into one pack) and `prune` (delete what has
 * been unreachable longer than a grace period), on X16a's stores, resumable and safe with
 * concurrent writers.
 *
 * Phases, each persisted (its state in files under the store's `gc/` directory) before the next:
 *  - snapshot: the packs and loose objects present now — the only ones gc may delete;
 *  - mark: X6c's walk from the roots (refs, HEAD, reflog entries) — also the repack list;
 *  - repack: X6e's search over the marked objects into X6b's install: one new pack;
 *  - ledger: when each snapshot object was first seen unreachable (grace without mtimes: SQL rows
 *    have none); an object reachable again leaves the ledger;
 *  - sweep: the sweeping flag is set, then the leases are checked (a live one defers the sweep);
 *    the roots are walked again (a ref moved during gc keeps its objects); then snapshot objects
 *    that the new pack holds, or that stayed unreachable for the grace, are deleted — loose ones
 *    one by one, packs only when every object in them may go.
 * A writer that may reuse old objects holds a lease (`withLease`): it writes the lease, then waits
 * while a sweep runs; the sweep writes its flag, then checks the leases — each checks after it
 * writes, so one of them sees the other.
 */
import type { FilesApi } from "@statewalker/webrun-files";
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
const SWEEP_TTL_MS = 10 * 60_000;
const DEFAULT_LEASE_MS = 10 * 60_000;

function access(repo: Repository): GcAccess {
  const a = repo.objects.gc;
  if (!a) throw new Error("this object store does not support gc");
  return a;
}

async function readText(files: FilesApi, path: string): Promise<string | undefined> {
  if (!(await files.exists(path))) return undefined;
  const parts: Uint8Array[] = [];
  for await (const c of files.read(path)) parts.push(c);
  return dec.decode(new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer()));
}
/** Written to a temporary name, then moved: a crash leaves the old content or the new. */
async function writeText(files: FilesApi, path: string, text: string) {
  const tmp = `${path}.tmp`;
  await files.write(tmp, [enc.encode(text)]);
  await files.move(tmp, path);
}
const newStats = (): GcStats => ({
  reachable: 0,
  packed: 0,
  removedLoose: 0,
  removedPacks: 0,
  keptUnreachable: 0,
});

/** git's roots: every ref, HEAD (also detached), every reflog entry; only ids present here. */
async function roots(repo: Repository): Promise<string[]> {
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
  const present: string[] = [];
  for (const id of out) if (await repo.objects.has(id)) present.push(id);
  return present;
}

async function mark(repo: Repository): Promise<ToSend[]> {
  const r = await roots(repo);
  if (!r.length) return [];
  return (await listObjectsWithEdges(repo, r, [])).objects;
}

const paths = (dir: string) => ({
  state: `${dir}/state.json`,
  loose: `${dir}/snapshot-loose`,
  reachable: `${dir}/reachable`,
  ledger: `${dir}/ledger.json`,
  leases: `${dir}/leases`,
  sweeping: `${dir}/sweeping`,
});

async function liveLeases(files: FilesApi, dir: string): Promise<number> {
  if (!(await files.exists(dir))) return 0;
  let n = 0;
  for await (const e of files.list(dir)) {
    const p = (e as { path: string }).path;
    const text = await readText(files, p).catch(() => undefined);
    const expires = text ? Number(JSON.parse(text).expires) : 0;
    if (expires > Date.now()) n++;
    else await files.remove(p).catch(() => false); // an expired lease (its holder crashed)
  }
  return n;
}

export async function gcStep(repo: Repository, opts: GcOptions = {}): Promise<GcStep> {
  const a = access(repo);
  const p = paths(a.dir);
  const now = opts.now ?? Date.now;
  const graceMs = opts.graceMs ?? 14 * 24 * 3600_000;
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
      // --- snapshot
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
      const objects = await mark(repo);
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
      const reachable = await reachableSet(a, s);
      const ledger: Record<string, number> = JSON.parse(
        (await readText(a.files, p.ledger)) ?? "{}",
      );
      const t = now();
      const snapshot = await snapshotIds(a, p, s);
      for (const id of Object.keys(ledger)) if (!snapshot.has(id)) delete ledger[id];
      for (const id of snapshot) {
        if (reachable.has(id)) delete ledger[id];
        else ledger[id] ??= t;
      }
      await writeText(a.files, p.ledger, JSON.stringify(ledger));
      await save({ ...s, phase: "sweep" });
      await after("ledger");
    } else if (s.phase === "sweep") {
      // the flag first, then the leases (a writer writes its lease, then reads the flag)
      await writeText(a.files, p.sweeping, JSON.stringify({ expires: Date.now() + SWEEP_TTL_MS }));
      try {
        if (await liveLeases(a.files, p.leases))
          return { phase: "sweep", done: false, deferred: true, stats: s.stats };
        await opts.duringSweep?.();
        const ledger: Record<string, number> = JSON.parse(
          (await readText(a.files, p.ledger)) ?? "{}",
        );
        // walked again: a ref moved during gc keeps what it now reaches
        const reachableNow = new Set((await mark(repo)).map((o) => o.oid));
        const inNewPack = new Set<string>();
        if (s.newPack)
          for (const r of a.packs())
            if (r.packId === s.newPack) for (const id of r.ids()) inNewPack.add(id);
        const t = now();
        const deletable = (id: string) =>
          inNewPack.has(id) ||
          (!reachableNow.has(id) &&
            ledger[id] !== undefined &&
            (ledger[id] as number) + graceMs <= t);
        const stats = { ...s.stats };
        const kept = new Set<string>();
        const loose = ((await readText(a.files, p.loose)) ?? "").split("\n").filter(Boolean);
        for (const id of loose) {
          if (deletable(id)) {
            await a.removeLoose(id).catch(() => {});
            stats.removedLoose++;
          } else if (!reachableNow.has(id)) kept.add(id);
        }
        const doomed: string[] = [];
        for (const r of a.packs()) {
          if (r.packId === s.newPack || !s.packs.includes(r.packId)) continue;
          let all = true;
          for (const id of r.ids())
            if (!deletable(id)) {
              all = false;
              if (!reachableNow.has(id)) kept.add(id);
            }
          if (all) doomed.push(r.packId);
        }
        if (doomed.length) await a.removePacks(doomed);
        stats.removedPacks = doomed.length;
        stats.keptUnreachable = kept.size;
        for (const f of [p.loose, p.reachable]) await a.files.remove(f).catch(() => false);
        await a.files.remove(p.state);
        state = undefined;
        await after("sweep");
        return { phase: "done", done: true, stats };
      } finally {
        await a.files.remove(p.sweeping).catch(() => false);
      }
    }
  }
  return { phase: state?.phase ?? "snapshot", done: false, stats: state?.stats ?? newStats() };
}

async function reachableSet(a: GcAccess, s: GcState): Promise<Set<string>> {
  const p = paths(a.dir);
  const text = (await readText(a.files, p.reachable)) ?? "";
  const set = new Set<string>(
    text ? text.split("\n").map((l) => (JSON.parse(l) as ToSend).oid) : [],
  );
  void s;
  return set;
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

/** Runs the steps until gc is done, or deferred by a live lease. */
export async function gc(repo: Repository, opts: GcOptions = {}): Promise<GcStep> {
  for (;;) {
    const s = await gcStep(repo, { ...opts, units: 1 });
    if (s.done || s.deferred) return s;
  }
}

/** Runs `fn` holding a lease: a running sweep is waited for; a sweep starting meanwhile defers. */
export async function withLease<T>(
  repo: Repository,
  fn: () => Promise<T>,
  opts: { ttlMs?: number } = {},
): Promise<T> {
  const a = access(repo);
  const p = paths(a.dir);
  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const lease = `${p.leases}/${id}.json`;
  await writeText(
    a.files,
    lease,
    JSON.stringify({ expires: Date.now() + (opts.ttlMs ?? DEFAULT_LEASE_MS) }),
  );
  try {
    // the lease first, then the flag: a sweep running now has not seen this lease
    for (;;) {
      const flag = await readText(a.files, p.sweeping).catch(() => undefined);
      if (!flag || Number(JSON.parse(flag).expires) <= Date.now()) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    return await fn();
  } finally {
    await a.files.remove(lease).catch(() => false);
  }
}
