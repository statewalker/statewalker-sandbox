/**
 * X5 contract (R2–R5), runnable in Node, Chromium and a Durable Object against any RefDb.
 */
import type { RefDb, RejectReason } from "./ref-db.js";
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
      { name: "refs/heads/a", old: oid(1), new: oid(11) },
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
    if (!(await db.setSymref("HEAD", "refs/heads/main", null))) return "setSymref";
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
    return (
      (mainLog === "init|commit: two" && headLog.endsWith("commit: two")) ||
      `main=${mainLog} head=${headLog}`
    );
  });
  await check("setSymref is a compare-and-set on the target", async (db) => {
    await db.setSymref("HEAD", "refs/heads/main", null);
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
      const worker = async (i: number) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const cur = await db.resolve(i % 2 ? "refs/heads/left" : "refs/heads/right");
          const n = Number.parseInt(cur ?? "0", 16) - Number.parseInt(oid(0), 16);
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
      const l = await db.resolve("refs/heads/left");
      const r = await db.resolve("refs/heads/right");
      return (
        (l === oid(successes) && r === oid(successes) && successes === 20) ||
        `left ${l} right ${r} successes ${successes}`
      );
    },
  );
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
