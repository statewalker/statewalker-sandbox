/** Node-only: builds the fixtures with real git, git-lfs, node:zlib and node:crypto. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { Fixtures } from "../src/types.js";

/** Fixed seed and git dates: every runner, on every machine with the same git, gets the same bytes. */
export const FIXTURE_SEED = 0x5eed_0a0a;
const DATE = "2026-01-01T00:00:00Z";

/** xorshift32 — deterministic random bytes, so a failing fixture can be regenerated from its seed. */
function prng(seed: number) {
  let x = seed >>> 0 || 1;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      out[i] = x & 0xff;
    }
    return out;
  };
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_DATE: DATE,
  GIT_COMMITTER_DATE: DATE,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "a",
  GIT_AUTHOR_EMAIL: "a@x",
  GIT_COMMITTER_NAME: "a",
  GIT_COMMITTER_EMAIL: "a@x",
};
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const enc = new TextEncoder();

export function makeFixtures(seed = FIXTURE_SEED): Fixtures {
  const randomBytes = prng(seed);
  const dir = mkdtempSync(join(tmpdir(), "x0a-"));
  try {
    // The repository lives in its own subdirectory: the LFS oracle files written into `dir` must not
    // be committed into the pack fixtures (they once were, and tripled the pack size).
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const git = (args: string[], input?: Uint8Array | string) =>
      execFileSync("git", ["-C", repo, ...args], { env: GIT_ENV, input });

    const objects: Array<[string, "blob" | "commit", Uint8Array]> = [
      ["empty blob", "blob", new Uint8Array(0)],
      ["text blob", "blob", enc.encode("hello world\n")],
      ["binary blob", "blob", Uint8Array.from([0, 255, 0, 10, 13, 0])],
      ["300 KiB random blob", "blob", randomBytes(300 * 1024)],
      [
        "commit with mergetag",
        "commit",
        enc.encode(
          "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor a <a@x> 1 +0000\ncommitter a <a@x> 1 +0000\nmergetag object 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n type commit\n tag v1\n\nmsg\n",
        ),
      ],
    ];
    const gitObjects = objects.map(([name, type, bytes]) => ({
      name,
      type,
      b64: b64(bytes),
      id: git(["hash-object", "--literally", "-t", type, "--stdin"], bytes).toString().trim(),
    }));

    // The official file names the derive-key context `context_string`; map it explicitly
    // (a cast here once hid the mismatch and every derive_key check failed).
    const official = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../03-sha256-blake3/tests/fixtures/blake3-test-vectors.json"),
        "utf8",
      ),
    ) as { key: string; context_string: string; cases: Fixtures["blake3"]["cases"] };
    const blake3: Fixtures["blake3"] = {
      key: official.key,
      context: official.context_string,
      cases: official.cases,
    };

    const shaInputs: Array<[string, Uint8Array]> = [
      ["empty", new Uint8Array(0)],
      ["text", enc.encode("hello lfs\n")],
      ["256 KiB random", randomBytes(256 * 1024)],
    ];
    const sha256 = shaInputs.map(([name, bytes]) => ({
      name,
      b64: b64(bytes),
      hex: createHash("sha256").update(bytes).digest("hex"),
    }));
    const hasLfs = spawnSync("git", ["lfs", "version"], { env: GIT_ENV }).status === 0;
    const lfs = shaInputs.map(([name, bytes]) => {
      if (hasLfs) {
        const file = join(dir, `lfs-${name.replace(/\W/g, "_")}`);
        writeFileSync(file, bytes);
        const r = spawnSync("git", ["lfs", "pointer", `--file=${file}`], { env: GIT_ENV });
        return { name, pointer: r.stdout.toString(), oracle: "git-lfs" as const };
      }
      const hex = createHash("sha256").update(bytes).digest("hex");
      const pointer =
        bytes.length === 0
          ? ""
          : `version https://git-lfs.github.com/spec/v1\noid sha256:${hex}\nsize ${bytes.length}\n`;
      return { name, pointer, oracle: "spec" as const };
    });

    const zInputs = Array.from({ length: 60 }, (_, i) => {
      const size = [0, 1, 50, 700, 4096, 30_000][i % 6] ?? 0;
      return i % 2 ? randomBytes(size) : enc.encode("z".repeat(size));
    });
    const zStreams = zInputs.map((b) => new Uint8Array(deflateSync(b)));
    const concatenated = Buffer.concat([...zStreams, Buffer.from("TRAILING")]);
    const zlib = {
      concatenatedB64: concatenated.toString("base64"),
      lengths: zStreams.map((s) => s.length),
      inputSha256: zInputs.map((b) => createHash("sha256").update(b).digest("hex")),
    };

    git(["init", "-q"]);
    let text = "line\n".repeat(1500);
    for (let v = 0; v < 4; v++) {
      text = text.replace("line\n", `edit ${v}\n`) + `more ${v}\n`.repeat(40);
      writeFileSync(join(repo, "big.txt"), text);
      writeFileSync(join(repo, `r${v}.bin`), randomBytes(10_000));
      git(["add", "-A"]);
      git(["commit", "-q", "-m", `v${v}`]);
    }
    const packs = (["ofs", "ref"] as const).map((kind) => {
      const base = join(dir, `pack-${kind}`);
      git(
        ["pack-objects", "--revs", "-q", ...(kind === "ofs" ? ["--delta-base-offset"] : []), base],
        "HEAD\n",
      );
      const name = readdirSync(dir).find(
        (f) => f.startsWith(`pack-${kind}-`) && f.endsWith(".pack"),
      );
      if (!name) throw new Error("pack not produced");
      // verify-pack -v: "<sha> <type> <size> <size-in-packfile> <offset> [<depth> <base>]"
      const entries = execFileSync("git", ["verify-pack", "-v", join(dir, name)], { env: GIT_ENV })
        .toString()
        .split("\n")
        .filter((l) => /^[0-9a-f]{40} /.test(l))
        .map((l) => {
          const [, type = "", size, packedSize, offset] = l.split(/\s+/);
          return {
            offset: Number(offset),
            type,
            size: Number(size),
            packedSize: Number(packedSize),
          };
        })
        .sort((a, b) => a.offset - b.offset);
      return { kind, b64: b64(readFileSync(join(dir, name))), entries };
    });

    return { seed, gitObjects, blake3, sha256, lfs, zlib, packs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
