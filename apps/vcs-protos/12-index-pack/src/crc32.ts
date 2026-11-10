/** CRC-32 (IEEE 802.3, reflected, as zlib and git's index-pack compute it). */
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export const CRC_INIT = 0xffffffff;
export function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = crc;
  for (let i = 0; i < bytes.length; i++)
    c = (TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return c >>> 0;
}
export const crcFinal = (crc: number) => (crc ^ 0xffffffff) >>> 0;
