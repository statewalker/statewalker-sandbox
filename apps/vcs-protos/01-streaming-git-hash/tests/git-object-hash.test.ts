import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashGitObject, type Sha1Impl, SizeMismatchError } from "../src/git-object-hash.js";

const IMPLS: Sha1Impl[] = ["vcs", "noble", "node"];

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
          type as "blob",
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
