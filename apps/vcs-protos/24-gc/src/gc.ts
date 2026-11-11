/** X18 — safe gc — red stub. */
import type { Repository } from "../../17-repository/src/object-store.js";
export type GcPhase = "snapshot" | "mark" | "repack" | "ledger" | "sweep" | "done";
export interface GcStats {
  reachable: number;
  packed: number;
  removedLoose: number;
  removedPacks: number;
  keptUnreachable: number;
}
export interface GcOptions {
  /** unreachable objects are deleted after this long. Default 14 days. */
  graceMs?: number;
  now?: () => number;
  /** phases per call (gcStep). Default: all. */
  units?: number;
  /** tests: called after each phase (a concurrent writer, a crash) */
  afterPhase?: (phase: GcPhase) => Promise<void>;
  /** tests: called inside the sweep, after its flag is set and the leases checked, before deleting */
  duringSweep?: () => Promise<void>;
}
export interface GcStep {
  phase: GcPhase;
  done: boolean;
  deferred?: boolean;
  stats: GcStats;
}
export async function gcStep(_repo: Repository, _opts: GcOptions = {}): Promise<GcStep> {
  throw new Error("not implemented");
}
export async function gc(_repo: Repository, _opts: GcOptions = {}): Promise<GcStep> {
  throw new Error("not implemented");
}
/** Runs `fn` holding a lease (gc's sweep waits for it; it waits for a running sweep). */
export async function withLease<T>(
  _repo: Repository,
  _fn: () => Promise<T>,
  _opts: { ttlMs?: number; roots?: string[] } = {},
): Promise<T> {
  throw new Error("not implemented");
}
