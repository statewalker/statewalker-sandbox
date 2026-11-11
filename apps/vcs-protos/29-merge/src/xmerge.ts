/** X13a — git's three-way content merge (red stub). */
export interface ContentMergeResult {
  content: Uint8Array;
  conflicts: number;
  binary: boolean;
}
export interface ContentMergeLabels {
  ours: string;
  theirs: string;
  base?: string;
}
export function mergeContent(
  _base: Uint8Array,
  _ours: Uint8Array,
  _theirs: Uint8Array,
  _labels: ContentMergeLabels,
): ContentMergeResult {
  throw new Error("not implemented");
}
