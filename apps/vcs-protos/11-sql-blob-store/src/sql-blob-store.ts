/**
 * X3b — a native chunked BlobStore with putStaged over statewalker-db's Db.
 *
 *   <p>blobs  (id PRIMARY KEY, size, chunk_size, inline)   a blob is visible iff its row exists
 *   <p>chunks (id, seq, data, PRIMARY KEY (id, seq))        rows of `chunk_size` bytes (last shorter)
 *
 * Content up to one chunk is buffered and stored inline in the blob row: one row and one commit
 * per small git object. Larger content streams into chunk rows under a reserved temporary id
 * (`~tmp/<ms>/<random>`, never visible) holding at most one chunk in memory, then commits in ONE
 * transaction (`inTransaction`: BEGIN/COMMIT, or storage.transaction in a Durable Object): if the
 * id exists the temporary rows are dropped (existing wins); otherwise the rows are renamed to the
 * id and the blob row inserted — or, for a single chunk, the bytes move inline. A crash at any
 * statement leaves no blob or the whole blob; `sweepStaged` removes orphaned temporary rows.
 * Each statement binds at most a few parameters and one chunk (< the DO's ~2 MB value limit).
 */
import type { Db } from "@statewalker/db-api";
import { inTransaction } from "@statewalker/db-sqlite";
import type { ByteStream } from "@statewalker/webrun-storage";
import type { StagingBlobStore } from "../../09-git-objects/src/staging.js";

export interface SqlBlobStoreOptions {
  /** Table name prefix (a plain identifier). Default "blob_". */
  prefix?: string;
  /** Bytes per chunk row; content up to this size is stored inline. Default 1 MiB (DO limit ~2 MB). */
  chunkSize?: number;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TMP = "~tmp/";
const TMP_END = "~tmp0"; // '0' follows '/': every temporary id lies in [TMP, TMP_END)

const toBytes = (v: unknown): Uint8Array => {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (v === null || v === undefined) return new Uint8Array(0);
  throw new Error(`not a BLOB: ${typeof v}`);
};
/** Smallest string above every string starting with `p` (code-point order). */
function successor(p: string): string | undefined {
  const cps = Array.from(p, (c) => c.codePointAt(0) as number);
  while (cps.length) {
    let last = (cps.pop() as number) + 1;
    if (last === 0xd800) last = 0xe000;
    if (last <= 0x10ffff) return String.fromCodePoint(...cps, last);
  }
  return undefined;
}
const tmpId = () => {
  const r = crypto.getRandomValues(new Uint8Array(9));
  return `${TMP}${Date.now()}/${Array.from(r, (b) => b.toString(16).padStart(2, "0")).join("")}`;
};

interface BlobRow {
  size: number;
  chunk_size: number;
  inline: unknown;
  chunked: number;
}

export async function sqlBlobStore(
  db: Db,
  opts: SqlBlobStoreOptions = {},
): Promise<StagingBlobStore> {
  const prefix = opts.prefix ?? "blob_";
  if (!IDENT.test(prefix)) throw new Error(`invalid table prefix ${prefix}`);
  const chunkSize = opts.chunkSize ?? 2 ** 20;
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 1_900_000) {
    throw new Error(`chunkSize must be an integer from 1 to 1900000, got ${chunkSize}`);
  }
  const blobs = `${prefix}blobs`;
  const chunks = `${prefix}chunks`;
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${blobs} (id TEXT PRIMARY KEY NOT NULL, size INTEGER NOT NULL,
       chunk_size INTEGER NOT NULL, chunked INTEGER NOT NULL, inline BLOB) WITHOUT ROWID`,
  );
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${chunks} (id TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL,
       PRIMARY KEY (id, seq)) WITHOUT ROWID`,
  );

  const checkId = (id: string) => {
    if (typeof id !== "string" || id.length === 0 || id.startsWith(TMP))
      throw new Error(`invalid blob id ${id}`);
  };
  const row = async (id: string) =>
    (
      await db.query<BlobRow>(
        `SELECT size, chunk_size, chunked, inline FROM ${blobs} WHERE id = ?`,
        [id],
      )
    )[0];

  type Staged =
    | { kind: "inline"; data: Uint8Array }
    | { kind: "rows"; tmp: string; size: number; rows: number };
  /**
   * Content up to one chunk stays in memory and is committed inline in one transaction (JGit's
   * small-object path: one commit, no temporary rows). Beyond that it streams into chunk rows under
   * a fresh temporary id, holding one chunk in memory.
   */
  async function stage(bytes: ByteStream): Promise<Staged> {
    let tmp: string | undefined;
    let buf = new Uint8Array(chunkSize);
    let fill = 0;
    let size = 0;
    let rows = 0;
    const flush = async () => {
      if (fill === 0) return;
      tmp ??= tmpId();
      // copy exactly the used part: never bind a view of a larger or zero-length buffer
      await db.query(`INSERT INTO ${chunks} (id, seq, data) VALUES (?, ?, ?)`, [
        tmp,
        rows++,
        buf.slice(0, fill),
      ]);
      buf = new Uint8Array(chunkSize);
      fill = 0;
    };
    try {
      for await (const c of bytes) {
        let off = 0;
        while (off < c.length) {
          if (fill === chunkSize) await flush(); // spill only once more bytes arrive
          const n = Math.min(chunkSize - fill, c.length - off);
          buf.set(c.subarray(off, off + n), fill);
          fill += n;
          off += n;
          size += n;
        }
      }
      if (tmp === undefined) return { kind: "inline", data: buf.slice(0, fill) };
      await flush();
      return { kind: "rows", tmp, size, rows };
    } catch (e) {
      if (tmp !== undefined)
        await db.query(`DELETE FROM ${chunks} WHERE id = ?`, [tmp]).catch(() => {});
      throw e;
    }
  }
  const drop = async (st: Staged) => {
    if (st.kind === "rows")
      await db.query(`DELETE FROM ${chunks} WHERE id = ?`, [st.tmp]).catch(() => {});
  };
  async function* readStaged(st: Staged) {
    if (st.kind === "inline") yield st.data;
    else yield* readRows(st.tmp, 0, st.rows - 1);
  }
  /** One transaction: existing wins; else insert inline, or rename the rows to the id. */
  async function commit(st: Staged, id: string): Promise<boolean> {
    return inTransaction(db, async (tx) => {
      const exists = (await tx.query(`SELECT 1 FROM ${blobs} WHERE id = ?`, [id])).length > 0;
      if (exists) {
        if (st.kind === "rows") await tx.query(`DELETE FROM ${chunks} WHERE id = ?`, [st.tmp]);
        return false;
      }
      if (st.kind === "inline") {
        // size 0 stores NULL (some bindings turn zero-length views into NULL anyway)
        await tx.query(
          `INSERT INTO ${blobs} (id, size, chunk_size, chunked, inline) VALUES (?, ?, ?, 0, ?)`,
          [id, st.data.length, chunkSize, st.data.length === 0 ? null : st.data],
        );
      } else {
        await tx.query(`UPDATE ${chunks} SET id = ? WHERE id = ?`, [id, st.tmp]);
        await tx.query(
          `INSERT INTO ${blobs} (id, size, chunk_size, chunked, inline) VALUES (?, ?, ?, 1, NULL)`,
          [id, st.size, chunkSize],
        );
      }
      return true;
    });
  }
  async function* readRows(id: string, from: number, to: number) {
    // one row per query: at most one chunk in memory, whatever the blob size
    for (let seq = from; seq <= to; seq++) {
      const [r] = await db.query<{ data: unknown }>(
        `SELECT data FROM ${chunks} WHERE id = ? AND seq = ?`,
        [id, seq],
      );
      if (!r) throw new Error(`blob ${id}: chunk ${seq} missing`);
      yield toBytes(r.data);
    }
  }

  const store: StagingBlobStore = {
    async putStaged(bytes, idOf) {
      const st = await stage(bytes);
      try {
        const id = await idOf();
        checkId(id);
        return { id, stored: await commit(st, id) };
      } catch (e) {
        await drop(st);
        throw e;
      }
    },
    async put(id, bytes, o) {
      checkId(id);
      const st = await stage(bytes);
      try {
        if (o?.verify) {
          // verify reads the staged copy back: bounded memory, one more pass over storage
          const computed = await o.verify(readStaged(st));
          if (computed !== id)
            throw new Error(`blob id mismatch: supplied "${id}", verify computed "${computed}"`);
        }
        await commit(st, id);
      } catch (e) {
        await drop(st);
        throw e;
      }
    },
    async *get(id, range) {
      const r = await row(id);
      if (!r) return;
      const start = Math.max(0, Math.min(range?.start ?? 0, r.size));
      const end = Math.max(start, Math.min(range?.end ?? r.size, r.size));
      if (start === end) return;
      if (!r.chunked) {
        yield toBytes(r.inline).slice(start, end);
        return;
      }
      const cs = r.chunk_size;
      const first = Math.floor(start / cs);
      const last = Math.floor((end - 1) / cs);
      let seq = first;
      for await (const data of readRows(id, first, last)) {
        const base = seq * cs;
        seq++;
        const a = Math.max(0, start - base);
        const b = Math.min(data.length, end - base);
        yield a === 0 && b === data.length ? data : data.subarray(a, b);
      }
    },
    async has(id) {
      return (await db.query(`SELECT 1 FROM ${blobs} WHERE id = ?`, [id])).length > 0;
    },
    async size(id) {
      return (await row(id))?.size ?? -1;
    },
    async remove(id) {
      return inTransaction(db, async (tx) => {
        const had = (await tx.query(`SELECT 1 FROM ${blobs} WHERE id = ?`, [id])).length > 0;
        if (!had) return false;
        await tx.query(`DELETE FROM ${chunks} WHERE id = ?`, [id]);
        await tx.query(`DELETE FROM ${blobs} WHERE id = ?`, [id]);
        return true;
      });
    },
    async *list(p) {
      const lo = p ?? "";
      const hi = lo === "" ? undefined : successor(lo);
      const rows = hi
        ? await db.query<{ id: string }>(
            `SELECT id FROM ${blobs} WHERE id >= ? AND id < ? ORDER BY id`,
            [lo, hi],
          )
        : await db.query<{ id: string }>(`SELECT id FROM ${blobs} ORDER BY id`);
      for (const r of rows) yield r.id;
    },
    async sweepStaged(olderThanMs) {
      const cutoff = Date.now() - olderThanMs;
      const temps = await db.query<{ id: string }>(
        `SELECT DISTINCT id FROM ${chunks} WHERE id >= ? AND id < ?`,
        [TMP, TMP_END],
      );
      let n = 0;
      for (const { id } of temps) {
        const ms = Number(id.slice(TMP.length, id.indexOf("/", TMP.length)));
        if (!(ms <= cutoff)) continue;
        await db.query(`DELETE FROM ${chunks} WHERE id = ?`, [id]);
        n++;
      }
      return n;
    },
  };
  return store;
}
