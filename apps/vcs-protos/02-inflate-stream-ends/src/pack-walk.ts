/**
 * X1b — minimal pack walker (no delta resolution) built on the push inflater.
 * Reads the header, each entry header and its zlib stream (inflated exactly once), and
 * checks the SHA-1 trailer over every preceding byte.
 */
import { sha1 } from "@noble/hashes/legacy.js";
import { ChunkReader, inflateOne } from "./stream-inflater.js";

export interface PackEntry {
  offset: number;
  type: number; // 1 commit, 2 tree, 3 blob, 4 tag, 6 ofs-delta, 7 ref-delta
  size: number; // declared inflated size
  inflatedLength: number;
  totalLength: number; // header + delta base ref + compressed bytes
}

export interface PackWalk {
  version: number;
  count: number;
  entries: PackEntry[];
  trailerOk: boolean;
}

export class PackFormatError extends Error {
  override name = "PackFormatError";
}

export async function walkPack(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<PackWalk> {
  const reader = new ChunkReader(source);
  const hasher = sha1.create();
  let pos = 0;

  async function readBytes(n: number, hash = true): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = await reader.next();
      if (!chunk) throw new PackFormatError(`unexpected end of pack at ${pos + filled}`);
      const take = Math.min(n - filled, chunk.length);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      reader.unshift(chunk.subarray(take));
    }
    if (hash) hasher.update(out);
    pos += n;
    return out;
  }
  const byte = async () => (await readBytes(1))[0] as number;

  const head = await readBytes(12);
  if (new TextDecoder().decode(head.subarray(0, 4)) !== "PACK")
    throw new PackFormatError("not a pack");
  const view = new DataView(head.buffer, head.byteOffset, 12);
  const version = view.getUint32(4);
  const count = view.getUint32(8);
  if (version !== 2 && version !== 3)
    throw new PackFormatError(`unsupported pack version ${version}`);

  const entries: PackEntry[] = [];
  for (let i = 0; i < count; i++) {
    const offset = pos;
    let b = await byte();
    const type = (b >> 4) & 7;
    if (type === 0 || type === 5)
      throw new PackFormatError(`reserved object type ${type} at ${offset}`);
    // Arithmetic, not shifts: sizes above 2^31 must not wrap (the bug found in vcs-utils).
    let size = b & 0x0f;
    let mul = 16;
    while (b & 0x80) {
      b = await byte();
      size += (b & 0x7f) * mul;
      mul *= 128;
    }
    if (type === 6) {
      b = await byte();
      while (b & 0x80) b = await byte(); // base offset: skipped, no delta resolution here
    } else if (type === 7) {
      await readBytes(20);
    }
    // Count output instead of holding it: the walker only needs lengths.
    let inflatedLength = 0;
    const { compressedLength } = await inflateOne(
      reader,
      (bytes) => hasher.update(bytes),
      (out) => {
        inflatedLength += out.length;
      },
    );
    pos += compressedLength;
    entries.push({ offset, type, size, inflatedLength, totalLength: pos - offset });
  }

  const trailer = await readBytes(20, false);
  if (await reader.next()) throw new PackFormatError("bytes after the pack trailer");
  const digest = hasher.digest();
  const trailerOk = digest.every((v, i) => v === trailer[i]);
  return { version, count, entries, trailerOk };
}
