/**
 * X1d — pooled push inflater reusing pako inflate state, after JGit's
 * org.eclipse.jgit.lib.InflaterCache (at most 4 idle Inflaters, reset() on release).
 *
 * Each acquired inflater owns one ZStream while it is active. When the stream ends, fails or is
 * found truncated, the ZStream is reset (zlibInflateReset) and returned to the pool, or freed if
 * four are already idle. One 64 KiB output buffer per pool is shared by all inflaters: pushes are
 * synchronous and output is copied out, so no two pushes can interleave inside it.
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
  zlibInflateReset,
} from "pako";

export class TruncatedStreamError extends Error {
  override name = "TruncatedStreamError";
}
export class InflateError extends Error {
  override name = "InflateError";
}
export interface InflatePush {
  out: Uint8Array[];
  done: boolean;
  consumed: number;
}
export interface StreamInflater {
  push(chunk: Uint8Array): InflatePush;
  end(): void;
}
export interface InflaterPool {
  acquire(): StreamInflater;
  /** ZStreams allocated so far (R2). */
  readonly allocated: number;
  /** Idle states currently cached (at most 4). */
  readonly idle: number;
}

const OUT_SIZE = 64 * 1024;
const MAX_IDLE = 4; // JGit InflaterCache.SZ
const EMPTY = new Uint8Array(0);

type State = "active" | "finished" | "closed";

function newStream(): ZStream {
  const strm = new ZStream();
  const init = zlibInflateInit2(strm, 15);
  if (init !== Z_OK) throw new InflateError(`inflateInit2 failed: ${strm.msg || init}`);
  return strm;
}

/**
 * The push loop shared by pooled and unpooled inflaters. Returns the push result, or throws
 * InflateError (the caller releases the stream).
 */
function pushInto(strm: ZStream, buf: Uint8Array<ArrayBuffer>, chunk: Uint8Array): InflatePush {
  const out: Uint8Array[] = [];
  strm.input = chunk;
  strm.next_in = 0;
  strm.avail_in = chunk.length;
  for (;;) {
    strm.output = buf;
    strm.next_out = 0;
    strm.avail_out = buf.length;
    const ret = zlibInflate(strm, Z_NO_FLUSH);
    const produced = buf.length - strm.avail_out;
    if (produced > 0) out.push(buf.slice(0, produced));
    if (ret === Z_STREAM_END) return { out, done: true, consumed: strm.next_in };
    if (ret !== Z_OK && ret !== Z_BUF_ERROR) {
      throw new InflateError(`inflate failed: ${strm.msg || `code ${ret}`}`);
    }
    if (strm.avail_out === 0) continue;
    if (strm.avail_in === 0) return { out, done: false, consumed: chunk.length };
    if (ret === Z_BUF_ERROR) throw new InflateError("inflate made no progress");
  }
}

export function createInflaterPool(): InflaterPool {
  const idle: ZStream[] = [];
  const buf = new Uint8Array(OUT_SIZE);
  let allocated = 0;

  const release = (strm: ZStream) => {
    // pako's inflateReset does not clear strm.input, so an idle state would keep the caller's
    // last chunk (often a whole pack buffer) alive. Java's Inflater.reset() drops its input,
    // which is why JGit's InflaterCache has no such step. Found by the review of #50 (R7).
    strm.input = EMPTY;
    strm.next_in = 0;
    strm.avail_in = 0;
    if (idle.length < MAX_IDLE && zlibInflateReset(strm) === Z_OK) {
      idle.push(strm);
    } else {
      zlibInflateEnd(strm);
    }
  };

  return {
    get allocated() {
      return allocated;
    },
    get idle() {
      return idle.length;
    },
    acquire() {
      let strm = idle.pop();
      if (!strm) {
        strm = newStream();
        allocated++;
      }
      let owned: ZStream | undefined = strm;
      let state: State = "active";
      const giveBack = () => {
        if (owned) {
          release(owned);
          owned = undefined;
        }
      };
      return {
        push(chunk) {
          if (state !== "active" || !owned) {
            throw new Error("inflater used after its stream ended and was returned to the pool");
          }
          if (chunk.length === 0) return { out: [], done: false, consumed: 0 };
          let r: InflatePush;
          try {
            r = pushInto(owned, buf, chunk);
          } catch (e) {
            state = "closed";
            giveBack();
            throw e;
          }
          if (r.done) {
            state = "finished";
            giveBack();
          }
          return r;
        },
        end() {
          if (state === "finished") {
            state = "closed";
            return;
          }
          if (state === "active") {
            state = "closed";
            giveBack();
            throw new TruncatedStreamError("zlib stream ended before its Adler-32 trailer");
          }
        },
      };
    },
  };
}

/** Unpooled baseline (X1b's design: new ZStream and buffer per stream) for the R6 comparison. */
export function createUnpooledInflater(): StreamInflater {
  const strm = newStream();
  const buf = new Uint8Array(OUT_SIZE);
  let done = false;
  let freed = false;
  const free = () => {
    if (!freed) {
      freed = true;
      zlibInflateEnd(strm);
    }
  };
  return {
    push(chunk) {
      if (done) return { out: [], done: true, consumed: 0 };
      try {
        const r = pushInto(strm, buf, chunk);
        if (r.done) {
          done = true;
          free();
        }
        return r;
      } catch (e) {
        free();
        throw e;
      }
    },
    end() {
      if (!done) {
        free();
        throw new TruncatedStreamError("zlib stream ended before its Adler-32 trailer");
      }
    },
  };
}
