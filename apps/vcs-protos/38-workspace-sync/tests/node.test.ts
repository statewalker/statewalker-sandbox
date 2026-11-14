import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterAll, describe, expect, it } from "vitest";
import { gitEnv } from "../../12-index-pack/src/git-repo.js";
import { rng } from "../../29-merge/tests/tree-harness.js";
import {
  commitFolder,
  type Endpoint,
  folderFiles,
  headOf,
  mergeInto,
  openEndpoint,
  sync,
} from "../src/workspace.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const enc = new TextEncoder();
let clock = 1_700_000_000;
const now = () => clock++;

async function endpoint(name: string): Promise<Endpoint> {
  return openEndpoint({ name, folder: new MemFilesApi(), storage: new MemFilesApi(), now });
}
const put = (ep: Endpoint, path: string, text: string) =>
  ep.folder.write(`/${path}`, [enc.encode(text)]);
const del = (ep: Endpoint, path: string) => ep.folder.remove(`/${path}`);
async function same(eps: Endpoint[]) {
  const heads = await Promise.all(eps.map(headOf));
  const files = await Promise.all(eps.map(folderFiles));
  for (let i = 1; i < eps.length; i++) {
    expect(heads[i], `${eps[i]?.name} head`).toBe(heads[0]);
    expect(files[i], `${eps[i]?.name} files`).toEqual(files[0]);
  }
  return files[0] as Record<string, string>;
}
/** a final round: every pair, both ways, twice */
async function settle(eps: Endpoint[]) {
  for (let round = 0; round < 2; round++)
    for (let i = 0; i < eps.length; i++)
      for (let j = i + 1; j < eps.length; j++) await sync(eps[i] as Endpoint, eps[j] as Endpoint);
}

describe("S1 non-overlapping edits merge cleanly and converge", () => {
  it("three endpoints, different files, random sync orders", async () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rand = rng(seed);
      const [a, b, c] = [await endpoint("a"), await endpoint("b"), await endpoint("c")] as [
        Endpoint,
        Endpoint,
        Endpoint,
      ];
      await put(a, "shared/base.txt", "base\n");
      await settle([a, b, c]);
      const eps = [a, b, c];
      const conflicts: string[] = [];
      for (let step = 0; step < 12; step++) {
        const ep = eps[Math.floor(rand() * 3)] as Endpoint;
        const r = rand();
        const mine = `${ep.name}/f${Math.floor(rand() * 4)}.txt`;
        if (r < 0.5) await put(ep, mine, `${ep.name} ${step}\n`);
        else if (r < 0.65) await del(ep, mine).catch(() => {});
        else if (r < 0.75) await put(ep, `${ep.name}/dir${step}/new.txt`, "deep\n");
        else {
          const other = eps[Math.floor(rand() * 3)] as Endpoint;
          if (other !== ep) conflicts.push(...(await sync(ep, other)).conflicts);
        }
      }
      await settle(eps);
      const files = await same(eps);
      expect(conflicts, `seed ${seed}`).toEqual([]);
      expect(files["shared/base.txt"]).toBe("base\n");
    }
  }, 300_000);
});

describe("S2 conflicting edits converge, reported", () => {
  it("same lines on two endpoints; an edit against a delete", async () => {
    for (const firstMerger of [0, 1]) {
      const [a, b, c] = [await endpoint("a"), await endpoint("b"), await endpoint("c")] as [
        Endpoint,
        Endpoint,
        Endpoint,
      ];
      await put(a, "doc.txt", "one\ntwo\nthree\n");
      await put(a, "gone.txt", "keep me\n");
      await settle([a, b, c]);
      await put(a, "doc.txt", "one\nTWO by a\nthree\n");
      await put(b, "doc.txt", "one\ntwo by b\nthree\n");
      await put(a, "gone.txt", "edited\n");
      await del(b, "gone.txt");
      const r = firstMerger === 0 ? await sync(a, b) : await sync(b, a);
      expect(r.conflicts.sort()).toEqual(["doc.txt", "gone.txt"]);
      await settle([a, b, c]);
      const files = await same([a, b, c]);
      expect(files["doc.txt"]).toContain("<<<<<<<");
      expect(files["doc.txt"]).toContain("TWO by a");
      expect(files["doc.txt"]).toContain("two by b");
    }
  }, 120_000);
});

describe("S3 property test: 200 random schedules converge, no untouched edit lost", () => {
  it("edits, deletes and syncs interleaved over three endpoints", async () => {
    const paths = ["a.txt", "b.txt", "d/c.txt", "d/e/f.txt", "g.txt"];
    for (let seed = 100; seed < 300; seed++) {
      const rand = rng(seed);
      const eps = [await endpoint("a"), await endpoint("b"), await endpoint("c")];
      // who touched each path, and what the last touch left (undefined: deleted)
      const touched = new Map<string, Set<string>>();
      const last = new Map<string, string | undefined>();
      for (let step = 0; step < 15; step++) {
        const ep = eps[Math.floor(rand() * 3)] as Endpoint;
        const r = rand();
        const p = paths[Math.floor(rand() * paths.length)] as string;
        if (r < 0.55) {
          const text = `${ep.name} ${seed} ${step}\n`;
          await put(ep, p, text);
          touched.set(p, (touched.get(p) ?? new Set()).add(ep.name));
          last.set(p, text);
        } else if (r < 0.7) {
          if (await ep.folder.exists(`/${p}`)) {
            await del(ep, p);
            touched.set(p, (touched.get(p) ?? new Set()).add(ep.name));
            last.set(p, undefined);
          }
        } else {
          const other = eps[Math.floor(rand() * 3)] as Endpoint;
          if (other !== ep) await sync(ep, other);
        }
      }
      await settle(eps);
      const files = await same(eps);
      for (const [p, who] of touched)
        if (who.size === 1) expect(files[p], `seed ${seed} ${p}`).toBe(last.get(p));
    }
  }, 600_000);
});

describe("S4 deterministic merges", () => {
  /** an endpoint's twin: the same folder and repository, copied */
  async function twin(ep: Endpoint): Promise<Endpoint> {
    const copy = async (from: MemFilesApi | Endpoint["folder"]) => {
      const to = new MemFilesApi();
      for await (const e of from.list("/", { recursive: true })) {
        if (e.kind !== "file") continue;
        const parts: Uint8Array[] = [];
        for await (const p of from.read(e.path)) parts.push(p);
        await to.write(e.path, parts);
      }
      return to;
    };
    return openEndpoint({
      name: ep.name,
      folder: await copy(ep.folder),
      storage: await copy(ep.storage),
      now,
    });
  }

  for (const conflicting of [false, true])
    it(`two endpoints merging each other's heads apart make one commit (${conflicting ? "conflicting" : "disjoint"} edits)`, async () => {
      const [a, b] = [await endpoint("a"), await endpoint("b")] as [Endpoint, Endpoint];
      await put(a, "x.txt", "x\n");
      await sync(a, b);
      if (conflicting) {
        await put(a, "x.txt", "x by a\n");
        await put(b, "x.txt", "x by b\n");
      } else {
        await put(a, "a.txt", "from a\n");
        await put(b, "b.txt", "from b\n");
      }
      // both edits committed, then copies taken before either merges: each side then merges the
      // other's head on its own
      await commitFolder(a);
      await commitFolder(b);
      const aBefore = await twin(a);
      const bBefore = await twin(b);
      const ma = await sync(a, bBefore, { oneWay: true });
      clock += 100; // a later merge must not change the commit
      const mb = await sync(b, aBefore, { oneWay: true });
      expect(ma.conflicts).toEqual(conflicting ? ["x.txt"] : []);
      expect(ma.head).toBe(mb.head);
      // one way: the peer was not touched
      expect(await headOf(bBefore)).not.toBe(ma.head);
      await sync(a, b);
      expect(await headOf(a)).toBe(ma.head);
      expect(await headOf(b)).toBe(ma.head);
    });
});

describe("S7 review cases: crashes, edits during a sync, directories, renames, unrelated starts", () => {
  /** a FilesApi whose `write` can be made to fail, or to run a hook first */
  function faulty(inner: MemFilesApi) {
    const ctl = {
      failAt: 0,
      writes: 0,
      before: undefined as undefined | ((path: string) => Promise<void>),
    };
    const files = new Proxy(inner, {
      get(t, k, r) {
        if (k === "write")
          return async (
            path: string,
            content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
          ) => {
            ctl.writes++;
            if (ctl.failAt && ctl.writes === ctl.failAt)
              throw new Error(`injected failure writing ${path}`);
            const hook = ctl.before;
            if (hook) {
              ctl.before = undefined;
              await hook(path);
            }
            return t.write(path, content);
          };
        const v = Reflect.get(t, k, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    return { files, ctl };
  }
  const dirsOf = async (ep: Endpoint) => {
    const out: string[] = [];
    for await (const e of ep.folder.list("/", { recursive: true }))
      if (e.kind === "directory") out.push(e.path);
    return out.sort();
  };

  it("a checkout that fails halfway loses none of the peer's edits", async () => {
    const f = faulty(new MemFilesApi());
    const a = await openEndpoint({ name: "a", folder: f.files, storage: new MemFilesApi(), now });
    const b = await endpoint("b");
    await put(a, "x.txt", "base\n");
    await put(a, "y.txt", "base\n");
    await sync(a, b);
    await put(b, "x.txt", "x by b\n");
    await put(b, "y.txt", "y by b\n");
    f.ctl.writes = 0;
    f.ctl.failAt = 2; // a's second folder write during the merge's checkout
    await expect(sync(a, b)).rejects.toThrow(/injected/);
    f.ctl.failAt = 0;
    await settle([a, b]);
    const files = await same([a, b]);
    expect(files["x.txt"]).toBe("x by b\n");
    expect(files["y.txt"]).toBe("y by b\n");
  });

  it("a transfer that fails halfway, at any object, does not break later syncs", async () => {
    for (let failAt = 2; failAt <= 8; failAt++) {
      const st = faulty(new MemFilesApi());
      const a = await openEndpoint({
        name: "a",
        folder: new MemFilesApi(),
        storage: st.files,
        now,
      });
      const b = await endpoint("b");
      await put(a, "x.txt", "x\n");
      await sync(a, b);
      await put(b, "d/y.txt", "y by b\n");
      await commitFolder(a);
      await commitFolder(b);
      st.ctl.writes = 0;
      st.ctl.failAt = failAt; // a commit must never be stored without its tree and blobs
      await sync(a, b).catch(() => {});
      st.ctl.failAt = 0;
      await settle([a, b]);
      expect((await same([a, b]))["d/y.txt"], `failing write ${failAt}`).toBe("y by b\n");
    }
  });

  it("an edit made in the folder while a sync runs (after the folder was committed) is kept", async () => {
    const st = faulty(new MemFilesApi());
    const folder = new MemFilesApi();
    const a = await openEndpoint({ name: "a", folder, storage: st.files, now });
    const b = await endpoint("b");
    await put(a, "x.txt", "base\n");
    await sync(a, b);
    await put(b, "x.txt", "from b\n");
    // the user types into x.txt while a receives b's objects: after a's folder was committed,
    // before the checkout that would bring b's version
    st.ctl.before = async () => {
      await folder.write("/x.txt", [enc.encode("typed during the sync\n")]);
    };
    await sync(a, b);
    expect(st.ctl.before).toBeUndefined(); // the hook ran
    await settle([a, b]);
    // the typed text was kept and committed; b had changed x.txt too, so the two now conflict,
    // and both are in the file, on every endpoint
    const x = (await same([a, b]))["x.txt"] as string;
    expect(x).toContain("typed during the sync");
    expect(x).toContain("from b");
  });

  it("no empty directories are left: a file becoming a directory and back, everything deleted", async () => {
    const [a, b] = [await endpoint("a"), await endpoint("b")] as [Endpoint, Endpoint];
    await put(a, "e", "a file\n");
    await put(a, "q/r/s.txt", "deep\n");
    await settle([a, b]);
    await del(a, "e");
    await put(a, "e/inner.txt", "now a directory\n");
    await settle([a, b]);
    expect(await dirsOf(b)).toContain("/e");
    for (const ep of [a]) for (const p of Object.keys(await folderFiles(ep))) await del(ep, p);
    await settle([a, b]);
    await same([a, b]);
    // b's folder was changed by syncs only: no directory left there (a's are the user's own)
    expect(await dirsOf(b)).toEqual([]);
  });

  it("renames and endpoints that started apart converge", async () => {
    const [a, b, c] = [await endpoint("a"), await endpoint("b"), await endpoint("c")] as [
      Endpoint,
      Endpoint,
      Endpoint,
    ];
    await put(a, "a/old.txt", "moving\n");
    await put(b, "b/own.txt", "b started alone\n"); // b's history is unrelated to a's at first
    await settle([a, b, c]);
    await del(a, "a/old.txt");
    await put(a, "a/new.txt", "moving\n");
    await settle([a, b, c]);
    const files = await same([a, b, c]);
    expect(files["a/new.txt"]).toBe("moving\n");
    expect(files["a/old.txt"]).toBeUndefined();
    expect(files["b/own.txt"]).toBe("b started alone\n");
  });
});

describe("S5 the history is a git repository", () => {
  it("git fsck --strict, and git log names each endpoint", async () => {
    const [a, b, c] = [await endpoint("a"), await endpoint("b"), await endpoint("c")] as [
      Endpoint,
      Endpoint,
      Endpoint,
    ];
    await put(a, "a.txt", "a\n");
    await put(b, "b.txt", "b\n");
    await put(c, "c/c.txt", "c\n");
    await settle([a, b, c]);
    const d = mkdtempSync(join(tmpdir(), "x17-"));
    dirs.push(d);
    for await (const e of a.storage.list("/", { recursive: true })) {
      if (e.kind !== "file") continue;
      const parts: Uint8Array[] = [];
      for await (const p of a.storage.read(e.path)) parts.push(p);
      mkdirSync(dirname(join(d, ".git", e.path)), { recursive: true });
      writeFileSync(join(d, ".git", e.path), Buffer.concat(parts));
    }
    const git = (args: string[]) => execFileSync("git", args, { cwd: d, env: gitEnv }).toString();
    git(["fsck", "--strict", "--no-dangling"]);
    const authors = new Set(git(["log", "--all", "--format=%an"]).split("\n").filter(Boolean));
    for (const n of ["a", "b", "c"]) expect(authors.has(n), n).toBe(true);
  });
});

describe("S6 portable", () => {
  it("src/ has no node: imports", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
    for (const f of readdirSync(src))
      expect(readFileSync(join(src, f), "utf8"), f).not.toMatch(/from "node:/);
  });
});

describe("S8 (X17b) a head moved from outside after a local commit is checked out exactly", () => {
  it("commitFolder records the commit as checked out, so its own edits are not taken for new ones", async () => {
    const a = await endpoint("a");
    const b = await endpoint("b");
    const copyObjects = async (from: Endpoint, to: Endpoint) => {
      for await (const e of from.storage.list("/objects", { recursive: true })) {
        if (e.kind !== "file" || (await to.storage.exists(e.path))) continue;
        const parts: Uint8Array[] = [];
        for await (const p of from.storage.read(e.path)) parts.push(p);
        await to.storage.write(e.path, parts);
      }
    };
    await put(a, "shared.txt", "one\ntwo\nthree\n");
    await sync(a, b);
    await put(a, "shared.txt", "ONE\ntwo\nthree\n");
    await put(b, "shared.txt", "one\ntwo\nTHREE\n");
    const bHead = (await commitFolder(b)) as string; // b's edit, committed once
    await commitFolder(a);
    // a merges b's commit; b's main is then moved to the merge from outside (as a push does)
    await copyObjects(b, a);
    await mergeInto(a, bHead);
    const merged = (await headOf(a)) as string;
    await copyObjects(a, b);
    const r = await b.repo.refs.batch([{ name: "refs/heads/main", old: bHead, new: merged }]);
    expect(r.ok).toBe(true);
    expect(await commitFolder(b)).toBe(merged); // checked out, nothing new committed
    expect(await folderFiles(b)).toEqual({ "shared.txt": "ONE\ntwo\nTHREE\n" });
  });
});

describe("S9 (review of #114) kept user edits survive a merge that loses its race, and a crash", () => {
  it("the merge of a kept edit losing its compare-and-swap is retried with the edit", async () => {
    const a = await endpoint("a");
    const b = await endpoint("b");
    const copyObjects = async (from: Endpoint, to: Endpoint) => {
      for await (const e of from.storage.list("/objects", { recursive: true })) {
        if (e.kind !== "file" || (await to.storage.exists(e.path))) continue;
        const parts: Uint8Array[] = [];
        for await (const p of from.storage.read(e.path)) parts.push(p);
        await to.storage.write(e.path, parts);
      }
    };
    await put(a, "p.txt", "one\ntwo\nthree\n");
    await sync(a, b);
    const x = (await headOf(b)) as string;
    // b's user edits line 3, uncommitted; a changes line 1 (Y), then an unrelated file (Z)
    await put(b, "p.txt", "one\ntwo\nTHREE\n");
    await put(a, "p.txt", "ONE\ntwo\nthree\n");
    const y = (await commitFolder(a)) as string;
    await put(a, "other.txt", "z\n");
    const z = (await commitFolder(a)) as string;
    await copyObjects(a, b);
    expect((await b.repo.refs.batch([{ name: "refs/heads/main", old: x, new: y }])).ok).toBe(true);
    // the second push lands just before the kept edit's merge moves main
    const batch = b.repo.refs.batch.bind(b.repo.refs);
    let raced = false;
    b.repo.refs.batch = async (cmds) => {
      if (!raced) {
        raced = true;
        await batch([{ name: "refs/heads/main", old: y, new: z }]);
      }
      return batch(cmds);
    };
    for (let i = 0; ; i++) {
      try {
        await commitFolder(b);
        break;
      } catch (err) {
        if (i > 5 || !/moved/.test(String(err))) throw err;
      }
    }
    expect(raced).toBe(true);
    const files = await folderFiles(b);
    expect(files["p.txt"]).toBe("ONE\ntwo\nTHREE\n"); // both changes, merged
    expect(files["other.txt"]).toBe("z\n");
  });
});
