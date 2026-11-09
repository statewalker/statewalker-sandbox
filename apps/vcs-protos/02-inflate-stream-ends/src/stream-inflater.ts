/**
 * X1b — push-based zlib inflater that reports where each stream ends.
 *
 * Built on pako 3's low-level zlib port. The key facts this relies on:
 * - `zlibInflate(strm, Z_NO_FLUSH)` accepts input in arbitrary pieces and keeps all state in
 *   the ZStream, so a chunk boundary can fall anywhere (header, Huffman data, Adler-32).
 * - When it returns Z_STREAM_END, `strm.next_in` is the index in the *current* input of the first
 *   byte after the stream — that is the exact end, with no re-inflation.
 * - Z_STREAM_END is returned only after the Adler-32 trailer has been read and verified; a stream
 *   cut anywhere before that never reaches it, which is what makes truncation detectable.
 */
import {
  Z_BUF_ERROR,
  Z_NO_FLUSH,
  Z_OK,
  Z_STREAM_END,
  ZStream,
  zlibInflate,
  zlibInflateEnd,
  zlibInflateInit2,
} from "pako";

export class TruncatedStreamError extends Error {
  override name = "TruncatedStreamError";
}
export class InflateError extends Error {
  override name = "InflateError";
}

export interface InflatePush {
  /** Decompressed output produced by this push. */
  out: Uint8Array[];
  /** True once the stream's end (including its Adler-32) has been reached. */
  done: boolean;
  /** Bytes of the pushed chunk that belong to this stream; the rest belong to whatever follows. */
  consumed: number;
}

export interface StreamInflater {
  push(chunk: Uint8Array): InflatePush;
  /** Asserts the stream completed; throws TruncatedStreamError otherwise. */
  end(): void;
}

/** Counts inflaters created (tests assert exactly one per pack entry). */
export const inflaterStats = { created: 0 };

const OUT_SIZE = 64 * 1024;

export function createInflater(format: "zlib" | "raw" = "zlib"): StreamInflater {
  inflaterStats.created++;
  const strm = new ZStream();
  const init = zlibInflateInit2(strm, format === "raw" ? -15 : 15);
  if (init !== Z_OK) throw new InflateError(`inflateInit2 failed: ${strm.msg || init}`);
  let done = false;
  let released = false;
  // One output buffer per inflater, and produced bytes are *copied* out. Returning subarray
  // views of a fresh 64 KiB buffer per push looked cheaper but pinned a whole buffer per view:
  // with 1-byte input chunks a 1 MiB object pinned ~64 GiB and the test worker was OOM-killed.
  const buf = new Uint8Array(OUT_SIZE);
  const release = () => {
    if (!released) {
      released = true;
      zlibInflateEnd(strm);
    }
  };

  return {
    push(chunk) {
      if (done) return { out: [], done: true, consumed: 0 };
      const out: Uint8Array[] = [];
      strm.input = chunk;
      strm.next_in = 0;
      strm.avail_in = chunk.length;
      for (;;) {
        strm.output = buf;
        strm.next_out = 0;
        strm.avail_out = OUT_SIZE;
        const ret = zlibInflate(strm, Z_NO_FLUSH);
        const produced = OUT_SIZE - strm.avail_out;
        if (produced > 0) out.push(buf.slice(0, produced));
        if (ret === Z_STREAM_END) {
          done = true;
          const consumed = strm.next_in;
          release();
          return { out, done: true, consumed };
        }
        if (ret !== Z_OK && ret !== Z_BUF_ERROR) {
          release();
          throw new InflateError(`inflate failed: ${strm.msg || `code ${ret}`}`);
        }
        // Output buffer full: more output may be pending even with no input left.
        if (strm.avail_out === 0) continue;
        // Input exhausted and the stream has not ended: wait for the next chunk.
        if (strm.avail_in === 0) return { out, done: false, consumed: chunk.length };
        if (ret === Z_BUF_ERROR) {
          release();
          throw new InflateError("inflate made no progress");
        }
      }
    },
    end() {
      if (!done) {
        release();
        throw new TruncatedStreamError("zlib stream ended before its Adler-32 trailer");
      }
    },
  };
}

/**
 * Pull-side helper over a chunked source: hands out chunks and accepts back the unconsumed
 * tail of the chunk it just handed out. It holds at most one pushed-back chunk; a second
 * `unshift` before `next()` throws rather than silently reordering bytes.
 */
export class ChunkReader {
  private pending: Uint8Array | undefined;
  private readonly it: AsyncIterator<Uint8Array> | Iterator<Uint8Array>;
  constructor(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
    this.it =
      Symbol.asyncIterator in source
        ? (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
        : (source as Iterable<Uint8Array>)[Symbol.iterator]();
  }
  async next(): Promise<Uint8Array | undefined> {
    const p = this.pending;
    if (p) {
      this.pending = undefined;
      return p;
    }
    for (;;) {
      const r = await this.it.next();
      if (r.done) return undefined;
      if (r.value.length > 0) return r.value;
    }
  }
  unshift(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    if (this.pending) throw new Error("ChunkReader: only one chunk can be pushed back");
    this.pending = chunk;
  }
}

/**
 * Inflate one stream from the reader. `onConsumed` sees exactly the compressed bytes of the
 * stream (used by the pack walker to feed the trailer hash).
 */
export async function inflateOne(
  reader: ChunkReader,
  onConsumed?: (bytes: Uint8Array) => void,
  onOutput?: (bytes: Uint8Array) => void,
): Promise<{ data: Uint8Array[]; compressedLength: number }> {
  const inf = createInflater();
  const data: Uint8Array[] = [];
  let compressedLength = 0;
  for (;;) {
    const chunk = await reader.next();
    if (!chunk) {
      inf.end(); // throws TruncatedStreamError
      break;
    }
    const r = inf.push(chunk);
    if (onOutput) for (const o of r.out) onOutput(o);
    else data.push(...r.out);
    compressedLength += r.consumed;
    onConsumed?.(chunk.subarray(0, r.consumed));
    if (r.done) {
      reader.unshift(chunk.subarray(r.consumed));
      break;
    }
  }
  return { data, compressedLength };
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1 && parts[0]) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Inflate `count` consecutive zlib streams from a chunked source; yields each with its exact compressed length. */
export async function* inflateSequence(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  count: number,
): AsyncGenerator<{ data: Uint8Array; compressedLength: number }> {
  const reader = new ChunkReader(source);
  for (let i = 0; i < count; i++) {
    const { data, compressedLength } = await inflateOne(reader);
    yield { data: concatBytes(data), compressedLength };
  }
}
