/**
 * X3b — a native chunked BlobStore with putStaged over statewalker-db's Db.
 *
 *   <p>blobs   (id PRIMARY KEY, size, chunk_size, handle, inline)   visible iff the row exists
 *   <p>chunks  (handle, seq, data, PRIMARY KEY (handle, seq))       rows of chunk_size bytes
 *   <p>staging (handle INTEGER PRIMARY KEY AUTOINCREMENT, created)  handles of puts not committed
 *
 * AUTOINCREMENT matters: a plain INTEGER PRIMARY KEY reuses the largest deleted rowid, so a new
 * staging handle would collide with the chunk rows of a committed blob.
 *
 * Content up to one chunk is buffered and committed inline in the blob row: one statement and one
 * commit per small git object. Larger content streams into chunk rows under a fresh integer handle
 * (allocated in `staging`), holding at most about one chunk in memory. The commit is ONE
 * transaction (`inTransaction`: BEGIN/COMMIT, or storage.transaction in a Durable Object): if the id
 * exists the staged rows are dropped (existing wins); otherwise it checks that every staged row is
 * still there (a sweep by another process may have removed them), inserts the blob row pointing at
 * the handle and clears the staging row. Chunk rows are never rewritten: a handle is immutable, so a
 * reader holding an old handle can only find rows missing, never other bytes.
 *
 * Constraints: one Db (connection) per database file per thread — two connections on one file fail
 * with "database is locked" (busy timeout 0; a timeout would deadlock a single thread). `remove`
 * must not race readers of the same blob (gc needs leases, X18).
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

type Staged =
  | { kind: "inline"; data: Uint8Array }
  | { kind: "rows"; handle: number; size: number; rows: number };

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
  const staging = `${prefix}staging`;
  // rowid tables: rows up to a chunk would bloat a WITHOUT ROWID b-tree (SQLite advises < 1/20 page)
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${blobs} (id TEXT PRIMARY KEY NOT NULL, size INTEGER NOT NULL,
       chunk_size INTEGER NOT NULL, handle INTEGER, inline BLOB)`,
  );
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${chunks} (handle INTEGER NOT NULL, seq INTEGER NOT NULL,
       data BLOB NOT NULL, PRIMARY KEY (handle, seq))`,
  );
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${staging} (handle INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL)`,
  );

  /** Handles of puts in flight in this store instance: its own sweep never touches them. */
  const inFlight = new Set<number>();

  const checkId = (id: string) => {
    if (typeof id !== "string" || id.length === 0 || !id.isWellFormed())
      throw new Error(`invalid blob id ${JSON.stringify(id)}`);
  };
  type Row = { size: number; chunk_size: number; handle: number | null };
  const row = async (id: string) =>
    (await db.query<Row>(`SELECT size, chunk_size, handle FROM ${blobs} WHERE id = ?`, [id]))[0];

  /**
   * Content up to one chunk stays in memory as the pieces received (no chunk-sized buffer for a
   * small object) and commits inline. Once more than one chunk has arrived, one chunk-sized buffer
   * is filled and bound per row, then reused: every driver copies a bound BLOB (SQLITE_TRANSIENT
   * on node:sqlite, a slice for the DO, the wasm heap for sqlite-wasm), so memory stays at one chunk.
   */
  async function stage(bytes: ByteStream): Promise<Staged> {
    let pending: Uint8Array[] | undefined = [];
    let pendingLen = 0;
    let buf: Uint8Array | undefined;
    let fill = 0;
    let handle: number | undefined;
    let size = 0;
    let rows = 0;
    const flush = async (data: Uint8Array) => {
      if (handle === undefined) {
        const [h] = await db.query<{ handle: number }>(
          `INSERT INTO ${staging} (created) VALUES (?) RETURNING handle`,
          [Date.now()],
        );
        handle = Number(h?.handle);
        inFlight.add(handle);
      }
      await db.query(`INSERT INTO ${chunks} (handle, seq, data) VALUES (?, ?, ?)`, [
        handle,
        rows++,
        data,
      ]);
    };
    const append = async (c: Uint8Array) => {
      let off = 0;
      const b = buf as Uint8Array;
      while (off < c.length) {
        if (fill === chunkSize) {
          await flush(b);
          fill = 0;
        }
        const n = Math.min(chunkSize - fill, c.length - off);
        b.set(c.subarray(off, off + n), fill);
        fill += n;
        off += n;
      }
    };
    try {
      for await (const c of bytes) {
        if (c.length === 0) continue;
        size += c.length;
        if (pending) {
          pending.push(c.slice()); // the producer may reuse its buffer
          pendingLen += c.length;
          if (pendingLen <= chunkSize) continue;
          // more than one chunk: switch to the reusable row buffer
          buf = new Uint8Array(chunkSize);
          const queued = pending;
          pending = undefined;
          for (const q of queued) await append(q);
        } else {
          await append(c);
        }
      }
      if (pending) {
        const data = new Uint8Array(pendingLen);
        let o = 0;
        for (const q of pending) {
          data.set(q, o);
          o += q.length;
        }
        return { kind: "inline", data };
      }
      if (fill > 0) await flush((buf as Uint8Array).slice(0, fill));
      return { kind: "rows", handle: handle as number, size, rows };
    } catch (e) {
      if (handle !== undefined) await dropHandle(handle);
      throw e;
    }
  }
  async function dropHandle(handle: number) {
    inFlight.delete(handle);
    await db.query(`DELETE FROM ${chunks} WHERE handle = ?`, [handle]).catch(() => {});
    await db.query(`DELETE FROM ${staging} WHERE handle = ?`, [handle]).catch(() => {});
  }
  const drop = async (st: Staged) => {
    if (st.kind === "rows") await dropHandle(st.handle);
  };
  /** One transaction: existing wins; else insert inline, or verify the staged rows and point at them. */
  async function commit(st: Staged, id: string): Promise<boolean> {
    const stored = await inTransaction(db, async (tx) => {
      const exists = (await tx.query(`SELECT 1 FROM ${blobs} WHERE id = ?`, [id])).length > 0;
      if (exists) {
        if (st.kind === "rows") {
          await tx.query(`DELETE FROM ${chunks} WHERE handle = ?`, [st.handle]);
          await tx.query(`DELETE FROM ${staging} WHERE handle = ?`, [st.handle]);
        }
        return false;
      }
      if (st.kind === "inline") {
        // size 0 stores NULL (some bindings turn zero-length views into NULL anyway)
        await tx.query(
          `INSERT INTO ${blobs} (id, size, chunk_size, handle, inline) VALUES (?, ?, ?, NULL, ?)`,
          [id, st.data.length, chunkSize, st.data.length === 0 ? null : st.data],
        );
        return true;
      }
      const [s] = await tx.query<{ n: number; bytes: number; staged: number }>(
        `SELECT count(*) AS n, coalesce(sum(length(data)), 0) AS bytes,
                (SELECT count(*) FROM ${staging} WHERE handle = ?1) AS staged
           FROM ${chunks} WHERE handle = ?1`,
        [st.handle],
      );
      if (!s || Number(s.staged) !== 1 || Number(s.n) !== st.rows || Number(s.bytes) !== st.size) {
        throw new Error(`staged rows of ${id} were removed before the commit (swept?)`);
      }
      await tx.query(
        `INSERT INTO ${blobs} (id, size, chunk_size, handle, inline) VALUES (?, ?, ?, ?, NULL)`,
        [id, st.size, chunkSize, st.handle],
      );
      await tx.query(`DELETE FROM ${staging} WHERE handle = ?`, [st.handle]);
      return true;
    });
    if (st.kind === "rows") inFlight.delete(st.handle);
    return stored;
  }
  async function* readRows(handle: number, size: number, cs: number, from: number, to: number) {
    // one row per query: at most one chunk in memory, whatever the blob size
    for (let seq = from; seq <= to; seq++) {
      const [r] = await db.query<{ data: unknown }>(
        `SELECT data FROM ${chunks} WHERE handle = ? AND seq = ?`,
        [handle, seq],
      );
      const data = r ? toBytes(r.data) : undefined;
      const want = Math.min(cs, size - seq * cs);
      if (!data || data.length !== want)
        throw new Error(`blob chunk ${seq} of handle ${handle} missing or truncated`);
      yield data;
    }
  }
  async function* readStaged(st: Staged) {
    if (st.kind === "inline") yield st.data;
    else yield* readRows(st.handle, st.size, chunkSize, 0, st.rows - 1);
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
      if (!o?.verify && (await store.has(id))) return; // content-addressed: nothing to stage
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
      // one query: the inline column only here (size() and has() never read content)
      const [r] = await db.query<Row & { inline: unknown }>(
        `SELECT size, chunk_size, handle, inline FROM ${blobs} WHERE id = ?`,
        [id],
      );
      if (!r) return;
      const start = Math.max(0, Math.min(range?.start ?? 0, r.size));
      const end = Math.max(start, Math.min(range?.end ?? r.size, r.size));
      if (start === end) return;
      if (r.handle === null) {
        yield toBytes(r.inline).slice(start, end);
        return;
      }
      const cs = r.chunk_size;
      const first = Math.floor(start / cs);
      const last = Math.floor((end - 1) / cs);
      let seq = first;
      for await (const data of readRows(Number(r.handle), r.size, cs, first, last)) {
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
        const [r] = await tx.query<{ handle: number | null }>(
          `SELECT handle FROM ${blobs} WHERE id = ?`,
          [id],
        );
        if (!r) return false;
        if (r.handle !== null) await tx.query(`DELETE FROM ${chunks} WHERE handle = ?`, [r.handle]);
        await tx.query(`DELETE FROM ${blobs} WHERE id = ?`, [id]);
        return true;
      });
    },
    async *list(p) {
      const lo = p ?? "";
      const hi = lo === "" ? undefined : successor(lo);
      const rows =
        hi !== undefined
          ? await db.query<{ id: string }>(
              `SELECT id FROM ${blobs} WHERE id >= ? AND id < ? ORDER BY id`,
              [lo, hi],
            )
          : await db.query<{ id: string }>(`SELECT id FROM ${blobs} WHERE id >= ? ORDER BY id`, [
              lo,
            ]);
      for (const r of rows) yield r.id;
    },
    async sweepStaged(olderThanMs) {
      const cutoff = Date.now() - olderThanMs;
      const stale = await db.query<{ handle: number }>(
        `SELECT handle FROM ${staging} WHERE created <= ?`,
        [cutoff],
      );
      let n = 0;
      for (const { handle } of stale) {
        if (inFlight.has(Number(handle))) continue;
        await inTransaction(db, async (tx) => {
          await tx.query(`DELETE FROM ${chunks} WHERE handle = ?`, [handle]);
          await tx.query(`DELETE FROM ${staging} WHERE handle = ?`, [handle]);
        });
        n++;
      }
      return n;
    },
  };
  return store;
}
