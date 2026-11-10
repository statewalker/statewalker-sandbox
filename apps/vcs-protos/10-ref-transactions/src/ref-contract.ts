/**
 * X5 contract (R2–R5), runnable in Node, Chromium and a Durable Object against any RefDb.
 */
import type { BatchResult, RefDb, RejectReason } from "./ref-db.js";
import { ZERO_OID } from "./ref-db.js";

/** Deterministic fake object ids: refs point at ids; object existence is not checked here. */
export const oid = (n: number) => n.toString(16).padStart(40, "a");
const IDENT = "A U Thor <author@example.com> 1700000000 +0000";

async function names(db: RefDb, prefix?: string) {
  const r: string[] = [];
  for await (const { name, oid } of db.list(prefix)) r.push(`${name}=${oid.slice(-4)}`);
  return r.join(",");
}
const rejected = (r: { rejected: { name: string; reason: RejectReason }[] }) =>
  r.rejected
    .map((x) => `${x.name}:${x.reason}`)
    .sort()
    .join(",");

export async function runRefContract(
  make: () => Promise<RefDb>,
): Promise<{ cases: number; failed: string[] }> {
  const failed: string[] = [];
  let cases = 0;
  const check = async (name: string, fn: (db: RefDb) => Promise<boolean | string>) => {
    cases++;
    try {
      const r = await fn(await make());
      if (r !== true) failed.push(r === false ? name : `${name}: ${r}`);
    } catch (e) {
      failed.push(`${name}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    }
  };

  await check("a batch of creates applies; read, resolve and list agree", async (db) => {
    const r = await db.batch([
      { name: "refs/heads/main", old: null, new: oid(1) },
      { name: "refs/tags/v1", old: null, new: oid(2) },
      { name: "refs/heads/dev", new: oid(3) },
    ]);
    if (!r.ok) return rejected(r);
    const main = await db.read("refs/heads/main");
    if (!main || !("oid" in main) || main.oid !== oid(1)) return "read";
    if ((await db.resolve("refs/tags/v1")) !== oid(2)) return "resolve";
    const all = await names(db);
    return all === "refs/heads/dev=aaa3,refs/heads/main=aaa1,refs/tags/v1=aaa2" || all;
  });
  await check("one mismatching old value rejects the whole batch", async (db) => {
    await db.batch([
      { name: "refs/heads/a", new: oid(1) },
      { name: "refs/heads/b", new: oid(2) },
    ]);
    const r = await db.batch([
      { name: "refs/heads/a", old: oid(1), new: oid(10) },
      { name: "refs/heads/b", old: oid(99), new: oid(20) },
      { name: "refs/heads/c", old: null, new: oid(30) },
    ]);
    if (r.ok || rejected(r) !== "refs/heads/b:mismatch") return `result ${rejected(r)}`;
    return (await names(db)) === "refs/heads/a=aaa1,refs/heads/b=aaa2" || (await names(db));
  });
  await check("'must not exist' on an existing ref is a mismatch", async (db) => {
    await db.batch([{ name: "refs/heads/a", new: oid(1) }]);
    const r = await db.batch([
      { name: "refs/heads/a", old: null, new: oid(2) },
      { name: "refs/heads/z", old: null, new: oid(3) },
    ]);
    return (
      !r.ok && rejected(r) === "refs/heads/a:mismatch" && (await names(db)) === "refs/heads/a=aaa1"
    );
  });
  await check("create, update and delete in one batch apply together", async (db) => {
    await db.batch([
      { name: "refs/heads/a", new: oid(1) },
      { name: "refs/heads/b", new: oid(2) },
    ]);
    const r = await db.batch([
      { name: "refs/heads/a", old: oid(1), new: oid(0x11) },
      { name: "refs/heads/b", old: oid(2), new: null },
      { name: "refs/heads/c", old: null, new: oid(3) },
    ]);
    if (!r.ok) return rejected(r);
    return (await names(db)) === "refs/heads/a=aa11,refs/heads/c=aaa3" || (await names(db));
  });
  await check("a refused name rejects the whole batch", async (db) => {
    for (const bad of [
      "refs/heads/a..b",
      "refs/heads/x.lock",
      "refs/heads/sp ace",
      "foo",
      "refs/heads/@{x}",
      "refs/heads/end/",
    ]) {
      const r = await db.batch([
        { name: "refs/heads/ok", new: oid(1) },
        { name: bad, new: oid(2) },
      ]);
      if (r.ok || !r.rejected.some((x) => x.name === bad && x.reason === "invalid-name"))
        return bad;
    }
    return (await names(db)) === "";
  });
  await check("duplicate names in one batch are refused", async (db) => {
    const r = await db.batch([
      { name: "refs/heads/a", new: oid(1) },
      { name: "refs/heads/a", new: oid(2) },
    ]);
    return !r.ok && r.rejected.some((x) => x.reason === "duplicate") && (await names(db)) === "";
  });
  await check("directory/file conflicts are refused as git refuses them", async (db) => {
    await db.batch([
      { name: "refs/x", new: oid(1) },
      { name: "refs/p/q", new: oid(2) },
    ]);
    const below = await db.batch([
      { name: "refs/x", old: oid(1), new: null },
      { name: "refs/x/y", old: null, new: oid(3) },
    ]);
    const above = await db.batch([{ name: "refs/p", new: oid(4) }]);
    const pair = await db.batch([
      { name: "refs/z", new: oid(5) },
      { name: "refs/z/w", new: oid(6) },
    ]);
    const ok =
      !below.ok &&
      below.rejected.some((x) => x.reason === "df-conflict") &&
      !above.ok &&
      above.rejected.some((x) => x.reason === "df-conflict") &&
      !pair.ok &&
      pair.rejected.some((x) => x.reason === "df-conflict");
    return (
      (ok && (await names(db)) === "refs/p/q=aaa2,refs/x=aaa1") ||
      `${rejected(below)} | ${rejected(above)} | ${rejected(pair)} | ${await names(db)}`
    );
  });
  await check("HEAD as a symbolic ref: resolve, update through it, both reflogs", async (db) => {
    await db.batch([{ name: "refs/heads/main", new: oid(1) }], { ident: IDENT, message: "init" });
    if (!(await db.setSymref("HEAD", "refs/heads/main"))) return "setSymref"; // a real .git already has HEAD
    const head = await db.read("HEAD");
    if (!head || !("symref" in head) || head.symref !== "refs/heads/main") return "read HEAD";
    if ((await db.resolve("HEAD")) !== oid(1)) return "resolve HEAD";
    const r = await db.batch([{ name: "HEAD", old: oid(1), new: oid(2) }], {
      ident: IDENT,
      message: "commit: two",
    });
    if (!r.ok) return rejected(r);
    const h2 = await db.read("HEAD");
    if (!h2 || !("symref" in h2)) return "HEAD lost its symref";
    if ((await db.resolve("refs/heads/main")) !== oid(2)) return "target not updated";
    const mainLog = (await db.reflog("refs/heads/main")).map((e) => e.message).join("|");
    const headLog = (await db.reflog("HEAD")).map((e) => e.message).join("|");
    if (!(await names(db)).startsWith("refs/heads/main")) return "list";
    const headLast = (await db.reflog("HEAD")).at(-1);
    if (headLast?.old !== oid(1) || headLast?.new !== oid(2))
      return `HEAD log ${JSON.stringify(headLast)}`;
    return (
      (mainLog === "init|commit: two" && headLog.endsWith("commit: two")) ||
      `main=${mainLog} head=${headLog}`
    );
  });
  await check("setSymref is a compare-and-set on the target", async (db) => {
    await db.setSymref("HEAD", "refs/heads/main");
    const wrong = await db.setSymref("HEAD", "refs/heads/dev", "refs/heads/other");
    const exists = await db.setSymref("HEAD", "refs/heads/dev", null);
    const right = await db.setSymref("HEAD", "refs/heads/dev", "refs/heads/main");
    const head = await db.read("HEAD");
    return (
      !wrong && !exists && right && !!head && "symref" in head && head.symref === "refs/heads/dev"
    );
  });
  await check(
    "reflog lines hold old, new, ident and message; delete drops the log (as git)",
    async (db) => {
      await db.batch([{ name: "refs/heads/a", old: null, new: oid(1) }], {
        ident: IDENT,
        message: "create",
      });
      await db.batch([{ name: "refs/heads/a", old: oid(1), new: oid(2) }], {
        ident: IDENT,
        message: "move",
      });
      const log = await db.reflog("refs/heads/a");
      const want = `${ZERO_OID}>${oid(1)}:create|${oid(1)}>${oid(2)}:move`;
      const got = log.map((e) => `${e.old}>${e.new}:${e.message}`).join("|");
      if (got !== want) return got;
      if (log.some((e) => e.ident !== IDENT)) return "ident";
      await db.batch([{ name: "refs/heads/a", old: oid(2), new: null }], {
        ident: IDENT,
        message: "delete",
      });
      return (await db.reflog("refs/heads/a")).length === 0;
    },
  );
  await check(
    "20 concurrent two-ref batches with retry: both refs end at the number of successes",
    async (db) => {
      await db.batch([
        { name: "refs/heads/left", new: oid(0) },
        { name: "refs/heads/right", new: oid(0) },
      ]);
      let successes = 0;
      let done = false;
      const torn: string[] = [];
      const reader = (async () => {
        while (!done) {
          const seen = new Map<string, string>();
          for await (const { name, oid } of db.list("refs/heads/")) seen.set(name, oid);
          if (seen.get("refs/heads/left") !== seen.get("refs/heads/right")) {
            torn.push(
              `${seen.get("refs/heads/left")?.slice(-2)}/${seen.get("refs/heads/right")?.slice(-2)}`,
            );
          }
          await new Promise((res) => setTimeout(res, 0));
        }
      })();
      const worker = async (i: number) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const cur = await db.resolve(i % 2 ? "refs/heads/left" : "refs/heads/right");
          const n = Array.from({ length: 64 }, (_, k) => k).find((k) => oid(k) === cur) ?? -1;
          const order =
            i % 2
              ? ["refs/heads/left", "refs/heads/right"]
              : ["refs/heads/right", "refs/heads/left"];
          const r = await db.batch(order.map((name) => ({ name, old: oid(n), new: oid(n + 1) })));
          if (r.ok) {
            successes++;
            return;
          }
          await new Promise((res) => setTimeout(res, Math.random() * 5));
        }
        throw new Error(`worker ${i} gave up`);
      };
      await Promise.all(Array.from({ length: 20 }, (_, i) => worker(i)));
      done = true;
      await reader;
      if (torn.length)
        return `a list() snapshot showed left != right: ${torn.slice(0, 5).join(", ")}`;
      const l = await db.resolve("refs/heads/left");
      const r = await db.resolve("refs/heads/right");
      return (
        (l === oid(successes) && r === oid(successes) && successes === 20) ||
        `left ${l} right ${r} successes ${successes}`
      );
    },
  );
  await check("a create below an existing ref (not in the batch) is refused", async (db) => {
    await db.batch([{ name: "refs/x", new: oid(1) }]);
    const r = await db.batch([{ name: "refs/x/y", new: oid(2) }]);
    const r2 = await db.batch([
      { name: "refs/x/y/z", new: oid(3) },
      { name: "refs/other", new: oid(4) },
    ]);
    const ok =
      !r.ok &&
      rejected(r) === "refs/x/y:df-conflict" &&
      !r2.ok &&
      r2.rejected.some((x) => x.reason === "df-conflict") &&
      (await names(db)) === "refs/x=aaa1";
    return ok || `${rejected(r)} | ${rejected(r2)} | ${await names(db)}`;
  });
  await check("HEAD and its target in one batch are duplicates (as git)", async (db) => {
    await db.batch([{ name: "refs/heads/main", new: oid(1) }]);
    await db.setSymref("HEAD", "refs/heads/main");
    const r = await db.batch([
      { name: "HEAD", old: oid(1), new: oid(2) },
      { name: "refs/heads/main", old: oid(1), new: oid(3) },
    ]);
    const ok = !r.ok && r.rejected.some((x) => x.reason === "duplicate");
    return (ok && (await db.resolve("refs/heads/main")) === oid(1)) || rejected(r);
  });
  await check(
    "delete of an absent ref succeeds; delete with old=null is refused (as git)",
    async (db) => {
      const r1 = await db.batch([{ name: "refs/heads/none", new: null }]);
      const r2 = await db.batch([{ name: "refs/heads/none", old: null, new: null }]);
      const r3 = await db.batch([]);
      const ok =
        r1.ok && !r2.ok && r2.rejected.some((x) => x.reason === "invalid-command") && r3.ok;
      return ok || `${r1.ok} ${rejected(r2)} ${r3.ok}`;
    },
  );
  await check("a detached HEAD updates alone and is refused in a multi-ref batch", async (db) => {
    await db.batch([{ name: "refs/heads/main", new: oid(1) }]);
    const single = await db.batch([{ name: "HEAD", new: oid(5) }]); // detaches (or creates) HEAD
    const head = await db.read("HEAD");
    if (!single.ok || !head || !("oid" in head) || head.oid !== oid(5)) {
      return `single ${rejected(single)} ${JSON.stringify(head)}`;
    }
    const multi = await db.batch([
      { name: "HEAD", old: oid(5), new: oid(6) },
      { name: "refs/heads/main", old: oid(1), new: oid(7) },
    ]);
    const after = await db.read("HEAD");
    const ok =
      !multi.ok &&
      multi.rejected.some((x) => x.name === "HEAD" && x.reason === "not-atomic") &&
      !!after &&
      "oid" in after &&
      after.oid === oid(5) &&
      (await db.resolve("refs/heads/main")) === oid(1);
    return ok || `${rejected(multi)} ${JSON.stringify(after)}`;
  });
  await check("updating HEAD's target directly also logs HEAD (as git)", async (db) => {
    await db.batch([{ name: "refs/heads/main", new: oid(1) }], { ident: IDENT, message: "init" });
    await db.setSymref("HEAD", "refs/heads/main");
    const before = (await db.reflog("HEAD")).length;
    await db.batch([{ name: "refs/heads/main", old: oid(1), new: oid(2) }], {
      ident: IDENT,
      message: "direct",
    });
    const log = await db.reflog("HEAD");
    const last = log[log.length - 1];
    const ok =
      log.length === before + 1 &&
      last?.old === oid(1) &&
      last?.new === oid(2) &&
      last?.message === "direct";
    return ok || JSON.stringify(log.slice(-2));
  });
  await check(
    "a deleted ref's name can become a directory, and a directory's name a ref again",
    async (db) => {
      const steps = [
        await db.batch([{ name: "refs/heads/a/b", new: oid(1) }]),
        await db.batch([{ name: "refs/heads/a/b", old: oid(1), new: null }]),
        await db.batch([{ name: "refs/heads/a", old: null, new: oid(2) }]),
        await db.batch([{ name: "refs/heads/a", old: oid(2), new: null }]),
        await db.batch([
          { name: "refs/heads/a/c", old: null, new: oid(3) },
          { name: "refs/heads/z", new: oid(4) },
        ]),
      ];
      const bad = steps.findIndex((r) => !r.ok);
      if (bad >= 0) return `step ${bad}: ${rejected(steps[bad] as BatchResult)}`;
      return (await names(db)) === "refs/heads/a/c=aaa3,refs/heads/z=aaa4" || (await names(db));
    },
  );
  await check("concurrent creates of a ref and a ref below it never both succeed", async (db) => {
    for (let round = 0; round < 10; round++) {
      const x = `refs/r${round}`;
      const [a, b] = await Promise.all([
        db.batch([
          { name: x, old: null, new: oid(1) },
          { name: `refs/s${round}a`, new: oid(1) },
        ]),
        db.batch([
          { name: `${x}/y`, old: null, new: oid(2) },
          { name: `refs/s${round}b`, new: oid(2) },
        ]),
      ]);
      const both =
        (await db.resolve(x)) !== undefined && (await db.resolve(`${x}/y`)) !== undefined;
      if (both || (a.ok && b.ok)) return `round ${round}: ${a.ok} ${b.ok}`;
    }
    return true;
  });
  await check("a no-op update changes nothing and logs nothing (as git)", async (db) => {
    await db.batch([{ name: "refs/heads/a", new: oid(1) }], { ident: IDENT, message: "create" });
    const r = await db.batch([{ name: "refs/heads/a", old: oid(1), new: oid(1) }], {
      ident: IDENT,
      message: "noop",
    });
    const log = (await db.reflog("refs/heads/a")).map((e) => e.message).join("|");
    return (
      (r.ok && log === "create" && (await db.resolve("refs/heads/a")) === oid(1)) ||
      `${r.ok} ${log}`
    );
  });
  await check("list(prefix) is sorted by bytes and skips symbolic refs", async (db) => {
    await db.batch([
      { name: "refs/heads/b", new: oid(2) },
      { name: "refs/heads/a-b", new: oid(3) },
      { name: "refs/heads/a/c", new: oid(1) },
      { name: "refs/tags/t", new: oid(4) },
    ]);
    await db.setSymref("refs/heads/sym", "refs/heads/b", null);
    const got = await names(db, "refs/heads/");
    return got === "refs/heads/a-b=aaa3,refs/heads/a/c=aaa1,refs/heads/b=aaa2" || got;
  });
  return { cases, failed };
}
