/**
 * Backend-independent batch validation, as `git update-ref --stdin` applies it (checked against
 * git 2.43): names must be valid; a ref may appear once; a batch may not touch a ref and a ref
 * below it (`refs/z` and `refs/z/w`); a create may not go below an existing ref or above existing
 * refs — even when the same batch deletes the blocking ref.
 */
import type { RefCommand, RejectReason } from "./ref-db.js";
import { checkRefFormat } from "./refname.js";

/** Names a batch may touch: `HEAD`, or a valid name under `refs/`. */
export function isUpdatableName(name: string): boolean {
  return name === "HEAD" || (name.startsWith("refs/") && checkRefFormat(name));
}

type Rejections = { name: string; reason: RejectReason }[];

/**
 * Name checks, duplicates and malformed commands; run before dereferencing symbolic refs.
 * A delete whose expected old value is "must not exist" is refused, as `git update-ref --stdin`
 * refuses `delete <ref> <zero-oid>`.
 */
export function checkNames(commands: RefCommand[]): Rejections {
  const out: Rejections = [];
  const seen = new Set<string>();
  for (const c of commands) {
    if (!isUpdatableName(c.name)) out.push({ name: c.name, reason: "invalid-name" });
    else if (seen.has(c.name)) out.push({ name: c.name, reason: "duplicate" });
    else if (c.new === null && c.old === null)
      out.push({ name: c.name, reason: "invalid-command" });
    seen.add(c.name);
  }
  return out;
}

/** A dereferenced command: `name` is the final target, `orig` what the caller named. */
export type Deref = RefCommand & { orig: string; via: string[] };

/**
 * A name outside refs/ (a detached HEAD) cannot join a multi-ref batch: on git files it would have
 * to be committed outside packed-refs, so not atomically with the rest. Refused on every backend
 * so that all behave alike; alone it is a plain loose update.
 */
export function checkAtomic(cmds: Deref[]): Rejections {
  if (cmds.length < 2) return [];
  return cmds
    .filter((c) => !c.name.startsWith("refs/"))
    .map((c) => ({ name: c.orig, reason: "not-atomic" as const }));
}

/** git logs HEAD for an update of the branch HEAD points at, even when named directly. */
export function addHeadLogs(cmds: Deref[], headTarget: string | undefined): void {
  if (!headTarget) return;
  for (const c of cmds) if (c.name === headTarget && !c.via.includes("HEAD")) c.via.push("HEAD");
}

/** git's reflog message: whitespace runs collapsed to one space, trimmed (refs.c copy_reflog_msg). */
export function normalizeMessage(message: string | undefined): string {
  return (message ?? "").replace(/\s+/g, " ").trim();
}

/** Proper ancestors that could be refs: `refs/a/b/c` → `refs/a`, `refs/a/b`. */
function ancestors(name: string): string[] {
  const parts = name.split("/");
  const out: string[] = [];
  for (let i = 2; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/**
 * Checks after dereferencing (`commands` name their final targets): duplicates again (HEAD and its
 * target), parent + child in one batch, and creates that conflict with existing refs.
 */
export async function checkBatch(
  commands: RefCommand[],
  exists: (name: string) => Promise<boolean>,
  hasChildren: (name: string) => Promise<boolean>,
): Promise<Rejections> {
  const out: Rejections = [];
  const names = new Set<string>();
  for (const c of commands) {
    if (names.has(c.name)) out.push({ name: c.name, reason: "duplicate" });
    names.add(c.name);
  }
  for (const c of commands) {
    if (ancestors(c.name).some((a) => names.has(a)))
      out.push({ name: c.name, reason: "df-conflict" });
  }
  if (out.length) return out;
  for (const c of commands) {
    if (c.new === null || (await exists(c.name))) continue; // only creates can conflict
    for (const a of ancestors(c.name)) {
      if (await exists(a)) {
        out.push({ name: c.name, reason: "df-conflict" });
        break;
      }
    }
    if (!out.some((x) => x.name === c.name) && (await hasChildren(c.name))) {
      out.push({ name: c.name, reason: "df-conflict" });
    }
  }
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const defaultIdent = () =>
  `webrun-vcs <vcs@localhost> ${Math.floor(Date.now() / 1000)} +0000`;
