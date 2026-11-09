/** Fixtures produced in Node by real oracles; plain JSON so they cross into browsers and workerd. */
export interface Fixtures {
  /** PRNG seed the random inputs were generated from; reported in failure details. */
  seed: number;
  gitObjects: Array<{ name: string; type: "blob" | "commit"; b64: string; id: string }>;
  blake3: {
    key: string;
    context: string;
    cases: Array<{ input_len: number; hash: string; keyed_hash: string; derive_key: string }>;
  };
  /** Inputs shared by the SHA-256 and LFS checks (referenced by name, sent once). */
  sha256: Array<{ name: string; b64: string; hex: string }>;
  lfs: Array<{ name: string; pointer: string; oracle: "git-lfs" | "spec" }>;
  /** Concatenated zlib streams + trailing bytes; each stream's length and its input's SHA-256. */
  zlib: { concatenatedB64: string; lengths: number[]; inputSha256: string[] };
  packs: Array<{
    kind: "ofs" | "ref";
    b64: string;
    /** From `git verify-pack -v`: offset, type name, size, size-in-packfile — in offset order. */
    entries: Array<{ offset: number; type: string; size: number; packedSize: number }>;
  }>;
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface BenchRow {
  name: string;
  /** Bytes processed (throughput benches) or objects processed (object benches). */
  amount: number;
  unit: "MB" | "objects";
  ms: number;
}
