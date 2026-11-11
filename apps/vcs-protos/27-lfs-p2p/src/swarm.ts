/**
 * X12 — a download from every peer that holds the object.
 *
 * One batch per source says who holds it. The ranges not held yet are cut into chunks; one worker
 * per holder takes chunks from a shared queue and writes each as a part at its offset (X10a's
 * store keeps what arrived when a transfer breaks). A holder that fails is dropped and the rest of
 * its chunk goes back to the queue, so no byte is received twice. When the parts cover the object
 * it is verified as a whole (SHA-256 and size) before it becomes visible.
 *
 * A mismatch means some source served altered bytes. Each chunk's hash and source were recorded
 * on the way, so the object is then taken from each holder alone until one copy verifies, and the
 * recorded chunks are compared with it: the sources whose chunks differ — and those whose own
 * copy failed — are reported as bad.
 */
import { createSha256, toHex } from "../../03-sha256-blake3/src/hashes.js";
import {
  type BatchObject,
  lfsBatch,
  missingChunks,
  transferHeaders,
} from "../../26-lfs/src/client.js";
import type { Pointer } from "../../26-lfs/src/pointer.js";
import type { LfsStore } from "../../26-lfs/src/store.js";

export interface LfsSource {
  name: string;
  /** the peer's git remote URL (…/repo.git) */
  url: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}
export interface SwarmOptions {
  /** bytes per ranged request (default 4 MiB) */
  chunkSize?: number;
  /** bytes received per source */
  stats?: Record<string, number>;
  signal?: AbortSignal;
}

interface Holder {
  source: LfsSource;
  answer: BatchObject;
}
interface Received {
  source: string;
  start: number;
  end: number;
  hash: string;
}

const unique = (objects: Pointer[]) => [...new Map(objects.map((o) => [o.oid, o])).values()];

/** the chunk [start, end) from `h` into `store`; what arrived is counted and kept */
async function fetchChunk(
  h: Holder,
  store: LfsStore,
  start: number,
  end: number,
  opts: SwarmOptions,
): Promise<{ received: number; hash?: string; error?: unknown }> {
  const action = h.answer.actions?.download;
  if (!action) return { received: 0, error: new Error("no download action") };
  const f = h.source.fetch ?? fetch;
  let received = 0;
  try {
    const res = await f(action.href, {
      headers: {
        ...transferHeaders(h.answer, action, { headers: h.source.headers }),
        range: `bytes=${start}-${end - 1}`,
      },
      signal: opts.signal,
    });
    const at = Number(/^bytes (\d+)-/.exec(res.headers.get("content-range") ?? "")?.[1]);
    const whole = res.status === 200 && start === 0 && end === h.answer.size;
    if (!(res.status === 206 && at === start) && !whole) {
      await res.body?.cancel();
      return {
        received: 0,
        error: new Error(`${h.source.name}: HTTP ${res.status} for [${start}, ${end})`),
      };
    }
    const reader = res.body?.getReader();
    const hash = createSha256();
    let done = false;
    async function* bytes() {
      if (!reader) return;
      try {
        while (received < end - start) {
          const r = await reader.read();
          if (r.done) break;
          const c = r.value.subarray(0, end - start - received);
          received += c.length;
          if (opts.stats) opts.stats[h.source.name] = (opts.stats[h.source.name] ?? 0) + c.length;
          hash.update(c);
          yield c;
        }
        done = received === end - start;
      } finally {
        if (!done) await reader.cancel().catch(() => {});
        else await reader.cancel().catch(() => {}); // anything past the range is not read
      }
    }
    await store.incomplete.write(h.answer.oid, start, bytes());
    if (received < end - start)
      return {
        received,
        error: new Error(`${h.source.name}: ended at ${start + received} of [${start}, ${end})`),
      };
    return { received, hash: toHex(hash.digest()) };
  } catch (error) {
    return { received, error };
  }
}

/** the missing ranges of `o` from `holders`, chunk by chunk; the chunks received */
async function gather(
  holders: Holder[],
  store: LfsStore,
  o: Pointer,
  opts: SwarmOptions,
): Promise<Received[]> {
  const chunk = opts.chunkSize ?? 4 << 20;
  const queue = missingChunks(o.size, await store.incomplete.ranges(o.oid), chunk);
  const received: Received[] = [];
  const errors: unknown[] = [];
  await Promise.all(
    holders.map(async (h) => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        const [s, e] = next;
        const r = await fetchChunk(h, store, s, e, opts);
        if (r.error) {
          // the rest of the chunk goes back; this holder is done
          if (s + r.received < e) queue.unshift([s + r.received, e]);
          errors.push(r.error);
          return;
        }
        received.push({ source: h.source.name, start: s, end: e, hash: r.hash as string });
      }
    }),
  );
  if (queue.length)
    throw new Error(
      `lfs object ${o.oid}: no source could serve [${queue[0]?.[0]}, ${queue[0]?.[1]}): ${errors.map(String).join("; ")}`,
    );
  return received;
}

/** the hash of [start, end) of a stored object */
async function rangeHash(store: LfsStore, oid: string, start: number, end: number) {
  const h = createSha256();
  let left = end - start;
  for await (const c of store.read(oid, { start })) {
    const part = c.subarray(0, left);
    h.update(part);
    left -= part.length;
    if (left <= 0) break;
  }
  return toHex(h.digest());
}

export async function lfsFetchFrom(
  sources: LfsSource[],
  store: LfsStore,
  objects: Pointer[],
  opts: SwarmOptions = {},
): Promise<{ downloaded: string[]; bad: string[] }> {
  const downloaded: string[] = [];
  const bad = new Set<string>();
  const wanted: Pointer[] = [];
  for (const o of unique(objects)) if ((await store.size(o.oid)) !== o.size) wanted.push(o);
  if (!wanted.length) return { downloaded, bad: [] };
  // who holds what: one batch per source
  const answers = await Promise.all(
    sources.map(async (source) => {
      try {
        const r = await lfsBatch(source.url, "download", wanted, {
          fetch: source.fetch,
          headers: source.headers,
          signal: opts.signal,
        });
        return { source, objects: r.objects };
      } catch {
        return { source, objects: [] as BatchObject[] };
      }
    }),
  );
  for (const o of wanted) {
    const holders: Holder[] = [];
    for (const a of answers) {
      const answer = a.objects.find((x) => x.oid === o.oid);
      if (answer?.actions?.download) holders.push({ source: a.source, answer });
    }
    if (!holders.length) throw new Error(`lfs object ${o.oid} not found on any source`);
    await store.incomplete.exclusive(o.oid, async () => {
      if ((await store.size(o.oid)) === o.size) return;
      const received = await gather(holders, store, o, opts);
      try {
        await store.incomplete.complete({ oid: o.oid, size: o.size });
        return;
      } catch (e) {
        if ((e as Error).name !== "ObjectIdMismatchError") throw e;
      }
      // a source served altered bytes: each holder alone, until one copy verifies
      let good = false;
      for (const h of holders) {
        try {
          await gather([h], store, o, opts);
          await store.incomplete.complete({ oid: o.oid, size: o.size });
          good = true;
          break;
        } catch (e) {
          if ((e as Error).name === "ObjectIdMismatchError") bad.add(h.source.name);
          else await store.incomplete.remove(o.oid);
        }
      }
      if (!good) throw new Error(`lfs object ${o.oid}: no source served bytes that verify`);
      // which sources' chunks differ from the verified object
      for (const r of received)
        if ((await rangeHash(store, o.oid, r.start, r.end)) !== r.hash) bad.add(r.source);
    });
    downloaded.push(o.oid);
  }
  return { downloaded, bad: [...bad] };
}
