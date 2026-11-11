/** X10a — Git LFS pointers (red stub). */
export interface Pointer {
  oid: string;
  size: number;
  extensions?: { name: string; priority: number; oid: string }[];
}
export function encodePointer(_p: Pointer): Uint8Array {
  throw new Error("not implemented");
}
export function parsePointer(_bytes: Uint8Array): Pointer | undefined {
  throw new Error("not implemented");
}
