/**
 * X3a — webrun-storage KvStore over statewalker-db's Db (node:sqlite, sqlite-wasm, Durable Objects).
 *
 * Every write is ONE statement, and compare-and-set reads its outcome from RETURNING (Db exposes no
 * change counts, and Durable Objects forbid BEGIN/PRAGMA):
 *   create  INSERT … ON CONFLICT(key) DO NOTHING RETURNING key
 *   update  UPDATE … SET value = ? WHERE key = ? AND value = ? RETURNING key
 *   delete  DELETE … WHERE key = ? AND value = ? RETURNING key
 * SQLite runs each statement atomically, so a returned row means this caller's write happened.
 * (Inside a Durable Object the stronger guarantee is request serialisation; the single statement is
 * what keeps the same code correct on node:sqlite and sqlite-wasm, where callers can interleave.)
 *
 * Keys must be valid Unicode text without NUL: SQLite truncates TEXT at NUL in some paths and lone
 * surrogates are not representable in UTF-8, so such keys would silently alias. They are rejected.
 */
import type { Db } from "@statewalker/db-api";
import type { KvStore } from "@statewalker/webrun-storage";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v.slice();
  if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
  throw new Error(`kv value is not a BLOB (${typeof v})`);
}

/** Rejects keys that SQLite TEXT cannot store faithfully (NUL, lone UTF-16 surrogates). */
export function validateKey(key: string): string {
  if (typeof key !== "string") throw new Error(`kv key must be a string (${typeof key})`);
  if (key.includes("\u0000")) throw new Error("kv key contains NUL");
  if (!key.isWellFormed()) throw new Error("kv key contains a lone surrogate");
  return key;
}

/**
 * Smallest string greater than every string starting with `prefix`, in code-point order, or
 * undefined when none exists (the prefix is all U+10FFFF). Skips the surrogate range.
 */
export function prefixSuccessor(prefix: string): string | undefined {
  const cps = Array.from(prefix, (c) => c.codePointAt(0) as number);
  while (cps.length > 0) {
    let last = (cps.pop() as number) + 1;
    if (last === 0xd800) last = 0xe000;
    if (last <= 0x10ffff) return String.fromCodePoint(...cps, last);
  }
  return undefined;
}

export async function sqlKvStore(db: Db, table = "kv"): Promise<KvStore> {
  if (!IDENT.test(table)) throw new Error(`invalid table name ${table}`);
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY NOT NULL, value BLOB NOT NULL CHECK (typeof(value) = 'blob')) WITHOUT ROWID`,
  );
  return {
    async get(key) {
      validateKey(key);
      const rows = await db.query<{ value: unknown }>(`SELECT value FROM ${table} WHERE key = ?`, [
        key,
      ]);
      return rows[0] ? toBytes(rows[0].value) : undefined;
    },
    async put(key, value) {
      validateKey(key);
      await db.query(
        `INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, value],
      );
    },
    async cas(key, expected, next) {
      validateKey(key);
      let rows: unknown[];
      if (expected === undefined && next === undefined) {
        rows = await db.query(`SELECT key FROM ${table} WHERE key = ?`, [key]);
        return rows.length === 0; // "absent → absent" holds iff the key is absent
      } else if (expected === undefined) {
        rows = await db.query(
          `INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING RETURNING key`,
          [key, next],
        );
      } else if (next === undefined) {
        rows = await db.query(`DELETE FROM ${table} WHERE key = ? AND value = ? RETURNING key`, [
          key,
          expected,
        ]);
      } else {
        rows = await db.query(
          `UPDATE ${table} SET value = ? WHERE key = ? AND value = ? RETURNING key`,
          [next, key, expected],
        );
      }
      return rows.length === 1;
    },
    async remove(key) {
      validateKey(key);
      const rows = await db.query(`DELETE FROM ${table} WHERE key = ? RETURNING key`, [key]);
      return rows.length === 1;
    },
    async *list(prefix) {
      // BINARY collation compares UTF-8 bytes, i.e. code-point order (webrun-files' list order).
      // A range scan uses the primary key and treats %, _ and every code point literally.
      const lo = prefix === undefined ? "" : validateKey(prefix);
      const hi = lo === "" ? undefined : prefixSuccessor(lo);
      const rows =
        hi === undefined
          ? await db.query<{ key: string; value: unknown }>(
              `SELECT key, value FROM ${table} WHERE key >= ? ORDER BY key`,
              [lo],
            )
          : await db.query<{ key: string; value: unknown }>(
              `SELECT key, value FROM ${table} WHERE key >= ? AND key < ? ORDER BY key`,
              [lo, hi],
            );
      for (const r of rows) yield { key: r.key, value: toBytes(r.value) };
    },
  };
}
