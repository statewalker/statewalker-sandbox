/** Fixtures produced in Node by real oracles; plain JSON so they cross into browsers and workerd. */
export interface Fixtures {
  gitObjects: Array<{ name: string; type: "blob" | "commit"; b64: string; id: string }>;
  blake3: {
    key: string;
    context: string;
    cases: Array<{ input_len: number; hash: string; keyed_hash: string; derive_key: string }>;
  };
  sha256: Array<{ name: string; b64: string; hex: string }>;
  lfs: Array<{ name: string; b64: string; pointer: string; oracle: "git-lfs" | "spec" }>;
  zlib: { inputs: string[]; concatenatedB64: string; lengths: number[] };
  packs: Array<{ kind: "ofs" | "ref"; b64: string; count: number; offsets: number[] }>;
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
