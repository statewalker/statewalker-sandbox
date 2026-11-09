/**
 * Negative controls, one per fixture family: each tampers with exactly one oracle value and
 * names the checks that must then fail — and only those. Portable: runs in Node and in a page.
 */
import type { Fixtures } from "../src/types.js";

const flipHex = (h: string) => h.replace(/^./, (c) => (c === "0" ? "1" : "0"));

export interface Tamper {
  family: string;
  apply(fx: Fixtures): string[];
}

export const TAMPERS: Tamper[] = [
  {
    family: "git id",
    apply: (fx) => {
      const o = fx.gitObjects[4];
      if (!o) throw new Error("fixture missing");
      o.id = flipHex(o.id);
      return [`git:${o.name}:vcs`, `git:${o.name}:noble`];
    },
  },
  ...(["hash", "keyed_hash", "derive_key"] as const).map((mode) => ({
    family: `blake3 ${mode}`,
    apply: (fx: Fixtures) => {
      const c = fx.blake3.cases[20];
      if (!c) throw new Error("fixture missing");
      c[mode] = flipHex(c[mode]);
      return [`blake3:${mode}:${c.input_len}`];
    },
  })),
  {
    family: "sha256",
    apply: (fx) => {
      const s = fx.sha256[2];
      if (!s) throw new Error("fixture missing");
      s.hex = flipHex(s.hex);
      return [`sha256:${s.name}`];
    },
  },
  {
    family: "lfs pointer",
    apply: (fx) => {
      const l = fx.lfs[1];
      if (!l) throw new Error("fixture missing");
      l.pointer = l.pointer.replace("size", "size 1");
      return [`lfs:${l.name}`];
    },
  },
  ...(["data", "length"] as const).map((what) => ({
    family: `zlib ${what}`,
    apply: (fx: Fixtures) => {
      if (what === "data") fx.zlib.inputSha256[7] = flipHex(fx.zlib.inputSha256[7] ?? "0");
      else fx.zlib.lengths[7] = (fx.zlib.lengths[7] ?? 0) + 1;
      return ["push", "pooled"].flatMap((k) => [1, 7, 4096].map((c) => `inflate:${k}:chunk${c}`));
    },
  })),
  ...(["offset", "type", "size", "packedSize"] as const).map((field) => ({
    family: `pack ${field}`,
    apply: (fx: Fixtures) => {
      const p = fx.packs[field === "offset" || field === "type" ? 0 : 1];
      // A non-delta entry, so type and size are comparable with verify-pack.
      const e = p?.entries.find((x) => ["commit", "tree", "blob", "tag"].includes(x.type));
      if (!p || !e) throw new Error("fixture missing");
      if (field === "offset") e.offset += 1;
      else if (field === "type") e.type = e.type === "blob" ? "tree" : "blob";
      else e[field] += 1;
      return [`pack:${p.kind}:chunk1`, `pack:${p.kind}:chunk65536`];
    },
  })),
];

export const cloneFixtures = (fx: Fixtures): Fixtures => JSON.parse(JSON.stringify(fx)) as Fixtures;
