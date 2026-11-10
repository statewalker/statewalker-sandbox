/**
 * X4 contract (R1, R3, R5), runnable in Node, Chromium and a Durable Object. It drives the kernel
 * and, to check stored bytes and plant corruption, the StagingBlobStore underneath it. Inflation
 * for checks uses the platform's DecompressionStream, independent of the kernel's inflater.
 */

import { gitObjects, type ObjectType } from "./git-objects.js";
import type { StagingBlobStore } from "./staging.js";

export interface CorpusObject {
  name: string;
  id: string;
  type: ObjectType;
  raw: Uint8Array;
}

const enc = new TextEncoder();
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export async function collect(s: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of s) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
async function viaStream(bytes: Uint8Array, t: ReadableWritablePair<Uint8Array, BufferSource>) {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(t));
  return new Uint8Array(await out.arrayBuffer());
}
export const zlib = (b: Uint8Array) => viaStream(b, new CompressionStream("deflate"));
export const unzlib = (b: Uint8Array) => viaStream(b, new DecompressionStream("deflate"));
async function* one(b: Uint8Array) {
  yield b;
}
async function* chunked(b: Uint8Array, size: number) {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}
const body = (o: CorpusObject) => o.raw.subarray(o.raw.indexOf(0) + 1);
async function rejects(p: Promise<unknown>, name?: string): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (e) {
    return name === undefined || (e as Error).name === name;
  }
}
async function ids(store: StagingBlobStore): Promise<string[]> {
  const r: string[] = [];
  for await (const id of store.list()) r.push(id);
  return r.sort();
}

export async function runObjectContract(
  make: () => Promise<StagingBlobStore>,
  corpus: CorpusObject[],
): Promise<{ cases: number; failed: string[] }> {
  const failed: string[] = [];
  let cases = 0;
  const check = async (
    name: string,
    fn: (store: StagingBlobStore) => Promise<boolean | string>,
  ) => {
    cases++;
    try {
      const r = await fn(await make());
      if (r !== true) failed.push(r === false ? name : `${name}: ${r}`);
    } catch (e) {
      failed.push(`${name}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    }
  };
  const blob = corpus.find((o) => o.type === "blob" && body(o).length > 1000) as CorpusObject;
  const other = corpus.find((o) => o.type === "commit") as CorpusObject;

  await check("put(type, size, content) returns git's id for every corpus object", async (s) => {
    const objs = gitObjects(s);
    for (const o of corpus) {
      const id = await objs.put(o.type, body(o).length, chunked(body(o), 7));
      if (id !== o.id) return `${o.name}: ${id}`;
    }
    return true;
  });
  await check("putRaw + getRaw is byte-identical; get returns type, size, content", async (s) => {
    const objs = gitObjects(s);
    for (const o of corpus) {
      await objs.putRaw(o.id, chunked(o.raw, 5));
      if (!eq(await collect(objs.getRaw(o.id)), o.raw)) return `${o.name}: getRaw`;
      const g = await objs.get(o.id, { verify: true });
      if (!g || g.type !== o.type || g.size !== body(o).length) return `${o.name}: header`;
      if (!eq(await collect(g.content), body(o))) return `${o.name}: content`;
    }
    return true;
  });
  await check("stored bytes are zlib loose objects at the object id", async (s) => {
    const objs = gitObjects(s);
    for (const o of corpus) await objs.put(o.type, body(o).length, one(body(o)));
    for (const o of corpus) {
      if (!eq(await unzlib(await collect(s.get(o.id))), o.raw)) return o.name;
    }
    return (
      (await ids(s)).join() ===
      corpus
        .map((o) => o.id)
        .sort()
        .join()
    );
  });
  await check("absent object: has false, get undefined, getRaw empty", async (s) => {
    const objs = gitObjects(s);
    return (
      !(await objs.has(blob.id)) &&
      (await objs.get(blob.id)) === undefined &&
      (await collect(objs.getRaw(blob.id))).length === 0
    );
  });
  await check("putRaw with a wrong id rejects and stores nothing", async (s) => {
    const objs = gitObjects(s);
    const ok = await rejects(objs.putRaw(other.id, one(blob.raw)), "ObjectIdMismatchError");
    return ok && (await ids(s)).length === 0;
  });
  await check("putRaw with a malformed header rejects and stores nothing", async (s) => {
    const objs = gitObjects(s);
    const bad = [
      enc.encode("blub 3\0abc"),
      enc.encode("blob 3abc"),
      enc.encode("blob 4\0abc"),
      enc.encode("blob 2\0abc"),
      enc.encode("blob 03\0abc"),
      enc.encode("blob -1\0abc"),
    ];
    for (const raw of bad) {
      if (!(await rejects(objs.putRaw("0".repeat(40), one(raw)))))
        return new TextDecoder().decode(raw);
    }
    return (await ids(s)).length === 0;
  });
  await check("put with a size lie (short or long) rejects and stores nothing", async (s) => {
    const objs = gitObjects(s);
    const b = body(blob);
    const short = await rejects(objs.put("blob", b.length + 1, one(b)));
    const long = await rejects(objs.put("blob", b.length - 1, one(b)));
    return short && long && (await ids(s)).length === 0;
  });
  await check(
    "storing an existing object again and 10 concurrent puts leave one object",
    async (s) => {
      const objs = gitObjects(s);
      const b = body(blob);
      await objs.put("blob", b.length, one(b));
      await objs.putRaw(blob.id, one(blob.raw));
      const r = await Promise.all(
        Array.from({ length: 10 }, () => objs.put("blob", b.length, chunked(b, 4096))),
      );
      return r.every((id) => id === blob.id) && (await ids(s)).join() === blob.id;
    },
  );
  const corruptions: [string, (z: Uint8Array) => Promise<Uint8Array> | Uint8Array][] = [
    ["truncated zlib stream", (z) => z.subarray(0, z.length - 9)],
    ["bytes after the zlib stream", (z) => Uint8Array.of(...z, 1, 2, 3)],
    ["header size disagrees with the body", async () => zlib(enc.encode("blob 5\0abc"))],
    ["not zlib at all", () => enc.encode("plain text, not deflated")],
  ];
  for (const [what, corrupt] of corruptions) {
    await check(`reading an object with ${what} raises an error`, async (s) => {
      const objs = gitObjects(s);
      await s.put(blob.id, one(await corrupt(await zlib(blob.raw))));
      const g = await objs.get(blob.id).catch(() => "threw" as const);
      if (g === "threw") return true;
      return rejects(collect(g ? g.content : objs.getRaw(blob.id)));
    });
  }
  await check("get with verify detects an object whose bytes hash to another id", async (s) => {
    const objs = gitObjects(s);
    await s.put(blob.id, one(await zlib(other.raw))); // valid object, wrong name
    const g = await objs.get(blob.id, { verify: true }).catch(() => "threw" as const);
    if (g === "threw") return true;
    return g !== undefined && rejects(collect(g.content), "ObjectIdMismatchError");
  });
  return { cases, failed };
}
