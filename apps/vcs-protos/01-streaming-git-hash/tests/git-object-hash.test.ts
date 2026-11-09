import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSha1,
  type Hasher,
  hashGitObject as hashWith,
  SizeMismatchError,
} from "../src/git-object-hash.js";
import { createNodeSha1 } from "../src/node-sha1.js";

type Sha1Impl = "vcs" | "noble" | "node";
const IMPLS: Sha1Impl[] = ["vcs", "noble", "node"];
const FACTORIES: Record<Sha1Impl, () => Hasher> = {
  vcs: () => createSha1("vcs"),
  noble: () => createSha1("noble"),
  node: createNodeSha1,
};
const hashGitObject = (
  type: "blob" | "commit",
  size: number,
  content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  impl: Sha1Impl,
) => hashWith(type, size, content, FACTORIES[impl]);

/** The oracle: real git. */
function gitHashObject(type: string, content: Uint8Array): string {
  return execFileSync("git", ["hash-object", "--literally", "-t", type, "--stdin"], {
    input: content,
  })
    .toString()
    .trim();
}

function* chunked(bytes: Uint8Array, sizes: number[] | number): Iterable<Uint8Array> {
  let pos = 0;
  let i = 0;
  while (pos < bytes.length) {
    const n = typeof sizes === "number" ? sizes : (sizes[i++ % sizes.length] ?? 1);
    yield bytes.subarray(pos, pos + n);
    pos += n;
  }
}

const enc = new TextEncoder();
const COMMIT_WITH_EXOTIC_HEADERS = enc.encode(
  [
    "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    "author A U Thor <a@example.com> 1700000000 +0100",
    "committer A U Thor <a@example.com> 1700000000 +0100",
    "mergetag object 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    " type commit",
    " tag v1",
    "x-unknown-header kept verbatim",
    "",
    "message with trailing spaces   ",
    "",
  ].join("\n"),
);

const CORPUS: Array<[string, string, Uint8Array]> = [
  ["empty blob", "blob", new Uint8Array(0)],
  ["hello", "blob", enc.encode("hello\n")],
  ["binary with NULs", "blob", Uint8Array.from([0, 1, 0, 255, 0, 10, 13, 0])],
  ["non-UTF-8 latin1", "blob", Uint8Array.from([0xe9, 0x74, 0xe9, 0x0a])],
  ["exactly 64 bytes (one SHA block)", "blob", new Uint8Array(64).fill(97)],
  ["1 MiB random", "blob", new Uint8Array(randomBytes(1 << 20))],
  ["5 MiB + 1 random", "blob", new Uint8Array(randomBytes(5 * (1 << 20) + 1))],
  ["commit with mergetag and unknown header", "commit", COMMIT_WITH_EXOTIC_HEADERS],
];

describe("R1 ids equal git hash-object", () => {
  for (const [name, type, bytes] of CORPUS) {
    const expected = gitHashObject(type, bytes);
    for (const impl of IMPLS) {
      it(`${impl}: ${name}`, async () => {
        const id = await hashGitObject(
          type as "blob" | "commit",
          bytes.length,
          chunked(bytes, [65536, 7, 1, 4096]),
          impl,
        );
        expect(id).toBe(expected);
      });
    }
  }
});

describe("R2 digest is independent of chunking", () => {
  const input = new Uint8Array(randomBytes(1000));
  const expected = gitHashObject("blob", input);
  for (const impl of IMPLS) {
    it(`${impl}: every 2-way split`, async () => {
      for (let cut = 0; cut <= input.length; cut++) {
        const parts = [input.subarray(0, cut), input.subarray(cut)];
        expect(await hashGitObject("blob", input.length, parts, impl)).toBe(expected);
      }
    });
    it(`${impl}: 1-byte chunks and random chunkings`, async () => {
      expect(await hashGitObject("blob", input.length, chunked(input, 1), impl)).toBe(expected);
      for (let round = 0; round < 50; round++) {
        const sizes = Array.from({ length: 10 }, () => 1 + Math.floor(Math.random() * 200));
        expect(await hashGitObject("blob", input.length, chunked(input, sizes), impl)).toBe(
          expected,
        );
      }
    });
  }
});

describe("R3 the content stream is iterated exactly once", () => {
  for (const impl of IMPLS) {
    it(impl, async () => {
      const bytes = new Uint8Array(randomBytes(100_000));
      let iterations = 0;
      const once: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          iterations++;
          if (iterations > 1) throw new Error("stream iterated twice");
          const inner = chunked(bytes, 4096)[Symbol.iterator]();
          return { next: async () => inner.next() };
        },
      };
      const id = await hashGitObject("blob", bytes.length, once, impl);
      expect(iterations).toBe(1);
      expect(id).toBe(gitHashObject("blob", bytes));
    });
  }
});

describe("R4 bounded memory", () => {
  for (const impl of IMPLS) {
    it(`${impl}: 256 MiB through a reused 64 KiB buffer`, async () => {
      const CHUNK = 64 * 1024;
      const TOTAL = 256 * 1024 * 1024;
      const buf = new Uint8Array(CHUNK);
      const base = process.memoryUsage().arrayBuffers;
      let peak = base;
      async function* source(): AsyncIterable<Uint8Array> {
        for (let off = 0; off < TOTAL; off += CHUNK) {
          buf.fill(off & 0xff);
          peak = Math.max(peak, process.memoryUsage().arrayBuffers);
          yield buf;
        }
      }
      const id = await hashGitObject("blob", TOTAL, source(), impl);
      expect(id).toMatch(/^[0-9a-f]{40}$/);
      expect(peak - base).toBeLessThan(16 * 1024 * 1024);
    }, 300_000);
  }
});

describe("R5 size mismatch is reported, never guessed", () => {
  const bytes = enc.encode("twelve bytes");
  for (const impl of IMPLS) {
    it(`${impl}: fewer bytes than declared`, async () => {
      await expect(hashGitObject("blob", bytes.length + 1, [bytes], impl)).rejects.toBeInstanceOf(
        SizeMismatchError,
      );
    });
    it(`${impl}: more bytes than declared`, async () => {
      await expect(hashGitObject("blob", bytes.length - 1, [bytes], impl)).rejects.toBeInstanceOf(
        SizeMismatchError,
      );
    });
  }
});

describe("R6 implementations agree", () => {
  it("200 random inputs, random sizes and chunkings", async () => {
    for (let round = 0; round < 200; round++) {
      const size = Math.floor(Math.random() * 5000);
      const bytes = new Uint8Array(randomBytes(size));
      const sizes = Array.from({ length: 5 }, () => 1 + Math.floor(Math.random() * 300));
      const ids = await Promise.all(
        IMPLS.map((impl) => hashGitObject("blob", size, chunked(bytes, sizes), impl)),
      );
      expect(new Set(ids).size).toBe(1);
    }
  });
});

describe("R4b bounded memory when every chunk is a fresh buffer (catches retained references)", () => {
  const gc = (globalThis as { gc?: () => void }).gc;
  for (const impl of IMPLS) {
    it(`${impl}: 128 MiB in fresh 64 KiB chunks`, async () => {
      expect(gc, "tests must run with --expose-gc (vitest.config.ts execArgv)").toBeTypeOf(
        "function",
      );
      const CHUNK = 64 * 1024;
      const TOTAL = 128 * 1024 * 1024;
      gc?.();
      const base = process.memoryUsage().arrayBuffers;
      let peak = base;
      let n = 0;
      async function* source(): AsyncIterable<Uint8Array> {
        for (let off = 0; off < TOTAL; off += CHUNK) {
          if (++n % 64 === 0) {
            gc?.();
            peak = Math.max(peak, process.memoryUsage().arrayBuffers);
          }
          yield new Uint8Array(CHUNK).fill(off & 0xff);
        }
      }
      await hashGitObject("blob", TOTAL, source(), impl);
      // ArrayBuffer backing stores are released lazily after gc(), so samples include some
      // recent garbage (16.06 MiB seen once on Node 24 with a 16 MiB limit). Retaining every
      // chunk shows ~134 MiB, so 32 MiB still separates the two cleanly.
      expect(peak - base).toBeLessThan(32 * 1024 * 1024);
    }, 300_000);
  }
});

describe("R5b invalid declared sizes are rejected before hashing", () => {
  for (const size of [-1, 1.5, Number.NaN, 2 ** 53]) {
    it(`size ${size}`, async () => {
      await expect(hashGitObject("blob", size, [], "noble")).rejects.toBeInstanceOf(RangeError);
    });
  }
});

describe("R8 portable modules import nothing from node:", () => {
  it("every src module except node-sha1.ts and vendor/ is free of node: imports", () => {
    const dir = join(import.meta.dirname, "../src");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "node-sha1.ts");
    expect(files).toContain("git-object-hash.ts");
    for (const f of files) {
      expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/from\s+["']node:/);
    }
  });
});
