/**
 * git binary delta application with every bound checked (git patch-delta.c, JGit BinaryDelta):
 * header = base size, result size (7-bit little-endian varints); then instructions:
 *   1xxxxxxx  copy  — offset bytes for bits 0-3, size bytes for bits 4-6 (size 0 = 0x10000)
 *   0nnnnnnn  insert the next n bytes (n = 0 is reserved and refused)
 */
export class DeltaError extends Error {
  override name = "DeltaError";
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let p = 0;
  const varint = () => {
    let v = 0;
    let mul = 1;
    for (;;) {
      if (p >= delta.length) throw new DeltaError("delta header truncated");
      const b = delta[p++] as number;
      v += (b & 0x7f) * mul;
      mul *= 128;
      if (!(b & 0x80)) return v;
      if (mul > 2 ** 49) throw new DeltaError("delta size too large");
    }
  };
  const baseSize = varint();
  const resultSize = varint();
  if (baseSize !== base.length)
    throw new DeltaError(`delta base size ${baseSize}, base has ${base.length}`);
  const out = new Uint8Array(resultSize);
  let o = 0;
  while (p < delta.length) {
    const cmd = delta[p++] as number;
    if (cmd & 0x80) {
      let off = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) {
        if (cmd & (1 << i)) {
          if (p >= delta.length) throw new DeltaError("copy offset truncated");
          off += (delta[p++] as number) * 2 ** (8 * i);
        }
      }
      for (let i = 0; i < 3; i++) {
        if (cmd & (0x10 << i)) {
          if (p >= delta.length) throw new DeltaError("copy size truncated");
          size += (delta[p++] as number) << (8 * i);
        }
      }
      if (size === 0) size = 0x10000;
      if (off + size > base.length)
        throw new DeltaError(`copy [${off}, ${off + size}) beyond base of ${base.length}`);
      if (o + size > resultSize) throw new DeltaError("delta result longer than declared");
      out.set(base.subarray(off, off + size), o);
      o += size;
    } else if (cmd !== 0) {
      if (p + cmd > delta.length) throw new DeltaError("insert truncated");
      if (o + cmd > resultSize) throw new DeltaError("delta result longer than declared");
      out.set(delta.subarray(p, p + cmd), o);
      p += cmd;
      o += cmd;
    } else {
      throw new DeltaError("delta instruction 0 is reserved");
    }
  }
  if (o !== resultSize) throw new DeltaError(`delta result ${o} bytes, declared ${resultSize}`);
  return out;
}
