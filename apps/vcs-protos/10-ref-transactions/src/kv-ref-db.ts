/**
 * X5 — KvStore backend. A KvStore has only single-key compare-and-set, so every ref lives in one
 * root value (sorted JSON `{ name: oid | "ref: target" }`) and a batch is one `cas` of that value:
 * read the snapshot, apply the batch, write it back only if the root is still the bytes read; on
 * a lost race re-read and re-check (other refs may have moved without touching ours). Reflogs live
 * under `<root>.log/<name>`, appended after the commit (not atomic with it). Simple and portable;
 * the cost is a root rewrite per batch and one value as large as all refs (R8 measures it).
 */
import type { KvStore } from "@statewalker/webrun-storage";
import { checkBatch, checkNames, defaultIdent, isUpdatableName } from "./batch-rules.js";
import type { BatchResult, RefCommand, RefDb, ReflogEntry, RefValue } from "./ref-db.js";
import { ZERO_OID } from "./ref-db.js";
import { compareRefNames } from "./refname.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
type Snapshot = Map<string, string>; // value: oid or "ref: target"

const decode = (b: Uint8Array | undefined): Snapshot =>
  b ? new Map(Object.entries(JSON.parse(dec.decode(b)) as Record<string, string>)) : new Map();
const encode = (m: Snapshot): Uint8Array => {
  const o: Record<string, string> = {};
  for (const k of [...m.keys()].sort(compareRefNames)) o[k] = m.get(k) as string;
  return enc.encode(JSON.stringify(o));
};
const toValue = (v: string | undefined): RefValue | undefined =>
  v === undefined ? undefined : v.startsWith("ref: ") ? { symref: v.slice(5) } : { oid: v };
const MAX_ATTEMPTS = 100;

function deref(m: Snapshot, name: string) {
  const via: string[] = [];
  let cur = name;
  for (let i = 0; i < 5; i++) {
    const v = m.get(cur);
    if (!v?.startsWith("ref: ")) return { target: cur, via };
    via.push(cur);
    cur = v.slice(5);
  }
  throw new Error(`symbolic ref ${name} nests too deeply`);
}

export function kvRefDb(kv: KvStore, root = "refs"): RefDb {
  const logKey = (name: string) => `${root}.log/${name}`;
  async function appendLog(name: string, e: ReflogEntry) {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const cur = await kv.get(logKey(name));
      const list = cur ? (JSON.parse(dec.decode(cur)) as ReflogEntry[]) : [];
      list.push(e);
      if (await kv.cas(logKey(name), cur, enc.encode(JSON.stringify(list)))) return;
    }
  }
  return {
    async read(name) {
      return toValue(decode(await kv.get(root)).get(name));
    },
    async resolve(name) {
      const m = decode(await kv.get(root));
      const v = toValue(m.get(deref(m, name).target));
      return v && "oid" in v ? v.oid : undefined;
    },
    async *list(prefix = "refs/") {
      const m = decode(await kv.get(root));
      for (const k of [...m.keys()].sort(compareRefNames)) {
        const v = m.get(k) as string;
        if (k.startsWith(prefix) && !v.startsWith("ref: ")) yield { name: k, oid: v };
      }
    },
    async batch(commands, o = {}): Promise<BatchResult> {
      const bad = checkNames(commands);
      if (bad.length) return { ok: false, rejected: bad };
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const bytes = await kv.get(root);
        const m = decode(bytes);
        const cmds: (RefCommand & { via: string[] })[] = [];
        for (const c of commands) {
          const { target, via } = deref(m, c.name);
          if (!isUpdatableName(target))
            return { ok: false, rejected: [{ name: c.name, reason: "invalid-name" }] };
          cmds.push({ ...c, name: target, via });
        }
        const conflicts = await checkBatch(
          cmds,
          async (n) => m.has(n),
          async (n) => [...m.keys()].some((k) => k.startsWith(`${n}/`)),
        );
        if (conflicts.length) return { ok: false, rejected: conflicts };
        const current = new Map(cmds.map((c) => [c.name, m.get(c.name)]));
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
        for (const c of cmds) {
          if (c.new === null) m.delete(c.name);
          else m.set(c.name, c.new);
        }
        if (!(await kv.cas(root, bytes, encode(m)))) continue; // lost the race: re-read, re-check
        const ident = o.ident ?? defaultIdent();
        const message = (o.message ?? "").replace(/\n/g, " ");
        for (const c of cmds) {
          if (c.new === null) {
            await kv.remove(logKey(c.name));
            continue;
          }
          for (const n of [c.name, ...c.via]) {
            await appendLog(n, {
              old: current.get(c.name) ?? ZERO_OID,
              new: c.new,
              ident,
              message,
            });
          }
        }
        return { ok: true, rejected: [] };
      }
      return {
        ok: false,
        rejected: commands.map((c) => ({ name: c.name, reason: "locked" as const })),
      };
    },
    async setSymref(name, target, expected) {
      if (!isUpdatableName(name) || !target.startsWith("refs/") || !isUpdatableName(target)) {
        throw new Error(`invalid symbolic ref ${name} -> ${target}`);
      }
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const bytes = await kv.get(root);
        const m = decode(bytes);
        const cur = toValue(m.get(name));
        if (expected === null && cur !== undefined) return false;
        if (typeof expected === "string" && !(cur && "symref" in cur && cur.symref === expected))
          return false;
        m.set(name, `ref: ${target}`);
        if (await kv.cas(root, bytes, encode(m))) return true;
      }
      return false;
    },
    async reflog(name) {
      const cur = await kv.get(logKey(name));
      return cur ? (JSON.parse(dec.decode(cur)) as ReflogEntry[]) : [];
    },
  };
}

/** Bytes of the root value holding `n` refs (for the DO value-limit check). */
export function snapshotSize(n: number): number {
  const m: Snapshot = new Map();
  for (let i = 0; i < n; i++) {
    m.set(
      `refs/heads/feature/branch-${String(i).padStart(6, "0")}`,
      i.toString(16).padStart(40, "0"),
    );
  }
  return encode(m).length;
}
