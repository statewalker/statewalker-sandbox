/**
 * Export and import the running state of a noble SHA-1 hasher, so a pack's checksum can be
 * continued in a later step (another request, another isolate). noble keeps the state in plain
 * fields (A–E via get()/set(), the pending block in `buffer`, `pos`, `length`); they are not a
 * documented API, so both directions check that the fields are what they expect and the
 * round-trip test (R6) pins the behaviour. 93 bytes: 5 words, the length (float64), the pending
 * byte count, the pending block.
 */
import { sha1 } from "@noble/hashes/legacy.js";

export type Sha1 = ReturnType<typeof sha1.create>;
interface Internals {
  get(): number[];
  set(a: number, b: number, c: number, d: number, e: number): void;
  buffer: Uint8Array;
  pos: number;
  length: number;
  finished: boolean;
}

const SIZE = 20 + 8 + 1 + 64;

function internals(h: Sha1): Internals {
  const x = h as unknown as Internals;
  if (
    typeof x.get !== "function" ||
    typeof x.set !== "function" ||
    !(x.buffer instanceof Uint8Array) ||
    x.buffer.length !== 64 ||
    typeof x.pos !== "number" ||
    typeof x.length !== "number"
  )
    throw new Error("unsupported @noble/hashes SHA-1 internals: cannot export its state");
  return x;
}

export function exportSha1(h: Sha1): Uint8Array {
  const x = internals(h);
  if (x.finished) throw new Error("hasher already finished");
  const out = new Uint8Array(SIZE);
  const v = new DataView(out.buffer);
  x.get().forEach((w, i) => {
    v.setUint32(i * 4, w >>> 0);
  });
  v.setFloat64(20, x.length);
  out[28] = x.pos;
  out.set(x.buffer.subarray(0, x.pos), 29);
  return out;
}

export function importSha1(state: Uint8Array): Sha1 {
  if (state.length !== SIZE) throw new Error(`SHA-1 state must be ${SIZE} bytes`);
  const h = sha1.create();
  const x = internals(h);
  const v = new DataView(state.buffer, state.byteOffset, SIZE);
  x.set(v.getUint32(0), v.getUint32(4), v.getUint32(8), v.getUint32(12), v.getUint32(16));
  x.length = v.getFloat64(20);
  const pos = state[28] as number;
  if (pos >= 64) throw new Error("corrupt SHA-1 state");
  x.buffer.set(state.subarray(29, 29 + pos));
  x.pos = pos;
  return h;
}
