/** X11 — Hugging Face Xet (stubs) */
export interface ChunkRef {
  hash: Uint8Array;
  length: number;
}
export interface ReconstructionAnswer {
  offset_into_first_range: number;
  terms: { hash: string; unpacked_length: number; range: { start: number; end: number } }[];
  fetch_info: Record<
    string,
    {
      range: { start: number; end: number };
      url: string;
      url_range: { start: number; end: number };
    }[]
  >;
}
export type FetchRange = (url: string, start: number, end: number) => AsyncIterable<Uint8Array>;
const todo = (): never => {
  throw new Error("not implemented");
};
export const hashToString = (_h: Uint8Array): string => todo();
export const hashFromString = (_s: string): Uint8Array => todo();
export const chunkHash = (_d: Uint8Array): Uint8Array => todo();
export const xorbHash = (_c: ChunkRef[]): Uint8Array => todo();
export const fileHash = (_c: ChunkRef[]): Uint8Array => todo();
export const rangeHash = (_h: Uint8Array[]): Uint8Array => todo();
export async function* chunkStream(_s: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  yield todo();
}
export async function* reconstruct(
  _a: ReconstructionAnswer,
  _f: FetchRange,
): AsyncGenerator<Uint8Array> {
  yield todo();
}
