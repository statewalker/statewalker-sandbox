/** git's pkt-line and side-band codecs (X8a) — red stub. */
export class PktError extends Error {
  override name = "PktError";
}
export type Pkt =
  | { kind: "data"; data: Uint8Array }
  | { kind: "flush" }
  | { kind: "delim" }
  | { kind: "end" };
export const FLUSH = new TextEncoder().encode("0000");
export const DELIM = new TextEncoder().encode("0001");
export const RESPONSE_END = new TextEncoder().encode("0002");
export function pkt(_data: string | Uint8Array): Uint8Array {
  throw new Error("not implemented");
}
export function sideband(_band: number, _data: Uint8Array): Uint8Array[] {
  throw new Error("not implemented");
}
export class PktReader {
  constructor(_src: AsyncIterable<Uint8Array>) {}
  async read(): Promise<Pkt | null> {
    throw new Error("not implemented");
  }
}
export async function* readSideband(
  _r: PktReader,
  _progress: (m: string) => void,
): AsyncGenerator<Uint8Array> {
  throw new Error("not implemented");
}
