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
 * `authorize` decides each batch (401 with `LFS-Authenticate` when credentials are needed, 403
 * when they do not allow the operation). With `transferAuth`, actions carry headers scoped to their
 * object and transfers are checked against them; without it, transfers go through `authorize`.
 */
import type { LfsStore } from "./store.js";

export type LfsOperation = "download" | "upload";
export interface LfsServerOptions {
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
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) return;
      yield r.value;
    }
  } finally {
    reader.releaseLock();
  }
}

export function lfsHandler(
  store: LfsStore,
  opts: LfsServerOptions = {},
): (req: Request) => Promise<Response> {
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

  return async (req) => {
    const url = new URL(req.url);
    const m = LFS_PATH.exec(url.pathname);
    if (!m) return json(404, { message: "not an LFS request" });
    const base = `${url.origin}${m[1]}/info/lfs`;
    const path = m[2] as string;
    try {
      if (path === "/objects/batch" && req.method === "POST") {
        const input = (await req.json().catch(() => undefined)) as
          | {
              operation?: string;
              objects?: { oid?: unknown; size?: unknown }[];
              hash_algo?: string;
            }
          | undefined;
        const op = input?.operation;
        if (!input || (op !== "download" && op !== "upload") || !Array.isArray(input.objects))
          return json(422, { message: "a batch needs an operation and objects" });
        if (input.hash_algo !== undefined && input.hash_algo !== "sha256")
          return json(409, { message: `hash algorithm ${input.hash_algo} is not supported` });
        const ok = await allow(req, op);
        if (ok !== true) return refusal(ok);
        const objects = [];
        for (const o of input.objects) {
          const oid = o.oid;
          const size = o.size;
          if (
            typeof oid !== "string" ||
            !OID.test(oid) ||
            typeof size !== "number" ||
            !Number.isSafeInteger(size) ||
            size < 0
          ) {
            objects.push({ oid, size, error: { code: 422, message: "invalid object id or size" } });
            continue;
          }
          const held = await store.size(oid);
          const href = `${base}/objects/${oid}`;
          const header = opts.transferAuth ? await opts.transferAuth.headers(op, oid) : undefined;
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
                authenticated: true,
                actions: { download: { href, header, expires_in: 3600 } },
              });
          } else if (held === size) objects.push({ oid, size, authenticated: true });
          else
            objects.push({
              oid,
              size,
              authenticated: true,
              actions: {
                upload: { href, header, expires_in: 3600 },
                verify: { href: `${base}/verify`, header, expires_in: 3600 },
              },
            });
        }
        return json(200, { transfer: "basic", objects, hash_algo: "sha256" });
      }
      const obj = /^\/objects\/([0-9a-f]{64})$/.exec(path);
      if (obj && (req.method === "GET" || req.method === "HEAD")) {
        const oid = obj[1] as string;
        const ok = await allowTransfer(req, "download", oid);
        if (ok !== true) return refusal(ok);
        const size = await store.size(oid);
        if (size === undefined) return json(404, { message: "object does not exist" });
        const range = req.headers.get("range");
        let start = 0;
        let end = size - 1;
        let status = 200;
        if (range) {
          const r = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
          if (!r)
            return json(
              416,
              { message: "only one byte range is supported" },
              { "content-range": `bytes */${size}` },
            );
          start = Number(r[1]);
          if (r[2]) end = Math.min(Number(r[2]), size - 1);
          // end ≤ size - 1, so a start past the end is caught here too
          if (end < start)
            return json(
              416,
              { message: "range not satisfiable" },
              { "content-range": `bytes */${size}` },
            );
          status = 206;
        }
        const headers: Record<string, string> = {
          "content-type": "application/octet-stream",
          "content-length": String(end - start + 1),
          "accept-ranges": "bytes",
        };
        if (status === 206) headers["content-range"] = `bytes ${start}-${end}/${size}`;
        if (req.method === "HEAD") return new Response(null, { status, headers });
        return new Response(
          stream(slice(store.read(oid, { start, signal: req.signal }), end - start + 1)),
          { status, headers },
        );
      }
      if (obj && req.method === "PUT") {
        const oid = obj[1] as string;
        const ok = await allowTransfer(req, "upload", oid);
        if (ok !== true) return refusal(ok);
        const length = req.headers.get("content-length");
        try {
          await store.put(body(req), { oid, size: length ? Number(length) : undefined });
        } catch (e) {
          if ((e as Error).name === "ObjectIdMismatchError")
            return json(422, { message: (e as Error).message });
          throw e;
        }
        return new Response(null, { status: 200 });
      }
      if (path === "/verify" && req.method === "POST") {
        const input = (await req.json().catch(() => undefined)) as
          | { oid?: string; size?: number }
          | undefined;
        if (!input || typeof input.oid !== "string" || !OID.test(input.oid))
          return json(422, { message: "invalid object id" });
        const ok = await allowTransfer(req, "upload", input.oid);
        if (ok !== true) return refusal(ok);
        return (await store.size(input.oid)) === input.size
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
