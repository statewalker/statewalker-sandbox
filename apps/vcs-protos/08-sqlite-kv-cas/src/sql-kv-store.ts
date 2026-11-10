/**
 * X3a — webrun-storage KvStore over statewalker-db's Db (node:sqlite, sqlite-wasm, Durable Objects).
 *
 * Every write is ONE statement, and compare-and-set reads its outcome from RETURNING (Db exposes no
 * change counts, and Durable Objects forbid BEGIN/PRAGMA):
 *   create  INSERT … ON CONFLICT(key) DO NOTHING RETURNING key
 *   update  UPDATE … SET value = ? WHERE key = ? AND value = ? RETURNING key
 *   delete  DELETE … WHERE key = ? AND value = ? RETURNING key
 * SQLite runs each statement atomically, so a returned row means this caller's write happened.
 */
import type { Db } from "@statewalker/db-api";
import type { KvStore } from "@statewalker/webrun-storage";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v.slice();
  if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
  throw new Error(`kv value is not a BLOB (${typeof v})`);
}

export async function sqlKvStore(db: Db, table = "kv"): Promise<KvStore> {
  if (!IDENT.test(table)) throw new Error(`invalid table name ${table}`);
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY NOT NULL, value BLOB NOT NULL) WITHOUT ROWID`,
  );
  return {
    async get(key) {
      const rows = await db.query<{ value: unknown }>(`SELECT value FROM ${table} WHERE key = ?`, [
        key,
      ]);
      return rows[0] ? toBytes(rows[0].value) : undefined;
    },
    async put(key, value) {
      await db.query(
        `INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, value],
      );
    },
    async cas(key, expected, next) {
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
      const rows = await db.query(`DELETE FROM ${table} WHERE key = ? RETURNING key`, [key]);
      return rows.length === 1;
    },
    async *list(prefix) {
      // BINARY collation compares UTF-8 bytes, i.e. code-point order (webrun-files' list order).
      const rows =
        prefix === undefined || prefix === ""
          ? await db.query<{ key: string; value: unknown }>(
              `SELECT key, value FROM ${table} ORDER BY key`,
            )
          : await db.query<{ key: string; value: unknown }>(
              `SELECT key, value FROM ${table} WHERE substr(key, 1, length(?1)) = ?1 ORDER BY key`,
              [prefix],
            );
      for (const r of rows) yield { key: r.key, value: toBytes(r.value) };
    },
  };
}
