/**
 * X4 — raw-bytes git object kernel over a StagingBlobStore.
 *
 * An object is the bytes `"<type> <size>\0" + content`; its id is SHA-1 of exactly those bytes and
 * it is stored as their zlib stream — a git loose object. The kernel never parses commits or trees,
 * so whatever bytes git produced (extra headers, legacy modes) keep their id. Backends store bytes
 * under ids the kernel computed; they never hash.
 *
 * Writes: one pass — each chunk updates SHA-1 and goes to CompressionStream("deflate") (zlib, as
 * git writes loose objects; native in browsers, Node and workerd), the deflated stream is staged,
 * and the id is supplied after the last byte. Reads: X1d's pooled push inflater, which reports the
 * exact end of the zlib stream, so truncation and trailing bytes are errors (git: "garbage at end
 * of loose object").
 */
import type { ByteStream } from "@statewalker/webrun-storage";
import { createSha1, type Hasher, toHex } from "../../01-streaming-git-hash/src/git-object-hash.js";
import { createInflaterPool } from "../../04-pooled-inflater/src/pooled-inflater.js";
import type { StagingBlobStore } from "./staging.js";

export type ObjectType = "blob" | "tree" | "commit" | "tag";

export class ObjectIdMismatchError extends Error {
  override name = "ObjectIdMismatchError";
}
export class InvalidObjectIdError extends Error {
  override name = "InvalidObjectIdError";
}
export class CorruptObjectError extends Error {
  override name = "CorruptObjectError";
}

export interface GitObject {
  type: ObjectType;
  size: number;
  content: ByteStream;
}

export interface GitObjects {
  /** One pass over `content`: hash, deflate and stage together. Returns git's id. */
  put(type: ObjectType, size: number, content: ByteStream): Promise<string>;
  /** Store an uncompressed loose object (`"<type> <size>\0" + content`) received with its id. */
  putRaw(id: string, raw: ByteStream): Promise<void>;
  /** Inflated loose object, header included. Empty stream if absent. */
  getRaw(id: string): ByteStream;
  /** Parsed header and content; `verify` re-hashes and throws at the end on mismatch. */
  get(id: string, opts?: { verify?: boolean }): Promise<GitObject | undefined>;
  has(id: string): Promise<boolean>;
  /** Object ids only (40 hex), whatever else lives in the store. */
  list(): AsyncIterable<string>;
}

const TYPES = new Set<string>(["blob", "tree", "commit", "tag"]);
const OID = /^[0-9a-f]{40}$/;
const MAX_HEADER = 32; // "commit " + 16 digits + NUL fits; git's limit is similar (MAX_HEADER_LEN)
const enc = new TextEncoder();

/** Parses `"<type> <size>"` (without the NUL) as git does: known type, canonical decimal size. */
function parseHeader(bytes: Uint8Array): { type: ObjectType; size: number } {
  const text = String.fromCharCode(...bytes);
  const m = /^([a-z]+) (0|[1-9][0-9]{0,15})$/.exec(text);
  if (!m || !TYPES.has(m[1] as string)) throw new CorruptObjectError(`bad object header "${text}"`);
  const size = Number(m[2]);
  if (!Number.isSafeInteger(size)) throw new CorruptObjectError(`object size too large: ${m[2]}`);
  return { type: m[1] as ObjectType, size };
}

/**
 * Wraps a raw-object byte stream: parses the header from the first bytes, counts body bytes against
 * the declared size, and feeds every byte to `hasher`. `onHeader` sees the header once it is parsed.
 */
async function* checkedRaw(
  raw: AsyncIterable<Uint8Array>,
  hasher: Hasher | undefined,
  onHeader?: (h: { type: ObjectType; size: number }) => void,
  Err: new (m: string) => Error = CorruptObjectError,
): AsyncGenerator<Uint8Array> {
  let header: { type: ObjectType; size: number } | undefined;
  let pending: Uint8Array | undefined; // header bytes seen so far
  let seen = 0;
  for await (const chunk of raw) {
    let body = chunk;
    if (!header) {
      const joined = pending
        ? Uint8Array.of(...pending, ...chunk.subarray(0, MAX_HEADER + 1))
        : chunk;
      const nul = joined.indexOf(0);
      if (nul < 0) {
        if (joined.length > MAX_HEADER) throw new Err("object header has no NUL");
        pending = joined.slice();
        continue;
      }
      if (nul > MAX_HEADER) throw new Err("object header has no NUL");
      try {
        header = parseHeader(joined.subarray(0, nul));
      } catch (e) {
        throw new Err((e as Error).message);
      }
      onHeader?.(header);
      const used = nul + 1 - (pending?.length ?? 0); // bytes of this chunk that belong to the header
      hasher?.update(joined.subarray(0, nul + 1));
      yield joined.slice(0, nul + 1);
      body = chunk.subarray(used);
      pending = undefined;
    }
    if (body.length === 0) continue;
    seen += body.length;
    if (seen > header.size)
      throw new Err(`object body longer than its declared ${header.size} bytes`);
    hasher?.update(body);
    yield body;
  }
  if (!header) {
    if (pending) throw new Err("object header has no NUL");
    return;
  }
  if (seen !== header.size)
    throw new Err(`object body is ${seen} bytes, header says ${header.size}`);
}

/** zlib-deflates a byte stream with the platform's CompressionStream, pulling input on demand. */
async function* deflate(src: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  let failure: unknown;
  const pump = (async () => {
    try {
      for await (const c of src) await writer.write(c as Uint8Array<ArrayBuffer>);
      await writer.close();
    } catch (e) {
      failure = e;
      await writer.abort(e).catch(() => {});
    }
  })();
  try {
    for (;;) {
      const r = await reader.read().catch((e) => {
        throw failure ?? e;
      });
      if (r.done) break;
      yield r.value;
    }
    await pump;
    if (failure) throw failure;
  } finally {
    reader.releaseLock();
  }
}

export function gitObjects(
  store: StagingBlobStore,
  newHasher: () => Hasher = () => createSha1("noble"),
): GitObjects {
  const pool = createInflaterPool();

  /** Inflates a stored object, failing on truncation and on bytes after the zlib stream. */
  async function* inflate(id: string): AsyncGenerator<Uint8Array> {
    const inflater = pool.acquire();
    let done = false;
    let any = false;
    try {
      for await (const chunk of store.get(id)) {
        if (chunk.length === 0) continue;
        any = true;
        if (done) throw new CorruptObjectError(`${id}: bytes after the end of the zlib stream`);
        let r: ReturnType<typeof inflater.push>;
        try {
          r = inflater.push(chunk);
        } catch (e) {
          throw new CorruptObjectError(`${id}: ${(e as Error).message}`);
        }
        yield* r.out;
        if (r.done) {
          done = true;
          if (r.consumed < chunk.length) {
            throw new CorruptObjectError(`${id}: bytes after the end of the zlib stream`);
          }
        }
      }
      if (!any) {
        if (await store.has(id)) throw new CorruptObjectError(`${id}: empty object file`);
        return;
      }
      if (!done) throw new CorruptObjectError(`${id}: truncated zlib stream`);
    } finally {
      if (!done) {
        try {
          inflater.end();
        } catch {
          // end() of an unfinished stream reports truncation; already handled above
        }
      }
    }
  }

  async function* raw(id: string, verify: boolean): AsyncGenerator<Uint8Array> {
    const hasher = verify ? newHasher() : undefined;
    yield* checkedRaw(inflate(id), hasher);
    if (hasher) {
      const actual = toHex(hasher.digest());
      if (actual !== id) throw new ObjectIdMismatchError(`object ${id} hashes to ${actual}`);
    }
  }

  return {
    async put(type, size, content) {
      if (!TYPES.has(type)) throw new TypeError(`unknown object type ${type}`);
      if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`bad object size ${size}`);
      const hasher = newHasher();
      async function* framed() {
        yield enc.encode(`${type} ${size}\0`);
        yield* content;
      }
      const r = await store.putStaged(
        deflate(checkedRaw(framed(), hasher, undefined, RangeError)),
        () => toHex(hasher.digest()),
      );
      return r.id;
    },
    async putRaw(id, rawBytes) {
      if (!OID.test(id)) throw new ObjectIdMismatchError(`not an object id: ${id}`);
      const hasher = newHasher();
      await store.putStaged(deflate(checkedRaw(rawBytes, hasher)), () => {
        const actual = toHex(hasher.digest());
        if (actual !== id)
          throw new ObjectIdMismatchError(`supplied id ${id}, content hashes to ${actual}`);
        return id;
      });
    },
    getRaw(id) {
      return raw(id, false);
    },
    async get(id, opts) {
      const it = raw(id, opts?.verify === true);
      const first = await it.next(); // the header chunk, or end if absent
      if (first.done) return undefined;
      const { type, size } = parseHeader(first.value.subarray(0, first.value.length - 1));
      return {
        type,
        size,
        content: {
          [Symbol.asyncIterator]: () => it,
        },
      };
    },
    has(id) {
      return store.has(id);
    },
    async *list() {
      for await (const id of store.list()) if (OID.test(id)) yield id;
    },
  };
}
