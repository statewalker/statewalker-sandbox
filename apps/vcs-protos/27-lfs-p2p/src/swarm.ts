/**
 * X12 — a download from every peer that holds the object.
 *
 * One batch per source says who holds it. The ranges not held yet are cut into chunks; one worker
 * per holder takes chunks from a shared queue and writes each as a part at its offset (X10a's
 * store keeps what arrived when a transfer breaks). A holder that fails is dropped and the rest of
 * its chunk goes back to the queue, so no byte is received twice; the workers left wait until the
 * queue is empty and nothing is in flight, so a late failure is picked up by whoever remains. A
 * holder ignoring Range (200) is read from the chunk's start. When the parts cover the object it
 * is verified as a whole (SHA-256 and size) before it becomes visible.
 *
 * Any failure — a mismatch, or no holder left — leads to the holders one at a time, each from
 * what is held (a mismatch has dropped it), until a copy verifies. The hash and source of every
 * piece received (a cut chunk's delivered bytes too) were recorded, and are compared with the
 * verified object: the sources whose bytes differ, and those whose own copy failed to verify,
 * are reported as bad.
 */
import { createSha256, toHex } from "../../03-sha256-blake3/src/hashes.js";
import {
  type BatchObject,
  chunkSizeOf,
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

/** the chunk [start, end) from `h` into `store`; what arrived is counted, hashed and kept */
async function fetchChunk(
  h: Holder,
  store: LfsStore,
  start: number,
  end: number,
  opts: SwarmOptions,
): Promise<{ received: number; hash: string; error?: unknown }> {
  const action = h.answer.actions?.download;
  const hash = createSha256();
  let received = 0;
  const result = (error?: unknown) => ({ received, hash: toHex(hash.digest()), error });
  if (!action) return result(new Error(`${h.source.name}: no download action`));
  const f = h.source.fetch ?? fetch;
  try {
    const res = await f(action.href, {
      headers: {
        ...transferHeaders(h.answer, action, { headers: h.source.headers }),
        range: `bytes=${start}-${end - 1}`,
      },
      signal: opts.signal,
    });
    const at = Number(/^bytes (\d+)-/.exec(res.headers.get("content-range") ?? "")?.[1]);
    // 206 for the range asked, or 200 (Range ignored, RFC 9110): read from `start`
    let skip: number;
    if (res.status === 206 && at === start) skip = 0;
    else if (res.status === 200) skip = start;
    else {
      await res.body?.cancel();
      return result(new Error(`${h.source.name}: HTTP ${res.status} for [${start}, ${end})`));
    }
    const reader = res.body?.getReader();
    async function* bytes() {
      if (!reader) return;
      try {
        while (received < end - start) {
          const r = await reader.read();
          if (r.done) break;
          let c = r.value;
          if (skip > 0) {
            const drop = Math.min(skip, c.length);
            skip -= drop;
            c = c.subarray(drop);
          }
          c = c.subarray(0, end - start - received);
          if (!c.length) continue;
          received += c.length;
          if (opts.stats) opts.stats[h.source.name] = (opts.stats[h.source.name] ?? 0) + c.length;
          hash.update(c);
          yield c;
        }
      } finally {
        // what lies past the range (or a failed rest) is not read
        await reader.cancel().catch(() => {});
      }
    }
    await store.incomplete.write(h.answer.oid, start, bytes());
    if (received < end - start)
      return result(
        new Error(`${h.source.name}: ended at ${start + received} of [${start}, ${end})`),
      );
    return result();
  } catch (error) {
    return result(error);
  }
}

/** the missing ranges of `o` from `holders`, chunk by chunk; every piece received is recorded */
async function gather(
  holders: Holder[],
  store: LfsStore,
  o: Pointer,
  opts: SwarmOptions,
  received: Received[],
): Promise<void> {
  const queue = missingChunks(
    o.size,
    await store.incomplete.ranges(o.oid),
    chunkSizeOf(opts.chunkSize),
  );
  const errors: unknown[] = [];
  let inFlight = 0;
  let wake = () => {};
  let changed = new Promise<void>((r) => {
    wake = r;
  });
  const notify = () => {
    wake();
    changed = new Promise<void>((r) => {
      wake = r;
    });
  };
  await Promise.all(
    holders.map(async (h) => {
      for (;;) {
        const next = queue.shift();
        if (!next) {
          // nothing queued: done when nothing is in flight either; else a failure may re-queue
          if (inFlight === 0) return;
          await changed;
          continue;
        }
        const [s, e] = next;
        inFlight++;
        const r = await fetchChunk(h, store, s, e, opts);
        if (r.received > 0)
          received.push({ source: h.source.name, start: s, end: s + r.received, hash: r.hash });
        if (r.error && s + r.received < e) queue.unshift([s + r.received, e]);
        inFlight--;
        notify();
        if (r.error) {
          errors.push(r.error);
          return; // this holder is done
        }
      }
    }),
  );
  if (queue.length)
    throw new Error(
      `lfs object ${o.oid}: no source could serve [${queue[0]?.[0]}, ${queue[0]?.[1]}): ${errors.map(String).join("; ")}`,
    );
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
  chunkSizeOf(opts.chunkSize);
  const downloaded: string[] = [];
  const bad = new Set<string>();
  // one entry per source name (stats and blame are per name)
  const unique_ = [...new Map(sources.map((x) => [x.name, x])).values()];
  const wanted: Pointer[] = [];
  for (const o of unique(objects)) if ((await store.size(o.oid)) !== o.size) wanted.push(o);
  if (!wanted.length) return { downloaded, bad: [] };
  // who holds what: one batch per source (a failed one is reported if no one holds the object)
  const batchErrors: string[] = [];
  const answers = await Promise.all(
    unique_.map(async (source) => {
      try {
        const r = await lfsBatch(source.url, "download", wanted, {
          fetch: source.fetch,
          headers: source.headers,
          signal: opts.signal,
        });
        return { source, objects: r.objects };
      } catch (e) {
        batchErrors.push(`${source.name}: ${String(e)}`);
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
    if (!holders.length)
      throw new Error(
        `lfs object ${o.oid} not found on any source${batchErrors.length ? ` (${batchErrors.join("; ")})` : ""}`,
      );
    await store.incomplete.exclusive(o.oid, async () => {
      if ((await store.size(o.oid)) === o.size) return;
      const received: Received[] = [];
      let mismatch = false;
      try {
        await gather(holders, store, o, opts, received);
        await store.incomplete.complete({ oid: o.oid, size: o.size });
        return;
      } catch (e) {
        mismatch = (e as Error).name === "ObjectIdMismatchError";
      }
      // the holders one at a time, from what is held, until a copy verifies
      let good = false;
      const failures: string[] = [];
      for (const h of holders) {
        try {
          await gather([h], store, o, opts, received);
          await store.incomplete.complete({ oid: o.oid, size: o.size });
          good = true;
          break;
        } catch (e) {
          failures.push(`${h.source.name}: ${String(e)}`);
          if ((e as Error).name === "ObjectIdMismatchError") {
            mismatch = true;
            bad.add(h.source.name);
          }
        }
      }
      if (!good)
        throw new Error(
          `lfs object ${o.oid}: no source served it whole and verified (${failures.join("; ")})`,
        );
      // whose bytes differ from the verified object
      if (mismatch)
        for (const r of received)
          if ((await rangeHash(store, o.oid, r.start, r.end)) !== r.hash) bad.add(r.source);
    });
    downloaded.push(o.oid);
  }
  return { downloaded, bad: [...bad] };
}
