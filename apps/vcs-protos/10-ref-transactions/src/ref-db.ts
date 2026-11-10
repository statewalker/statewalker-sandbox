/** X5 — the ref-transaction API every backend implements. */

export const ZERO_OID = "0".repeat(40);

export type RefValue = { oid: string } | { symref: string };

/**
 * One command of a batch. `old`: undefined = do not check, null = must not exist, an id = must
 * equal. `new`: an id, or null to delete.
 */
export interface RefCommand {
  name: string;
  old?: string | null;
  new: string | null;
}

export type RejectReason =
  | "mismatch"
  | "locked"
  | "invalid-name"
  | "df-conflict"
  | "duplicate"
  /** e.g. a delete whose old value says "must not exist" (git: "zero <oldvalue>") */
  | "invalid-command"
  /** a name outside refs/ (a detached HEAD) in a multi-ref batch */
  | "not-atomic";

export interface BatchResult {
  ok: boolean;
  rejected: { name: string; reason: RejectReason }[];
}

export interface ReflogEntry {
  old: string;
  new: string;
  ident: string;
  message: string;
}

export interface BatchOptions {
  /** git identity with time: "Name <email> 1700000000 +0000" */
  ident?: string;
  message?: string;
}

export interface RefDb {
  read(name: string): Promise<RefValue | undefined>;
  /** Follows symbolic refs (at most 5 levels, as git) to an id. */
  resolve(name: string): Promise<string | undefined>;
  /** Direct refs under `prefix`, sorted by name (symbolic refs excluded). */
  list(prefix?: string): AsyncIterable<{ name: string; oid: string }>;
  /** All-or-nothing. Commands naming a symbolic ref apply to its target. */
  batch(commands: RefCommand[], opts?: BatchOptions): Promise<BatchResult>;
  /** Point `name` at `target`. `expected`: undefined = no check, null = must not exist. */
  setSymref(name: string, target: string, expected?: string | null): Promise<boolean>;
  reflog(name: string): Promise<ReflogEntry[]>;
}
