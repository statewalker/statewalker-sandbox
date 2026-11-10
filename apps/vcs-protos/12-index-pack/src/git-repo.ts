/**
 * Node-only test helpers: build repositories with history by native git and pack them. Used by
 * the Node tests and by scripts/make-fixture.ts.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: tmpdir(),
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "a@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "c@example.com",
};
export const git = (cwd: string, args: string[], input?: string | Uint8Array) =>
  execFileSync("git", args, { cwd, env: gitEnv, input, maxBuffer: 1 << 30 });

/** xorshift bytes: deterministic and incompressible. */
export function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 255;
  }
  return out;
}

/** A repository with `commits` commits editing a handful of text files (deltas between versions). */
export function repoWithHistory(commits: number, opts: { bigBlobBytes?: number } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "x6-repo-"));
  git(dir, ["init", "-q", "-b", "main", "."]);
  const lines = Array.from(
    { length: 400 },
    (_, i) => `line ${i}: ${"lorem ipsum dolor sit amet ".repeat(2)}`,
  );
  for (let c = 0; c < commits; c++) {
    for (let f = 0; f < 4; f++) {
      const edit = [...lines];
      for (let k = 0; k <= c; k++)
        edit[(k * 37 + f * 11) % edit.length] = `edited ${c}/${k} in file ${f}`;
      writeFileSync(join(dir, `file${f}.txt`), `${edit.join("\n")}\n`);
    }
    writeFileSync(join(dir, `small-${c % 7}.bin`), noise(200 + c, c + 1));
    if (opts.bigBlobBytes && (c === 0 || c === commits - 1)) {
      const big = noise(opts.bigBlobBytes, 99);
      if (c > 0) big[12345] = (big[12345] as number) ^ 0xff; // one byte changed: a delta against a large base
      writeFileSync(join(dir, "big.bin"), big);
    }
    git(dir, ["add", "-A"]);
    git(
      dir,
      [
        "-c",
        `user.name=x`,
        "commit",
        "-q",
        "-m",
        `commit ${c}`,
        "--date",
        `${1700000000 + c * 60} +0000`,
      ],
      undefined,
    );
  }
  return dir;
}

/** The pack native git writes for all objects; `ofs` chooses OFS_DELTA over REF_DELTA. */
export function packAll(repo: string, ofs: boolean): Uint8Array {
  const objects = git(repo, ["rev-list", "--objects", "--all"]);
  const args = ["pack-objects", "--stdout", "-q", "--window=50", "--depth=50"];
  if (ofs) args.push("--delta-base-offset");
  return new Uint8Array(git(repo, args, objects));
}
