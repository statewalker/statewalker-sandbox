import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createBlake3, createSha256, type Hasher, lfsPointer, toHex } from "../src/hashes.js";

interface Vector {
  input_len: number;
  hash: string;
  keyed_hash: string;
  derive_key: string;
}
const VECTORS = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/blake3-test-vectors.json"), "utf8"),
) as { key: string; context_string: string; cases: Vector[] };
const enc = new TextEncoder();
const KEY = enc.encode(VECTORS.key);
const CONTEXT = enc.encode(VECTORS.context_string);
const OUT = VECTORS.cases[0]?.hash.length ? VECTORS.cases[0].hash.length / 2 : 131;

/** The official input pattern: byte i = i mod 251. */
function vectorInput(len: number): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = i % 251;
  return b;
}
function* chunked(bytes: Uint8Array, size: number): Iterable<Uint8Array> {
  for (let pos = 0; pos < bytes.length; pos += size) yield bytes.subarray(pos, pos + size);
}
function digestOf(make: () => Hasher, parts: Iterable<Uint8Array>): string {
  const h = make();
  for (const p of parts) h.update(p);
  return toHex(h.digest());
}
const MODES: Array<[string, () => Hasher, keyof Vector]> = [
  ["hash", () => createBlake3({ dkLen: OUT }), "hash"],
  ["keyed_hash", () => createBlake3({ key: KEY, dkLen: OUT }), "keyed_hash"],
  ["derive_key", () => createBlake3({ context: CONTEXT, dkLen: OUT }), "derive_key"],
];
function sha256Ref(b: Uint8Array): string {
  return execFileSync("sha256sum", { input: b }).toString().split(" ")[0] ?? "";
}

describe("R1 official BLAKE3 vectors", () => {
  it("fixture is the official file (35 cases, 131-byte outputs)", () => {
    expect(VECTORS.cases.length).toBe(35);
    expect(OUT).toBe(131);
  });
  for (const v of VECTORS.cases) {
    for (const [mode, make, field] of MODES) {
      it(`${mode} input_len ${v.input_len}`, () => {
        expect(digestOf(make, [vectorInput(v.input_len)])).toBe(v[field]);
      });
    }
  }
});

describe("R2 digests independent of chunking", () => {
  const small = VECTORS.cases.filter((v) => v.input_len <= 4097);
  it("BLAKE3: every 2-way split of inputs up to 4097 bytes, all modes", () => {
    for (const v of small) {
      const input = vectorInput(v.input_len);
      for (const [, make, field] of MODES) {
        for (let cut = 0; cut <= input.length; cut += input.length > 1100 ? 37 : 1) {
          expect(digestOf(make, [input.subarray(0, cut), input.subarray(cut)])).toBe(v[field]);
        }
      }
    }
  });
  it("BLAKE3: 1-byte chunks for every vector, all modes", () => {
    for (const v of VECTORS.cases) {
      for (const [, make, field] of MODES) {
        expect(digestOf(make, chunked(vectorInput(v.input_len), 1))).toBe(v[field]);
      }
    }
  });
  it("SHA-256: every 2-way split and 1-byte chunks equal sha256sum", () => {
    for (const len of [0, 1, 55, 56, 63, 64, 65, 1000, 4097]) {
      const input = new Uint8Array(randomBytes(len));
      const expected = sha256Ref(input);
      expect(digestOf(createSha256, chunked(input, 1))).toBe(expected);
      for (let cut = 0; cut <= len; cut++) {
        expect(digestOf(createSha256, [input.subarray(0, cut), input.subarray(cut)])).toBe(
          expected,
        );
      }
    }
  });
});

describe("R3 clone() mid-stream", () => {
  const input = vectorInput(10_000);
  const cases: Array<[string, () => Hasher, (b: Uint8Array) => string]> = [
    ["sha256", createSha256, sha256Ref],
    [
      "blake3 keyed",
      () => createBlake3({ key: KEY }),
      (b) => digestOf(() => createBlake3({ key: KEY }), [b]),
    ],
  ];
  for (const [name, make, ref] of cases) {
    it(name, () => {
      const h = make();
      h.update(input.subarray(0, 3000));
      const prefix = h.clone();
      h.update(input.subarray(3000));
      expect(toHex(prefix.digest())).toBe(ref(input.subarray(0, 3000)));
      expect(toHex(h.digest())).toBe(ref(input));
    });
  }
});

describe("R4 SHA-256 and LFS pointers equal the references", () => {
  const dir = mkdtempSync(join(tmpdir(), "x1c-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const corpus: Array<[string, Uint8Array]> = [
    ["empty", new Uint8Array(0)],
    ["text", enc.encode("hello lfs\n")],
    ["3 MiB random", new Uint8Array(randomBytes(3 << 20))],
  ];
  for (const [name, bytes] of corpus) {
    it(name, async () => {
      const file = join(dir, name.replace(/\W/g, "_"));
      writeFileSync(file, bytes);
      expect(digestOf(createSha256, chunked(bytes, 65536))).toBe(sha256Ref(bytes));
      const gitPointer = execFileSync("git", ["lfs", "pointer", `--file=${file}`], {
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      }).toString();
      expect(await lfsPointer(chunked(bytes, 65536))).toBe(gitPointer);
    });
  }
});

describe("R5 bounded memory", () => {
  const gc = (globalThis as { gc?: () => void }).gc;
  const cases: Array<[string, () => Hasher]> = [
    ["sha256", createSha256],
    ["blake3", () => createBlake3()],
    ["blake3 keyed", () => createBlake3({ key: KEY })],
  ];
  for (const [name, make] of cases) {
    it(`${name}: 128 MiB in fresh 64 KiB chunks`, () => {
      expect(gc).toBeTypeOf("function");
      gc?.();
      const base = process.memoryUsage().arrayBuffers;
      let peak = base;
      const h = make();
      for (let i = 0; i < 2048; i++) {
        h.update(new Uint8Array(65536).fill(i & 0xff));
        if (i % 64 === 63) {
          gc?.();
          peak = Math.max(peak, process.memoryUsage().arrayBuffers);
        }
      }
      expect(h.digest().length).toBe(32);
      expect(peak - base).toBeLessThan(32 * 1024 * 1024);
    }, 300_000);
  }
});

describe("R6 portable modules import nothing from node:", () => {
  it("src/ is free of node: imports", () => {
    const srcDir = join(import.meta.dirname, "../src");
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    expect(files).toContain("hashes.ts");
    for (const f of files) {
      expect(readFileSync(join(srcDir, f), "utf8"), f).not.toMatch(/from\s+["']node:/);
    }
  });
});
