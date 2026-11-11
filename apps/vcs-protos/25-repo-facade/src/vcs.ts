/** X16b — the repository façade — red stub. */
import type { Db } from "@statewalker/db-api";
import type { FilesApi } from "@statewalker/webrun-files";
import type { RefFiles } from "../../10-ref-transactions/src/files-ref-db.js";
import type { RefCommand } from "../../10-ref-transactions/src/ref-db.js";
import type { Person } from "../../17-repository/src/git-format.js";
import type { Repository } from "../../17-repository/src/object-store.js";

export type VcsErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "CORRUPT"
  | "PROTOCOL"
  | "ABORTED"
  | "LIMIT"
  | "UNSUPPORTED"
  | "LOCKED"
  | "INVALID";

export class VcsError extends Error {
  override name = "VcsError";
  constructor(
    readonly code: VcsErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
export function toVcsError(_e: unknown): VcsError {
  throw new Error("not implemented");
}

export interface RefUpdate {
  name: string;
  old: string | null;
  new: string | null;
}
export interface Hooks {
  /** git's reference-transaction hook: a string refuses (at "prepared") */
  referenceTransaction?: (
    state: "prepared" | "committed" | "aborted",
    updates: RefUpdate[],
  ) => Promise<string | undefined>;
  /** a string refuses the commit */
  preCommit?: (info: { ref: string; tree: string }) => Promise<string | undefined>;
  /** may return a new message, or throw to refuse */
  commitMsg?: (message: string) => Promise<string | undefined>;
  postCommit?: (oid: string) => Promise<void>;
}

export interface Config {
  get(key: string): string | undefined;
  getAll(key: string): string[];
  set(key: string, value: string): Promise<void>;
  /** the file's text as stored */
  text(): string;
}

export interface CommitOptions {
  ref?: string;
  files?: Record<string, Uint8Array>;
  tree?: string;
  parents?: string[];
  message: string;
  author?: Person;
  signal?: AbortSignal;
}

export interface Vcs {
  /** the underlying repository; its refs run the hooks */
  repo: Repository;
  config: Config;
  commit(opts: CommitOptions): Promise<string>;
  log(ref: string): Promise<string[]>;
  updateRefs(commands: RefCommand[], opts?: { signal?: AbortSignal }): Promise<void>;
  fetch(
    url: string,
    opts?: { refspecs?: string[]; signal?: AbortSignal; fetch?: typeof fetch },
  ): Promise<void>;
  push(
    url: string,
    opts: { refspecs: string[]; signal?: AbortSignal; fetch?: typeof fetch },
  ): Promise<{ ref: string; ok: boolean; reason?: string }[]>;
  gc(opts?: { graceMs?: number; signal?: AbortSignal }): Promise<void>;
  installPack(source: AsyncIterable<Uint8Array>, opts?: { signal?: AbortSignal }): Promise<string>;
  /** git's smart HTTP for this repository (hooks and gc leases on received pushes) */
  serve(): (req: Request) => Promise<Response>;
}

export interface OpenOptions {
  init?: boolean;
  defaultBranch?: string;
  hooks?: Hooks;
  /** used when a commit names no author and the config has no user.name/user.email */
  identity?: { name: string; email: string };
  maxPackSize?: number;
  now?: () => number;
}

export async function openRepository(
  _spec: { files: FilesApi; refFiles: RefFiles } | { db: Db },
  _opts: OpenOptions = {},
): Promise<Vcs> {
  throw new Error("not implemented");
}
