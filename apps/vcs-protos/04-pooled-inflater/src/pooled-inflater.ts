/** X1d — pooled push inflater reusing one ZStream and output buffer. STUB (red phase). */

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

export function createInflaterPool(): InflaterPool {
  throw new Error("not implemented");
}

/** Unpooled baseline (X1b's design) for the R6 comparison. */
export function createUnpooledInflater(): StreamInflater {
  throw new Error("not implemented");
}
