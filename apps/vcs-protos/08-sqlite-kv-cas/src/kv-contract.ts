/**
 * The webrun-storage KvStore contract (mirrors webrun-storage/tests/kv-store.test.ts), portable so it
 * can run inside a worker and a Durable Object. Returns the failed case names.
 */
import type { KvStore } from "@statewalker/webrun-storage";

const enc = new TextEncoder();
const eq = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
  a === undefined || b === undefined
    ? a === b
    : a.length === b.length && a.every((v, i) => v === b[i]);

export async function runKvContract(
  make: () => Promise<KvStore>,
): Promise<{ cases: number; failed: string[] }> {
  const failed: string[] = [];
  let cases = 0;
  const check = async (name: string, fn: (kv: KvStore) => Promise<boolean>) => {
    cases++;
    try {
      if (!(await fn(await make()))) failed.push(name);
    } catch (e) {
      failed.push(`${name}: ${String(e)}`);
    }
  };
  const k = (n: string) => `contract/${n}/${Math.random().toString(36).slice(2)}`;

  await check("get/put/remove roundtrip", async (kv) => {
    const key = k("rt");
    if ((await kv.get(key)) !== undefined) return false;
    await kv.put(key, enc.encode("v1"));
    const ok1 = eq(await kv.get(key), enc.encode("v1"));
    const removed = await kv.remove(key);
    const removedAgain = await kv.remove(key);
    return ok1 && removed && !removedAgain && (await kv.get(key)) === undefined;
  });
  await check("binary values round-trip exactly", async (kv) => {
    const key = k("bin");
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const zeros = new Uint8Array(17);
    await kv.put(key, all);
    const a = eq(await kv.get(key), all);
    await kv.put(key, zeros);
    return a && eq(await kv.get(key), zeros);
  });
  await check("cas succeeds when the expected value matches", async (kv) => {
    const key = k("match");
    await kv.put(key, enc.encode("a"));
    return (
      (await kv.cas(key, enc.encode("a"), enc.encode("b"))) &&
      eq(await kv.get(key), enc.encode("b"))
    );
  });
  await check("cas returns false and writes nothing when expected is stale", async (kv) => {
    const key = k("stale");
    await kv.put(key, enc.encode("a"));
    return (
      !(await kv.cas(key, enc.encode("x"), enc.encode("b"))) &&
      eq(await kv.get(key), enc.encode("a"))
    );
  });
  await check("cas create: expected undefined sets only when absent", async (kv) => {
    const key = k("create");
    const first = await kv.cas(key, undefined, enc.encode("a"));
    const second = await kv.cas(key, undefined, enc.encode("b"));
    return first && !second && eq(await kv.get(key), enc.encode("a"));
  });
  await check("cas delete: next undefined removes on match only", async (kv) => {
    const key = k("delete");
    await kv.put(key, enc.encode("a"));
    const stale = await kv.cas(key, enc.encode("x"), undefined);
    const hit = await kv.cas(key, enc.encode("a"), undefined);
    return !stale && hit && (await kv.get(key)) === undefined;
  });
  await check("two cas with the same expected value: exactly one succeeds", async (kv) => {
    const key = k("race");
    await kv.put(key, enc.encode("v0"));
    const r = await Promise.all([
      kv.cas(key, enc.encode("v0"), enc.encode("A")),
      kv.cas(key, enc.encode("v0"), enc.encode("B")),
    ]);
    return r.filter(Boolean).length === 1;
  });
  await check("list(prefix) yields matching pairs in key order", async (kv) => {
    const p = k("list");
    await kv.put(`${p}/b`, enc.encode("2"));
    await kv.put(`${p}/a`, enc.encode("1"));
    await kv.put(`${p}x/c`, enc.encode("3")); // shares the string prefix
    await kv.put(`other/${p}`, enc.encode("4"));
    const got: string[] = [];
    for await (const { key, value } of kv.list(`${p}/`))
      got.push(`${key.slice(p.length)}=${new TextDecoder().decode(value)}`);
    return got.join(",") === "/a=1,/b=2";
  });
  await check("list(prefix) treats % and _ in the prefix literally", async (kv) => {
    const p = k("lit");
    await kv.put(`${p}/a_b`, enc.encode("1"));
    await kv.put(`${p}/aXb`, enc.encode("2"));
    await kv.put(`${p}/a%c`, enc.encode("3"));
    const keys: string[] = [];
    for await (const { key } of kv.list(`${p}/a_`)) keys.push(key.slice(p.length));
    for await (const { key } of kv.list(`${p}/a%`)) keys.push(key.slice(p.length));
    return keys.join(",") === "/a_b,/a%c";
  });
  return { cases, failed };
}
