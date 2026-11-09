// Vendored from webrun-vcs@f1abdd3 packages/vcs-utils/src/compression/compression/types.ts (subset).
export interface StreamingCompressionOptions {
  raw?: boolean;
  level?: number;
}
export interface PartialDecompressionResult {
  data: Uint8Array;
  bytesRead: number;
}
export class CompressionError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CompressionError";
  }
}
