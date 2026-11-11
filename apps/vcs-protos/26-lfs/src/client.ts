/**
 * X10a — the Git LFS client: the Batch API and the `basic` transfer.
 *
 *  - `lfsPush`: one upload batch; objects the server holds are skipped; each upload is streamed
 *    from the store, then confirmed with the `verify` action when the server offers one;
 *  - `lfsFetch`: objects already held are skipped; one download batch; each download goes into the
 *    store's incomplete parts and resumes from the bytes held with `Range: bytes=N-` (a server
 *    answering 200 instead restarts it); the whole is verified (SHA-256 and size) before the
 *    object becomes visible, and refused bytes are dropped. One download per object at a time.
 *
 * The batch's answer must name exactly the objects asked for. Transfers carry the action's headers;
 * unless the server marked the object `authenticated`, the client's own headers go with them too
 * (git-lfs sends its credentials then).
 */
import type { Pointer } from "./pointer.js";
import type { LfsStore } from "./store.js";

export interface LfsClientOptions {
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** bytes sent or received in transfer bodies (and `requests`: transfer requests made) */
  stats?: { bytes: number; requests?: number };
  /** X12: offer the `ranged` adapter; uploads in parts of this many bytes (default 4 MiB) */
  chunkSize?: number;
}

const LFS_JSON = "application/vnd.git-lfs+json";
interface Action {
  href: string;
  header?: Record<string, string>;
}
interface BatchObject {
  oid: string;
  size: number;
  authenticated?: boolean;
  actions?: { download?: Action; upload?: Action; verify?: Action };
  error?: { code: number; message: string };
}

async function batch(
  url: string,
  operation: "download" | "upload",
  objects: Pointer[],
  opts: LfsClientOptions,
): Promise<BatchObject[]> {
  const f = opts.fetch ?? fetch;
  const res = await f(`${url.replace(/\/+$/, "")}/info/lfs/objects/batch`, {
    method: "POST",
    headers: { accept: LFS_JSON, "content-type": LFS_JSON, ...opts.headers },
    body: JSON.stringify({
      operation,
      transfers: ["basic"],
      objects: objects.map((o) => ({ oid: o.oid, size: o.size })),
      hash_algo: "sha256",
    }),
    signal: opts.signal,
  });
  if (res.status !== 200) {
    const msg = ((await res.json().catch(() => ({}))) as { message?: string }).message ?? "";
    throw new Error(`lfs batch ${operation}: HTTP ${res.status} ${msg}`.trim());
  }
  const out = (await res.json()) as { transfer?: string; objects?: BatchObject[] };
  if (out.transfer !== undefined && out.transfer !== "basic")
    throw new Error(`lfs batch: the server chose transfer ${out.transfer}, not basic`);
  // exactly the objects asked for, in the order asked
  const byOid = new Map<string, BatchObject>();
  const asked = new Set(objects.map((o) => o.oid));
  for (const o of out.objects ?? []) {
    if (!asked.has(o?.oid))
      throw new Error(`lfs batch: the server answered for ${o?.oid}, not asked`);
    byOid.set(o.oid, o);
  }
  return objects.map((o) => {
    const answer = byOid.get(o.oid);
    if (!answer) throw new Error(`lfs batch: the server's answer is missing ${o.oid}`);
    return answer;
  });
}
/** one entry per object id */
function unique(objects: Pointer[]): Pointer[] {
  const seen = new Map<string, Pointer>();
  for (const o of objects) if (!seen.has(o.oid)) seen.set(o.oid, o);
  return [...seen.values()];
}
const transferHeaders = (o: BatchObject, action: Action, opts: LfsClientOptions) => ({
  ...(o.authenticated ? {} : opts.headers),
  ...action.header,
});
function objectError(o: BatchObject): Error {
  const code = o.error?.code;
  return new Error(
    code === 404
      ? `lfs object ${o.oid} not found on the server`
      : `lfs object ${o.oid}: HTTP ${code} ${o.error?.message ?? ""}`.trim(),
  );
}
async function* chunks(body: ReadableStream<Uint8Array> | null): AsyncGenerator<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  let done = false;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) {
        done = true;
        return;
      }
      yield r.value;
    }
  } finally {
    // a consumer that stopped early: the rest of the body (and its connection) is released
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function* counted(source: AsyncIterable<Uint8Array>, stats?: { bytes: number }) {
  for await (const c of source) {
    if (stats) stats.bytes += c.length;
    yield c;
  }
}
function stream(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const it = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const r = await it.next();
      if (r.done) ctrl.close();
      else ctrl.enqueue(r.value);
    },
    async cancel() {
      await it.return?.();
    },
  });
}

/** `url`: the git remote (…/repo.git); the LFS endpoint is `<url>/info/lfs` */
export async function lfsPush(
  url: string,
  store: LfsStore,
  objects: Pointer[],
  opts: LfsClientOptions = {},
): Promise<{ uploaded: string[]; skipped: string[] }> {
  const f = opts.fetch ?? fetch;
  const uploaded: string[] = [];
  const skipped: string[] = [];
  const wanted = unique(objects);
  if (!wanted.length) return { uploaded, skipped };
  for (const o of await batch(url, "upload", wanted, opts)) {
    if (o.error) throw objectError(o);
    const up = o.actions?.upload;
    if (!up) {
      skipped.push(o.oid);
      continue;
    }
    const res = await f(up.href, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", ...transferHeaders(o, up, opts) },
      body: stream(counted(store.read(o.oid, { signal: opts.signal }), opts.stats)),
      signal: opts.signal,
      // @ts-expect-error a streamed request body needs duplex (fetch spec; Node and browsers)
      duplex: "half",
    });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`lfs upload ${o.oid}: HTTP ${res.status}`);
    const verify = o.actions?.verify;
    if (verify) {
      const v = await f(verify.href, {
        method: "POST",
        headers: {
          accept: LFS_JSON,
          "content-type": LFS_JSON,
          ...transferHeaders(o, verify, opts),
        },
        body: JSON.stringify({ oid: o.oid, size: o.size }),
        signal: opts.signal,
      });
      await v.body?.cancel();
      if (!v.ok) throw new Error(`lfs verify ${o.oid}: HTTP ${v.status}`);
    }
    uploaded.push(o.oid);
  }
  return { uploaded, skipped };
}

export async function lfsFetch(
  url: string,
  store: LfsStore,
  objects: Pointer[],
  opts: LfsClientOptions = {},
): Promise<{ downloaded: string[] }> {
  const f = opts.fetch ?? fetch;
  const downloaded: string[] = [];
  const missing: Pointer[] = [];
  for (const o of unique(objects)) if ((await store.size(o.oid)) !== o.size) missing.push(o);
  if (!missing.length) return { downloaded };
  for (const o of await batch(url, "download", missing, opts)) {
    if (o.error) throw objectError(o);
    const action = o.actions?.download;
    if (!action) throw new Error(`lfs object ${o.oid}: no download action`);
    await store.incomplete.exclusive(o.oid, async () => {
      // another download of it may have finished while this one waited
      if ((await store.size(o.oid)) === o.size) return;
      let held = await store.incomplete.size(o.oid);
      if (held > o.size) {
        await store.incomplete.remove(o.oid);
        held = 0;
      }
      if (held < o.size) {
        const headers: Record<string, string> = transferHeaders(o, action, opts);
        if (held > 0) headers.range = `bytes=${held}-`;
        const res = await f(action.href, { headers, signal: opts.signal });
        if (res.status === 206) {
          const start = Number(/^bytes (\d+)-/.exec(res.headers.get("content-range") ?? "")?.[1]);
          if (start !== held) {
            await res.body?.cancel();
            throw new Error(`lfs download ${o.oid}: the server resumed at ${start}, not ${held}`);
          }
        } else if (res.status === 200) {
          // the whole object again: what was held is dropped
          if (held > 0) await store.incomplete.remove(o.oid);
        } else {
          await res.body?.cancel();
          if (res.status === 416) await store.incomplete.remove(o.oid);
          throw new Error(`lfs download ${o.oid}: HTTP ${res.status}`);
        }
        await store.incomplete.append(o.oid, counted(chunks(res.body), opts.stats));
        held = await store.incomplete.size(o.oid);
        if (held < o.size)
          throw new Error(
            `lfs download ${o.oid}: ended at ${held} of ${o.size} bytes (kept to resume)`,
          );
        if (held > o.size) {
          await store.incomplete.remove(o.oid);
          throw new Error(`lfs download ${o.oid}: more than ${o.size} bytes`);
        }
      }
      await store.incomplete.complete({ oid: o.oid, size: o.size });
    });
    downloaded.push(o.oid);
  }
  return { downloaded };
}
