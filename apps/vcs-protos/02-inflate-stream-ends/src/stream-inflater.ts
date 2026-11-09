/** X1b — push-based zlib inflater that reports where each stream ends. STUB (red phase). */

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

export function createInflater(_format: "zlib" | "raw" = "zlib"): StreamInflater {
  throw new Error("not implemented");
}

/** Inflate `count` consecutive zlib streams from a chunked source; yields each with its exact compressed length. */
export async function* inflateSequence(
  _source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  _count: number,
): AsyncGenerator<{ data: Uint8Array; compressedLength: number }> {
  throw new Error("not implemented");
}
