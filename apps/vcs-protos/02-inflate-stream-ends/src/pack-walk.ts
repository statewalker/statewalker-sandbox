/** X1b — minimal pack walker (no delta resolution) built on the push inflater. STUB (red phase). */

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

export async function walkPack(
  _source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<PackWalk> {
  throw new Error("not implemented");
}
