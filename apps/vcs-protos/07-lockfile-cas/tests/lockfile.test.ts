import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type FaultPoint, faultyFiles } from "../src/adapters/faulty.js";
import { memAtomicFiles } from "../src/adapters/mem.js";
import { nodeAtomicFiles } from "../src/adapters/node.js";
import { type AtomicFiles, breakLock, casRef, readRef } from "../src/lockfile.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const oid = (n: number) => n.toString(16).padStart(40, "0");
const REF = "refs/heads/main";
const enc = new TextEncoder();

const ADAPTERS: Array<[string, () => AtomicFiles]> = [
  ["memory", () => memAtomicFiles()],
  ["node fs", () => nodeAtomicFiles(tmp("x2-"))],
];

for (const [name, make] of ADAPTERS) {
  describe(`R1 one winner among 100 concurrent compare-and-sets (${name})`, () => {
    it("exactly one ok; final value is the winner's; no lock left", async () => {
      const files = make();
      expect(await casRef(files, REF, undefined, oid(1))).toBe("ok");
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) => casRef(files, REF, oid(1), oid(100 + i))),
      );
      const winners = results.flatMap((r, i) => (r === "ok" ? [i] : []));
      expect(winners.length).toBe(1);
      expect(results.every((r) => r === "ok" || r === "mismatch" || r === "locked")).toBe(true);
      expect(await readRef(files, REF)).toBe(oid(100 + (winners[0] ?? -1)));
      expect(await files.exists(`${REF}.lock`)).toBe(false);
    });
    it("expected-value semantics: create, mismatch, update, delete", async () => {
      const files = make();
      expect(await casRef(files, REF, oid(9), oid(1))).toBe("mismatch");
      expect(await casRef(files, REF, undefined, oid(1))).toBe("ok");
      expect(await casRef(files, REF, undefined, oid(2))).toBe("mismatch");
      expect(await casRef(files, REF, oid(1), oid(2))).toBe("ok");
      expect(await casRef(files, REF, oid(2), undefined)).toBe("ok");
      expect(await readRef(files, REF)).toBeUndefined();
    });
  });

  describe(`R4 crash safety: the process dies at each step (${name})`, () => {
    // [point, operation, expected ref value, lock left behind]
    const cases: Array<[FaultPoint, "update" | "delete", "old" | "new", boolean]> = [
      ["createExclusive", "update", "old", false],
      ["after-createExclusive", "update", "old", true],
      ["replace", "update", "old", true],
      ["after-replace", "update", "new", false],
      ["remove", "delete", "old", true],
    ];
    for (const [at, op, value, lockLeft] of cases) {
      it(`${op}, crash at ${at}: ref ${value}, lock ${lockLeft ? "left (locked until breakLock)" : "absent"}`, async () => {
        const files = make();
        expect(await casRef(files, REF, undefined, oid(1))).toBe("ok");
        const next = op === "update" ? oid(2) : undefined;
        await expect(casRef(faultyFiles(files, at), REF, oid(1), next)).rejects.toThrow(
          /injected crash/,
        );
        expect(await readRef(files, REF)).toBe(value === "old" ? oid(1) : next);
        expect(await files.exists(`${REF}.lock`)).toBe(lockLeft);
        const current = await readRef(files, REF);
        if (lockLeft) {
          expect(await casRef(files, REF, current, oid(3))).toBe("locked");
          expect(await breakLock(files, REF)).toBe(true);
        }
        expect(await casRef(files, REF, current, oid(3))).toBe("ok");
      });
    }
  });

  describe(`R5b ref values are validated, never guessed (${name})`, () => {
    it("an empty ref, garbage, or a symref is an error, not 'absent' or a value", async () => {
      for (const bad of ["", "not-an-oid", "ref: refs/heads/other"]) {
        const files = make();
        await files.createExclusive(REF, enc.encode(`${bad}\n`));
        await expect(readRef(files, REF)).rejects.toThrow(/broken|symbolic/);
        await expect(casRef(files, REF, undefined, oid(1))).rejects.toThrow(/broken|symbolic/);
        expect(await files.exists(`${REF}.lock`)).toBe(false);
      }
    });
  });

  describe(`R5 primitives (${name})`, () => {
    it("createExclusive refuses an existing path and leaves it unchanged", async () => {
      const files = make();
      expect(await files.createExclusive("a/b", enc.encode("one"))).toBe(true);
      expect(await files.createExclusive("a/b", enc.encode("two"))).toBe(false);
      const parts: Uint8Array[] = [];
      for await (const c of files.read("a/b")) parts.push(c);
      expect(Buffer.concat(parts).toString()).toBe("one");
    });
    it("replace moves content over an existing target and removes the source", async () => {
      const files = make();
      await files.createExclusive("t", enc.encode("old"));
      await files.createExclusive("s", enc.encode("new"));
      await files.replace("s", "t");
      expect(await files.exists("s")).toBe(false);
      const parts: Uint8Array[] = [];
      for await (const c of files.read("t")) parts.push(c);
      expect(Buffer.concat(parts).toString()).toBe("new");
    });
  });
}

describe("R2 eight Node processes racing on one directory", () => {
  it("exactly one ok, and the ref holds that process's value", async () => {
    const root = tmp("x2-race-");
    const files = nodeAtomicFiles(root);
    expect(await casRef(files, REF, undefined, oid(1))).toBe("ok");
    const startAt = Date.now() + 1500;
    const child = join(import.meta.dirname, "race-child.ts");
    const outputs = await Promise.all(
      Array.from(
        { length: 8 },
        (_, i) =>
          new Promise<string>((resolve, reject) => {
            const p = spawn(
              process.execPath,
              ["--import", "tsx", child, root, String(200 + i), oid(1)],
              {
                env: { ...process.env, START_AT: String(startAt) },
              },
            );
            let out = "";
            p.stdout.on("data", (d) => (out += d));
            p.on("error", reject);
            p.on("close", (code) =>
              code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`)),
            );
          }),
      ),
    );
    const winners = outputs.filter((o) => o.endsWith(":ok"));
    expect(winners.length, outputs.join(" ")).toBe(1);
    expect(
      outputs.every((o) => /:(ok|mismatch|locked)$/.test(o)),
      outputs.join(" "),
    ).toBe(true);
    const winnerId = Number(winners[0]?.split(":")[0]);
    expect(await readRef(files, REF)).toBe(String(winnerId).padStart(40, "0"));
  }, 60_000);
});

describe("R3 native git interop on a real repository", () => {
  const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "a",
    GIT_AUTHOR_EMAIL: "a@x",
    GIT_COMMITTER_NAME: "a",
    GIT_COMMITTER_EMAIL: "a@x",
  };
  const setup = () => {
    const repo = tmp("x2-git-");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], {
        env: GIT_ENV,
        stdio: ["ignore", "pipe", "pipe"],
      })
        .toString()
        .trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "f"), "1");
    git("add", "f");
    git("commit", "-q", "-m", "one");
    const c1 = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "f"), "2");
    git("commit", "-q", "-am", "two");
    const c2 = git("rev-parse", "HEAD");
    return { repo, git, c1, c2, files: nodeAtomicFiles(join(repo, ".git")) };
  };

  it("(a) while our lock is held, git update-ref fails", async () => {
    const { git, c1, files } = setup();
    expect(await files.createExclusive(`${REF}.lock`, enc.encode(`${c1}\n`))).toBe(true);
    expect(() => git("update-ref", REF, c1)).toThrow(/lock|exists/i);
    await breakLock(files, REF);
  });
  it("(b) while a git-style lock exists, casRef reports locked and changes nothing", async () => {
    const { repo, git, c1, c2, files } = setup();
    writeFileSync(join(repo, ".git", `${REF}.lock`), "");
    expect(await casRef(files, REF, c2, c1)).toBe("locked");
    expect(git("rev-parse", REF)).toBe(c2);
  });
  it("(c) a value written by casRef is what git reports; fsck is clean", async () => {
    const { git, c1, c2, files } = setup();
    expect(await casRef(files, REF, c2, c1)).toBe("ok");
    expect(git("rev-parse", REF)).toBe(c1);
    expect(git("fsck", "--strict")).toBe("");
  });
  it("(e) four of our processes and four `git update-ref <new> <old>` racing: exactly one winner overall", async () => {
    const { repo, git, c1, c2, files } = setup();
    const gitDir = join(repo, ".git");
    // Point main back at c1; every contender expects c1 and tries to move it to its own value.
    git("update-ref", REF, c1);
    const child = join(import.meta.dirname, "race-child.ts");
    const startAt = Date.now() + 1500;
    const ours = Array.from(
      { length: 4 },
      (_, i) =>
        new Promise<boolean>((resolve, reject) => {
          const p = spawn(
            process.execPath,
            ["--import", "tsx", child, gitDir, String(300 + i), c1],
            {
              env: { ...process.env, START_AT: String(startAt) },
            },
          );
          let out = "";
          p.stdout.on("data", (d) => (out += d));
          p.on("error", reject);
          p.on("close", () => resolve(out.trim().endsWith(":ok")));
        }),
    );
    // git's contenders all try to set main to c2 (a real commit), expecting c1.
    const theirs = Array.from(
      { length: 4 },
      () =>
        new Promise<boolean>((resolve) => {
          setTimeout(
            () => {
              const p = spawn("git", ["-C", repo, "update-ref", REF, c2, c1], {
                env: GIT_ENV,
                stdio: "ignore",
              });
              p.on("close", (code) => resolve(code === 0));
            },
            Math.max(0, startAt - Date.now()),
          );
        }),
    );
    const results = await Promise.all([...ours, ...theirs]);
    expect(results.filter(Boolean).length, results.join(",")).toBe(1);
    const final = await readRef(files, REF);
    const winner = results.indexOf(true);
    expect(final).toBe(winner < 4 ? String(300 + winner).padStart(40, "0") : c2);
    expect(await files.exists(`${REF}.lock`)).toBe(false);
  }, 60_000);
  it("(f) git holding a transaction lock (update-ref --stdin, prepared) makes casRef report locked", async () => {
    const { repo, git, c1, c2, files } = setup();
    const p = spawn("git", ["-C", repo, "update-ref", "--stdin"], { env: GIT_ENV });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    const until = async (re: RegExp) => {
      for (let i = 0; i < 200 && !re.test(out); i++) await new Promise((r) => setTimeout(r, 10));
      expect(out).toMatch(re);
    };
    p.stdin.write(`start\nupdate ${REF} ${c1} ${c2}\nprepare\n`);
    await until(/prepare: ok/);
    expect(await files.exists(`${REF}.lock`)).toBe(true);
    expect(await casRef(files, REF, c2, c1)).toBe("locked");
    p.stdin.end("commit\n");
    await new Promise((r) => p.on("close", r));
    expect(git("rev-parse", REF)).toBe(c1);
  });
  it("(g) after git pack-refs, reads see the packed value; updates write a loose ref git honours", async () => {
    const { git, c1, c2, files } = setup();
    git("pack-refs", "--all");
    expect(await readRef(files, REF)).toBe(c2);
    expect(await casRef(files, REF, undefined, c1)).toBe("mismatch");
    expect(await casRef(files, REF, c2, c1)).toBe("ok");
    expect(git("rev-parse", REF)).toBe(c1);
  });
  it("(h) deleting a ref that is also in packed-refs is refused until packed-refs support (X5)", async () => {
    const { git, c2, files } = setup();
    git("pack-refs", "--all");
    await expect(casRef(files, REF, c2, undefined)).rejects.toThrow(/packed-refs/);
    expect(git("rev-parse", REF)).toBe(c2);
    expect(await files.exists(`${REF}.lock`)).toBe(false);
  });
  it("(d) a value written by git update-ref is what we read", async () => {
    const { git, c1, files } = setup();
    git("update-ref", REF, c1);
    expect(await readRef(files, REF)).toBe(c1);
  });
});

describe("R4b a lock whose write fails is rolled back (Node)", () => {
  it("createExclusive removes the half-written lock and rethrows", async () => {
    const root = tmp("x2-torn-");
    const files = nodeAtomicFiles(root, { failWriteForTest: true });
    await expect(files.createExclusive("refs/heads/x.lock", enc.encode("abc"))).rejects.toThrow(
      /write failed/,
    );
    expect(await nodeAtomicFiles(root).exists("refs/heads/x.lock")).toBe(false);
  });
});

describe("R5c remove reports only what it removed (Node)", () => {
  it("two concurrent removes of one file: exactly one returns true", async () => {
    const files = nodeAtomicFiles(tmp("x2-rm-"));
    await files.createExclusive("a", enc.encode("x"));
    const r = await Promise.all([files.remove("a"), files.remove("a")]);
    expect(r.filter(Boolean).length).toBe(1);
  });
});
