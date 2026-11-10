/**
 * X6b3 — explode an installed pack into the native SQL store: every object written as a loose
 * object (X4's format: zlib of "<type> <size>\0" + content) in X3b's tables, many per transaction,
 * in resumable steps.
 *
 * A step takes the next objects in the pack's idx order and writes them with the progress row in
 * ONE transaction: small objects (compressed size up to one chunk) are inserted inline, a batch at
 * a time; a larger object goes through X3b's staged put (its own transaction), and the progress is
 * advanced past it afterwards — a crash between the two re-puts it on resume, which X3b ignores
 * (an existing id wins). So the progress never runs ahead of the objects, and an object is either
 * absent or whole.
 */
import type { Db } from "@statewalker/db-api";
import { inTransaction } from "@statewalker/db-sqlite";
import { Deflate } from "pako";
import { gitObjects } from "../../09-git-objects/src/git-objects.js";
import { sqlBlobStore } from "../../11-sql-blob-store/src/sql-blob-store.js";
import type {
  ObjectTypeName as GitType,
  PackReader,
} from "../../13-pack-reader/src/pack-reader.js";

export interface ExplodeOptions {
  /** X3b table prefix. Default "obj_". */
  prefix?: string;
  /** Objects per transaction. Default 1024. */
  batch?: number;
  /** X3b chunk size: compressed objects up to this size are stored inline. Default 1 MiB. */
  chunkSize?: number;
  /** A batch is committed once its compressed objects reach this many bytes. Default 8 MiB. */
  batchBytes?: number;
}

/** The pack's ids in idx order, built once per reader (not once per step). */
const idsOf = new WeakMap<PackReader, string[]>();

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const enc = new TextEncoder();

async function collect(s: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of s) {
    parts.push(c);
    n += c.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function deflate(parts: Uint8Array[]): Uint8Array {
  const out: Uint8Array[] = [];
  let n = 0;
  const d = new Deflate();
  d.onData = (c: Uint8Array) => {
    out.push(c);
    n += c.length;
  };
  parts.forEach((p, i) => {
    d.push(p, i === parts.length - 1);
  });
  if (d.err) throw new Error(`deflate failed: ${d.msg}`);
  const z = new Uint8Array(n);
  let o = 0;
  for (const c of out) {
    z.set(c, o);
    o += c.length;
  }
  return z;
}

export interface ExplodeStep {
  done: boolean;
  /** objects written so far (the progress row) */
  next: number;
  total: number;
  /** objects this step wrote */
  written: number;
  /** transactions this step committed (inline batches and staged objects) */
  transactions: number;
}

/**
 * Writes up to `units` objects of `reader`'s pack (default: all) into the SQL store and commits the
 * progress with them. Call again until `done`.
 */
export async function explodeStep(
  db: Db,
  reader: PackReader,
  opts: ExplodeOptions & { units?: number } = {},
): Promise<ExplodeStep> {
  const prefix = opts.prefix ?? "obj_";
  if (!IDENT.test(prefix)) throw new Error(`invalid table prefix ${prefix}`);
  const batch = opts.batch ?? 1024;
  const units = opts.units ?? Number.POSITIVE_INFINITY;
  const batchBytes = opts.batchBytes ?? 8 * 2 ** 20;
  const chunkSize = opts.chunkSize ?? 2 ** 20;
  // a batch of 0 made the loop spin without an await (the whole isolate hung)
  if (!Number.isInteger(batch) || batch < 1)
    throw new Error(`batch must be an integer ≥ 1: ${batch}`);
  if (!(units === Number.POSITIVE_INFINITY || (Number.isInteger(units) && units >= 1)))
    throw new Error(`units must be an integer ≥ 1: ${units}`);
  if (!(batchBytes >= 1)) throw new Error(`batchBytes must be ≥ 1: ${batchBytes}`);
  const store = await sqlBlobStore(db, { prefix, chunkSize });
  const objects = gitObjects(store);
  const blobs = `${prefix}blobs`;
  const progress = `${prefix}explode`;
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${progress} (pack TEXT PRIMARY KEY NOT NULL, next INTEGER NOT NULL)`,
  );
  let ids = idsOf.get(reader);
  if (!ids) {
    ids = [...reader.ids()];
    idsOf.set(reader, ids);
  }
  const total = ids.length;
  const [row] = await db.query<{ next: number }>(`SELECT next FROM ${progress} WHERE pack = ?`, [
    reader.packId,
  ]);
  let next = row ? Number(row.next) : 0;
  const end = Math.min(total, next + units);
  let written = 0;
  let transactions = 0;
  const setProgress = (tx: Db, n: number) =>
    tx.query(
      `INSERT INTO ${progress} (pack, next) VALUES (?, ?) ON CONFLICT(pack) DO UPDATE SET next = max(next, excluded.next)`,
      [reader.packId, n],
    );
  while (next < end) {
    // a batch of inline objects (bounded by count and bytes), or one large object
    const rows: { id: string; z: Uint8Array }[] = [];
    let bytes = 0;
    let large:
      | { id: string; type: GitType; size: number; content: AsyncIterable<Uint8Array> }
      | undefined;
    let i = next;
    for (; i < end && rows.length < batch && bytes < batchBytes; i++) {
      const id = ids[i] as string;
      // verified: a pack changed at rest must not leave wrong bytes under an id ("existing wins"
      // would keep them forever)
      const o = await reader.get(id, { verify: true });
      if (!o) throw new Error(`pack ${reader.packId} lists ${id} but cannot read it`);
      if (o.size > chunkSize) {
        large = { id, type: o.type, size: o.size, content: o.content }; // streamed, not re-read
        break;
      }
      const content = await collect(o.content);
      const z = deflate([enc.encode(`${o.type} ${o.size}\0`), content]);
      if (z.length > chunkSize) {
        large = {
          id,
          type: o.type,
          size: o.size,
          content: (async function* () {
            yield content;
          })(),
        };
        break;
      }
      rows.push({ id, z });
      bytes += z.length;
    }
    if (rows.length) {
      const upTo = next + rows.length;
      await inTransaction(db, async (tx) => {
        for (const r of rows)
          await tx.query(
            `INSERT INTO ${blobs} (id, size, chunk_size, handle, inline) VALUES (?, ?, ?, NULL, ?) ON CONFLICT(id) DO NOTHING`,
            [r.id, r.z.length, chunkSize, r.z],
          );
        await setProgress(tx, upTo);
      });
      next = upTo;
      written += rows.length;
      transactions++;
    }
    if (large) {
      if (await store.has(large.id)) {
        // already stored (a resume after its commit, or a second explode): skip the staging
        await (large.content as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]().return?.();
      } else {
        // X4 hashes, deflates and stages in one pass; X3b commits it in its own transaction
        const id = await objects.put(large.type, large.size, large.content);
        if (id !== large.id) throw new Error(`object ${large.id} hashed to ${id}`);
      }
      await setProgress(db, next + 1);
      next++;
      written++;
      transactions++;
    }
  }
  return { done: next >= total, next, total, written, transactions };
}

/** Reads exploded objects back (X4 over X3b). */
export async function explodedObjects(db: Db, opts: { prefix?: string; chunkSize?: number } = {}) {
  return gitObjects(
    await sqlBlobStore(db, { prefix: opts.prefix ?? "obj_", chunkSize: opts.chunkSize ?? 2 ** 20 }),
  );
}
