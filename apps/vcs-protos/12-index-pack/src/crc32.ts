/** CRC-32 (IEEE, as zlib and git's index-pack). Stub in red. */
export function crc32Update(_crc: number, _bytes: Uint8Array): number {
  throw new Error("not implemented");
}
export const CRC_INIT = 0xffffffff;
export const crcFinal = (crc: number) => (crc ^ 0xffffffff) >>> 0;
