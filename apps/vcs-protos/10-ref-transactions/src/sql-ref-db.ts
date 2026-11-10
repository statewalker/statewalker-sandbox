/**
 * X5 — SQL backend over statewalker-db's Db. A batch is one `inTransaction` (BEGIN … COMMIT on
 * node:sqlite and sqlite-wasm, `storage.transaction` in a Durable Object): dereferencing, conflict
 * checks, comparisons, writes and reflog rows commit together or not at all. The callback has no
 * external I/O and is idempotent, as a Durable Object may run it more than once.
 */
import type { Db } from "@statewalker/db-api";
import { inTransaction } from "@statewalker/db-sqlite";
import { checkBatch, checkNames, defaultIdent, isUpdatableName } from "./batch-rules.js";
import type { BatchResult, RefCommand, RefDb, RefValue } from "./ref-db.js";
import { ZERO_OID } from "./ref-db.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
type Row = { oid: string | null; symref: string | null };

export async function sqlRefDb(db: Db, prefix = "refdb_"): Promise<RefDb> {
  if (!IDENT.test(prefix)) throw new Error(`invalid table prefix ${prefix}`);
  const refs = `${prefix}refs`;
  const logs = `${prefix}reflog`;
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${refs} (name TEXT PRIMARY KEY NOT NULL, oid TEXT, symref TEXT,
       CHECK ((oid IS NULL) <> (symref IS NULL))) WITHOUT ROWID`,
  );
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${logs} (seq INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
       old TEXT NOT NULL, new TEXT NOT NULL, ident TEXT NOT NULL, message TEXT NOT NULL)`,
  );
  await db.exec(`CREATE INDEX IF NOT EXISTS ${logs}_name ON ${logs}(name, seq)`);

  const readWith = async (q: Db, name: string): Promise<RefValue | undefined> => {
    const [r] = await q.query<Row>(`SELECT oid, symref FROM ${refs} WHERE name = ?`, [name]);
    if (!r) return undefined;
    return r.symref !== null ? { symref: r.symref } : { oid: r.oid as string };
  };
  const derefWith = async (q: Db, name: string) => {
    const via: string[] = [];
    let cur = name;
    for (let i = 0; i < 5; i++) {
      const v = await readWith(q, cur);
      if (!v || !("symref" in v)) return { target: cur, via };
      via.push(cur);
      cur = v.symref;
    }
    throw new Error(`symbolic ref ${name} nests too deeply`);
  };

  return {
    read: (name) => readWith(db, name),
    async resolve(name) {
      const { target } = await derefWith(db, name);
      const v = await readWith(db, target);
      return v && "oid" in v ? v.oid : undefined;
    },
    async *list(p = "refs/") {
      // BINARY collation = UTF-8 byte order = git's order.
      const rows = await db.query<{ name: string; oid: string }>(
        `SELECT name, oid FROM ${refs} WHERE oid IS NOT NULL AND substr(name, 1, length(?1)) = ?1 ORDER BY name`,
        [p],
      );
      yield* rows;
    },
    async batch(commands, o = {}) {
      const bad = checkNames(commands);
      if (bad.length) return { ok: false, rejected: bad };
      const ident = o.ident ?? defaultIdent();
      const message = (o.message ?? "").replace(/\n/g, " ");
      return inTransaction(db, async (tx): Promise<BatchResult> => {
        const cmds: (RefCommand & { via: string[] })[] = [];
        for (const c of commands) {
          const { target, via } = await derefWith(tx, c.name);
          if (!isUpdatableName(target))
            return { ok: false, rejected: [{ name: c.name, reason: "invalid-name" }] };
          cmds.push({ ...c, name: target, via });
        }
        const conflicts = await checkBatch(
          cmds,
          async (n) => (await readWith(tx, n)) !== undefined,
          async (n) =>
            (
              await tx.query(
                `SELECT 1 FROM ${refs} WHERE substr(name, 1, length(?1) + 1) = ?1 || '/' LIMIT 1`,
                [n],
              )
            ).length > 0,
        );
        if (conflicts.length) return { ok: false, rejected: conflicts };
        const current = new Map<string, string | undefined>();
        for (const c of cmds) {
          const v = await readWith(tx, c.name);
          current.set(c.name, v && "oid" in v ? v.oid : undefined);
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
        for (const c of cmds) {
          if (c.new === null) {
            await tx.query(`DELETE FROM ${refs} WHERE name = ?`, [c.name]);
            await tx.query(`DELETE FROM ${logs} WHERE name = ?`, [c.name]);
            continue;
          }
          await tx.query(
            `INSERT INTO ${refs} (name, oid, symref) VALUES (?, ?, NULL)
               ON CONFLICT(name) DO UPDATE SET oid = excluded.oid, symref = NULL`,
            [c.name, c.new],
          );
          for (const n of [c.name, ...c.via]) {
            await tx.query(
              `INSERT INTO ${logs} (name, old, new, ident, message) VALUES (?, ?, ?, ?, ?)`,
              [n, current.get(c.name) ?? ZERO_OID, c.new, ident, message],
            );
          }
        }
        return { ok: true, rejected: [] };
      });
    },
    async setSymref(name, target, expected) {
      if (!isUpdatableName(name) || !target.startsWith("refs/") || !isUpdatableName(target)) {
        throw new Error(`invalid symbolic ref ${name} -> ${target}`);
      }
      return inTransaction(db, async (tx) => {
        const cur = await readWith(tx, name);
        if (expected === null && cur !== undefined) return false;
        if (typeof expected === "string" && !(cur && "symref" in cur && cur.symref === expected))
          return false;
        await tx.query(
          `INSERT INTO ${refs} (name, oid, symref) VALUES (?, NULL, ?)
             ON CONFLICT(name) DO UPDATE SET oid = NULL, symref = excluded.symref`,
          [name, target],
        );
        return true;
      });
    },
    async reflog(name) {
      return db.query<{ old: string; new: string; ident: string; message: string }>(
        `SELECT old, new, ident, message FROM ${logs} WHERE name = ? ORDER BY seq`,
        [name],
      );
    },
  };
}
