/**
 * X10a — the Git LFS Batch API and the `basic` transfer as a fetch handler (docs/api in git-lfs):
 *
 *  - `POST …/info/lfs/objects/batch`: per object, a `download` or `upload` action (an `href` and
 *    the headers to send with it), no action for an upload the server already holds, a `verify`
 *    action after an upload, or an error (404 missing, 422 invalid oid or size);
 *  - `GET …/info/lfs/objects/<oid>`: the content, `Range: bytes=N-[M]` answered 206 (416 past the
 *    end) — what a client resumes with;
 *  - `PUT …/info/lfs/objects/<oid>`: streamed into the store, which verifies before the object is
 *    visible (422 on a mismatch);
 *  - `POST …/info/lfs/verify`: 200 when the object is held with that size, 404 otherwise.
 *
 * `authorize` decides each batch before anything in it is answered (401 with `LFS-Authenticate`
 * when credentials are needed, 403 when they do not allow the operation). With `transferAuth`,
 * actions carry headers scoped to their object, objects are marked `authenticated`, and transfers
 * are checked against those headers; without it, nothing is marked and transfers go through
 * `authorize` (git-lfs then sends its credentials with them). A batch is bounded in bytes and
 * objects; `maxObjectSize` bounds objects (batch 422, PUT 413); `GET` follows RFC 9110's single
 * ranges (suffix included, unusable ones ignored) with the oid as a strong ETag for `If-Range`.
 */
import { createSha256, toHex } from "../../03-sha256-blake3/src/hashes.js";
import type { LfsStore } from "./store.js";

export type LfsOperation = "download" | "upload";
export interface LfsServerOptions {
  /** the URL clients reach this repository at (behind a proxy); default: the request's */
  publicUrl?: string;
  /** objects larger are refused (batch 422, PUT 413) */
  maxObjectSize?: number;
  /** bounds on a batch request: bytes of its body (1 MiB) and objects (1000) */
  maxBatchBytes?: number;
  maxBatchObjects?: number;
  /**
   * X12's `ranged` transfer adapter, chosen when a client offers it: uploads as `PUT`s with
   * `Content-Range`, `HEAD` reporting the held ranges (`x-lfs-held`). Default off.
   */
  ranged?: boolean;
  /**
   * ranged: who is uploading (a mesh peer's proven id). Each uploader's parts are kept apart, per
   * declared size, so one uploader's bytes can never spoil another's. Default: one for everyone.
   */
  uploader?: (req: Request) => string;
  /** per batch: true, or a refusal (401: credentials needed; 403: not allowed) */
  authorize?: (
    req: Request,
    operation: LfsOperation,
  ) => Promise<true | { status: 401 | 403; message: string }>;
  /** headers an action carries, and their check on the transfer request (scoped per object) */
  transferAuth?: {
    headers(operation: LfsOperation, oid: string): Promise<Record<string, string>>;
    check(req: Request, operation: LfsOperation, oid: string): Promise<boolean>;
  };
}

const LFS_JSON = "application/vnd.git-lfs+json";
const OID = /^[0-9a-f]{64}$/;
const LFS_PATH = /^(.*)\/info\/lfs(\/.*)$/;

export function isLfsRequest(req: Request): boolean {
  return LFS_PATH.test(new URL(req.url).pathname);
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": LFS_JSON, ...headers },
  });
const refusal = (r: { status: 401 | 403; message: string }) =>
  json(
    r.status,
    { message: r.message },
    r.status === 401 ? { "lfs-authenticate": 'Basic realm="Git LFS"' } : {},
  );

/** the bytes [start, start + length) of `source` */
async function* slice(
  source: AsyncIterable<Uint8Array>,
  length: number,
): AsyncGenerator<Uint8Array> {
  let left = length;
  for await (const c of source) {
    if (left <= 0) return;
    if (c.length > left) {
      yield c.subarray(0, left);
      return;
    }
    left -= c.length;
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
async function* body(req: Request): AsyncGenerator<Uint8Array> {
  if (!req.body) return;
  const reader = req.body.getReader();
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
    // stopped early (a refusal, a limit): the rest of the body is released
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** the body as text, refused past `max` bytes */
async function boundedText(req: Request, max: number): Promise<string | undefined> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of body(req)) {
    n += c.length;
    if (n > max) return undefined;
    parts.push(c);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return new TextDecoder().decode(all);
}
const isSize = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * RFC 9110 for one representation: `bytes=a-b`, `bytes=a-`, `bytes=-n` (the last n bytes) → the
 * range; past the end → "unsatisfiable"; anything else (other units, several ranges, a malformed
 * or reversed range) → ignored (the whole representation is sent).
 */
function byteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return undefined;
  if (!m[1]) {
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] && Number(m[2]) < start) return undefined; // reversed: not a valid range
  if (start >= size) return "unsatisfiable";
  return { start, end: m[2] ? Math.min(Number(m[2]), size - 1) : size - 1 };
}

export function lfsHandler(
  store: LfsStore,
  opts: LfsServerOptions = {},
): (req: Request) => Promise<Response> {
  const maxBatchBytes = opts.maxBatchBytes ?? 1 << 20;
  const maxBatchObjects = opts.maxBatchObjects ?? 1000;
  const allow = async (req: Request, op: LfsOperation) =>
    opts.authorize ? opts.authorize(req, op) : true;
  /** a transfer: the action's scoped headers, or the batch's authorization */
  const allowTransfer = async (req: Request, op: LfsOperation, oid: string) => {
    if (opts.transferAuth)
      return (await opts.transferAuth.check(req, op, oid))
        ? (true as const)
        : { status: 401 as const, message: "this transfer is not authorized" };
    return allow(req, op);
  };
  const tooLarge = (size: number) => opts.maxObjectSize !== undefined && size > opts.maxObjectSize;

  /** ranged: the parts of one uploader for one declared size */
  const scopeOf = (req: Request, size: number) =>
    toHex(
      createSha256()
        .update(new TextEncoder().encode(`${size}\0${opts.uploader?.(req) ?? ""}`))
        .digest(),
    ).slice(0, 32);
  const heldHeader = (held: [number, number][]) => held.map(([a, b]) => `${a}-${b - 1}`).join(",");
  const covers = (held: [number, number][], size: number) =>
    held.length === 1 && held[0]?.[0] === 0 && held[0]?.[1] === size;
  /** completes the object from a scope's parts when they cover it; true when it is there */
  const completeIfCovered = async (oid: string, size: number, scope: string) =>
    store.incomplete.exclusive(oid, async () => {
      if ((await store.size(oid)) === size) return true;
      if (!covers(await store.incomplete.ranges(oid, scope), size)) return false;
      await store.incomplete.complete({ oid, size }, scope);
      return true;
    });
  const completed = () =>
    new Response(null, { status: 200, headers: { "x-lfs-complete": "true" } });

  /**
   * ranged: one part of an upload (`Content-Range: bytes a-b/size`). Kept with its uploader's
   * other parts for that size, only when whole and exactly its range's length; a part overlapping
   * what is held is refused (409) — unless the parts already cover the object, which is then
   * completed (a client re-sending its last part finishes an upload whose completion was missed).
   * The part that completes the coverage verifies the object (`x-lfs-complete`).
   */
  const putPart = async (req: Request, oid: string, contentRange: string): Promise<Response> => {
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange.trim());
    const start = Number(m?.[1]);
    const end = Number(m?.[2]);
    const size = Number(m?.[3]);
    const refuse = async (status: number, message: string) => {
      await req.body?.cancel().catch(() => {});
      return json(status, { message });
    };
    if (!m || !isSize(start) || !isSize(end) || !isSize(size) || end < start || end >= size)
      return refuse(400, `invalid Content-Range ${JSON.stringify(contentRange)}`);
    if (tooLarge(size)) return refuse(413, `over the limit of ${opts.maxObjectSize} bytes`);
    const scope = scopeOf(req, size);
    try {
      if (await completeIfCovered(oid, size, scope)) {
        await req.body?.cancel().catch(() => {});
        return completed();
      }
      const held = await store.incomplete.ranges(oid, scope);
      if (held.some(([a, b]) => a <= end && start < b))
        return refuse(409, `bytes ${start}-${end} overlap what is held: ${heldHeader(held)}`);
      try {
        await store.incomplete.write(oid, start, body(req), { scope, length: end - start + 1 });
      } catch (e) {
        if ((e as Error).name === "LfsPartLengthError")
          return json(400, { message: (e as Error).message });
        throw e;
      }
      if (await completeIfCovered(oid, size, scope)) return completed();
      return new Response(null, {
        status: 200,
        headers: { "x-lfs-held": heldHeader(await store.incomplete.ranges(oid, scope)) },
      });
    } catch (e) {
      if ((e as Error).name === "ObjectIdMismatchError")
        return json(422, { message: (e as Error).message });
      throw e;
    }
  };

  return async (req) => {
    const url = new URL(req.url);
    const m = LFS_PATH.exec(url.pathname);
    if (!m) return json(404, { message: "not an LFS request" });
    const base = opts.publicUrl
      ? `${opts.publicUrl.replace(/\/+$/, "")}/info/lfs`
      : `${url.origin}${m[1]}/info/lfs`;
    const path = m[2] as string;
    try {
      if (path === "/objects/batch" && req.method === "POST") {
        const text = await boundedText(req, maxBatchBytes);
        if (text === undefined)
          return json(413, { message: `a batch request is limited to ${maxBatchBytes} bytes` });
        let input:
          | { operation?: unknown; objects?: unknown; hash_algo?: unknown; transfers?: unknown }
          | undefined;
        try {
          const parsed = JSON.parse(text) as unknown;
          if (parsed && typeof parsed === "object") input = parsed as typeof input;
        } catch {}
        const op = input?.operation;
        // authorized before anything about the request is answered (an unknown operation is
        // asked about as the least one)
        const ok = await allow(req, op === "upload" ? "upload" : "download");
        if (ok !== true) return refusal(ok);
        if (!input || (op !== "download" && op !== "upload") || !Array.isArray(input.objects))
          return json(422, { message: "a batch needs an operation and objects" });
        if (input.hash_algo !== undefined && input.hash_algo !== "sha256")
          return json(409, {
            message: `hash algorithm ${String(input.hash_algo)} is not supported`,
          });
        if (input.objects.length > maxBatchObjects)
          return json(413, { message: `a batch is limited to ${maxBatchObjects} objects` });
        // the actions' own headers authorize their transfers: only then are they "authenticated"
        const authenticated = opts.transferAuth ? { authenticated: true } : {};
        const action = async (href: string, oid: string) => ({
          href,
          header: opts.transferAuth ? await opts.transferAuth.headers(op, oid) : undefined,
          expires_in: 3600,
        });
        const objects = [];
        for (const raw of input.objects as unknown[]) {
          const o = (raw && typeof raw === "object" ? raw : {}) as {
            oid?: unknown;
            size?: unknown;
          };
          const { oid, size } = o;
          if (typeof oid !== "string" || !OID.test(oid) || !isSize(size)) {
            objects.push({ oid, size, error: { code: 422, message: "invalid object id or size" } });
            continue;
          }
          if (tooLarge(size)) {
            objects.push({
              oid,
              size,
              error: { code: 422, message: `over the limit of ${opts.maxObjectSize} bytes` },
            });
            continue;
          }
          const held = await store.size(oid);
          const href = `${base}/objects/${oid}`;
          if (op === "download") {
            if (held === undefined)
              objects.push({ oid, size, error: { code: 404, message: "object does not exist" } });
            else if (held !== size)
              objects.push({
                oid,
                size,
                error: { code: 422, message: `object has ${held} bytes` },
              });
            else
              objects.push({
                oid,
                size,
                ...authenticated,
                actions: { download: await action(href, oid) },
              });
          } else if (held === size) objects.push({ oid, size });
          else
            objects.push({
              oid,
              size,
              ...authenticated,
              actions: {
                upload: await action(href, oid),
                verify: await action(`${base}/verify`, oid),
              },
            });
        }
        const transfer =
          opts.ranged && Array.isArray(input.transfers) && input.transfers.includes("ranged")
            ? "ranged"
            : "basic";
        return json(200, { transfer, objects, hash_algo: "sha256" });
      }
      const obj = /^\/objects\/([0-9a-f]{64})$/.exec(path);
      if (obj && (req.method === "GET" || req.method === "HEAD")) {
        const oid = obj[1] as string;
        let ok = await allowTransfer(req, "download", oid);
        // ranged: an uploader asks with HEAD (and `x-lfs-size`) what of its parts is held
        let uploadOnly = false;
        if (ok !== true && opts.ranged && req.method === "HEAD") {
          ok = await allowTransfer(req, "upload", oid);
          uploadOnly = ok === true;
        }
        if (ok !== true) return refusal(ok);
        const size = await store.size(oid);
        if (size === undefined) {
          if (!opts.ranged) return json(404, { message: "object does not exist" });
          const declared = req.headers.get("x-lfs-size");
          const held =
            declared !== null && /^\d+$/.test(declared) && isSize(Number(declared))
              ? await store.incomplete.ranges(oid, scopeOf(req, Number(declared)))
              : [];
          return json(
            404,
            { message: "object does not exist" },
            { "x-lfs-held": heldHeader(held) },
          );
        }
        // an uploader learns that the object is there, not what it holds
        if (uploadOnly) return new Response(null, { status: 200 });
        // content-addressed: the oid is a strong validator
        const etag = `"${oid}"`;
        const ifRange = req.headers.get("if-range");
        const range =
          ifRange === null || ifRange === etag
            ? byteRange(req.headers.get("range"), size)
            : undefined;
        if (range === "unsatisfiable")
          return json(
            416,
            { message: "range not satisfiable" },
            { "content-range": `bytes */${size}` },
          );
        const start = range?.start ?? 0;
        const end = range?.end ?? size - 1;
        const status = range ? 206 : 200;
        const headers: Record<string, string> = {
          "content-type": "application/octet-stream",
          "content-length": String(end - start + 1),
          "accept-ranges": "bytes",
          etag,
        };
        if (range) headers["content-range"] = `bytes ${start}-${end}/${size}`;
        if (req.method === "HEAD" || size === 0) return new Response(null, { status, headers });
        return new Response(
          stream(slice(store.read(oid, { start, signal: req.signal }), end - start + 1)),
          { status, headers },
        );
      }
      if (obj && req.method === "PUT") {
        const oid = obj[1] as string;
        const ok = await allowTransfer(req, "upload", oid);
        if (ok !== true) return refusal(ok);
        const contentRange = req.headers.get("content-range");
        if (opts.ranged && contentRange !== null) return putPart(req, oid, contentRange);
        const length = req.headers.get("content-length");
        if (length !== null && !/^\d+$/.test(length))
          return json(400, { message: `invalid Content-Length ${JSON.stringify(length)}` });
        const size = length === null ? undefined : Number(length);
        if (size !== undefined && tooLarge(size))
          return json(413, { message: `over the limit of ${opts.maxObjectSize} bytes` });
        try {
          await store.put(body(req), { oid, size }, { maxSize: opts.maxObjectSize });
        } catch (e) {
          const name = (e as Error).name;
          if (name === "ObjectIdMismatchError") return json(422, { message: (e as Error).message });
          if (name === "LfsTooLargeError") return json(413, { message: (e as Error).message });
          throw e;
        }
        return new Response(null, { status: 200 });
      }
      if (path === "/verify" && req.method === "POST") {
        const text = await boundedText(req, 4096);
        let input: { oid?: unknown; size?: unknown } | undefined;
        try {
          input = text === undefined ? undefined : (JSON.parse(text) as typeof input);
        } catch {}
        const oid = input?.oid;
        if (typeof oid !== "string" || !OID.test(oid) || !isSize(input?.size))
          return json(422, { message: "invalid object id or size" });
        const ok = await allowTransfer(req, "upload", oid);
        if (ok !== true) return refusal(ok);
        return (await store.size(oid)) === input?.size
          ? json(200, {})
          : json(404, { message: "object does not exist" });
      }
      return json(404, { message: `${req.method} ${path} is not served` });
    } catch (e) {
      return json(500, { message: String(e) });
    }
  };
}

/** one URL: LFS requests to `lfs`, the rest to `git` */
export function withLfs(
  git: (req: Request) => Promise<Response>,
  lfs: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return (req) => (isLfsRequest(req) ? lfs(req) : git(req));
}
