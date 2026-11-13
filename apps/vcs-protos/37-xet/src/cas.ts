/**
 * X11c — reading Xet files from the live services, as a portable client (only `fetch`): the Hub's
 * path info (a file's Xet hash and SHA-256), a read token for the CAS, the CAS reconstruction
 * answer (v1, or v2 turned into v1's shape), and xorb byte ranges fetched with retries and resumed
 * where a body was cut short. `downloadXetFile` chains them into `reconstruct`.
 */

import { type ReconstructionAnswer, type ReconstructionVerifier, reconstruct } from "./xet.js";

type Fetch = typeof fetch;
export type RepoType = "model" | "dataset" | "space";
export interface RepoRef {
  repo: string;
  repoType?: RepoType;
  revision?: string;
  /** default https://huggingface.co */
  hubUrl?: string;
  /** a Hub token for private repositories (not needed for public ones) */
  token?: string;
  fetch?: Fetch;
}

/** an HTTP answer that is not the one asked for */
export class XetHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "XetHttpError";
  }
}

const apiBase = (r: RepoRef) => {
  const type = r.repoType ?? "model";
  const kind = type === "model" ? "models" : `${type}s`;
  return `${r.hubUrl ?? "https://huggingface.co"}/api/${kind}/${r.repo}`;
};
const auth = (token?: string): Record<string, string> =>
  token ? { authorization: `Bearer ${token}` } : {};

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new XetHttpError(`${what}: HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

/** a file of a repository as the Hub's `paths-info` describes it */
export interface HubFile {
  path: string;
  size: number;
  /** the Xet file hash (absent for a file not stored with Xet) */
  xetHash?: string;
  /** the file's SHA-256 (the LFS object id), hex */
  sha256?: string;
}

export async function hubPathInfo(
  r: RepoRef,
  path: string,
  o: { signal?: AbortSignal } = {},
): Promise<HubFile> {
  const f = r.fetch ?? fetch;
  const res = await f(`${apiBase(r)}/paths-info/${encodeURIComponent(r.revision ?? "main")}`, {
    method: "POST",
    signal: o.signal,
    headers: { "content-type": "application/json", ...auth(r.token) },
    body: JSON.stringify({ paths: [path], expand: false }),
  });
  const rows = await json<
    { path: string; type: string; size: number; xetHash?: string; lfs?: { oid: string } }[]
  >(res, `paths-info ${path}`);
  const row = rows.find((x) => x.path === path && x.type === "file");
  if (!row) throw new XetHttpError(`${path}: no such file`);
  return { path: row.path, size: row.size, xetHash: row.xetHash, sha256: row.lfs?.oid };
}

export interface XetToken {
  casUrl: string;
  accessToken: string;
  /** expiry, seconds since the epoch */
  exp: number;
}

/** a read token for the CAS (anonymous for public repositories) */
export async function xetReadToken(
  r: RepoRef,
  o: { signal?: AbortSignal } = {},
): Promise<XetToken> {
  const f = r.fetch ?? fetch;
  const res = await f(`${apiBase(r)}/xet-read-token/${encodeURIComponent(r.revision ?? "main")}`, {
    headers: auth(r.token),
    signal: o.signal,
  });
  return json<XetToken>(res, "xet-read-token");
}

/** the v2 answer: per xorb, a URL and its ranges (chunks, inclusive bytes) */
export interface ReconstructionAnswerV2 {
  offset_into_first_range: number;
  terms: ReconstructionAnswer["terms"];
  xorbs: Record<
    string,
    {
      url: string;
      ranges: { chunks: { start: number; end: number }; bytes: { start: number; end: number } }[];
    }[]
  >;
}

/** v2's `xorbs[].ranges[]` as v1's fetch entries (one per range, the same URL) */
export function v2ToV1(a: ReconstructionAnswerV2): ReconstructionAnswer {
  const fetch_info: ReconstructionAnswer["fetch_info"] = {};
  for (const [hash, entries] of Object.entries(a.xorbs))
    fetch_info[hash] = entries.flatMap((e) =>
      e.ranges.map((r) => ({ range: r.chunks, url: e.url, url_range: r.bytes })),
    );
  return { offset_into_first_range: a.offset_into_first_range, terms: a.terms, fetch_info };
}

/**
 * The reconstruction answer for a file hash, all of it or the bytes `range` (inclusive, as an
 * HTTP `Range`: the answer's terms then cover it, `offset_into_first_range` into the first).
 * v2 by default, as the specification asks, falling back to the deprecated v1 where v2 answers
 * 404 or 501; `version` forces one.
 */
export async function fetchReconstruction(o: {
  token: XetToken;
  fileHash: string;
  range?: { start: number; end: number };
  version?: 1 | 2;
  fetch?: Fetch;
  signal?: AbortSignal;
}): Promise<ReconstructionAnswer> {
  const f = o.fetch ?? fetch;
  const headers: Record<string, string> = { authorization: `Bearer ${o.token.accessToken}` };
  if (o.range) headers.range = `bytes=${o.range.start}-${o.range.end}`;
  const ask = (v: 1 | 2) =>
    f(`${o.token.casUrl}/v${v}/reconstructions/${o.fileHash}`, { headers, signal: o.signal });
  let v: 1 | 2 = o.version ?? 2;
  let res = await ask(v);
  if (o.version === undefined && (res.status === 404 || res.status === 501)) {
    await res.body?.cancel().catch(() => {});
    v = 1;
    res = await ask(v);
  }
  if (res.status === 416) {
    await res.body?.cancel().catch(() => {});
    throw new XetHttpError("reconstruction: range not satisfiable", 416);
  }
  const body = await json<ReconstructionAnswer | ReconstructionAnswerV2>(res, "reconstruction");
  return v === 2 ? v2ToV1(body as ReconstructionAnswerV2) : (body as ReconstructionAnswer);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    // the listener goes with the pause: a long-lived signal does not collect one per retry
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Xorb byte ranges over HTTP (signed URLs need no token): `Range: bytes=start-end`, the body
 * streamed as it arrives. A failed request (network error, 429, 5xx), or a body that errors or
 * ends early, is tried again from the next byte not yet yielded, after a growing pause, up to
 * `retries` times in a row (progress resets the count). A server that ignores `Range` (200) is
 * read from the start, skipping what was yielded; a `Content-Range` that starts elsewhere is
 * refused.
 */
export function httpRanges(
  o: { fetch?: Fetch; retries?: number; backoffMs?: number; signal?: AbortSignal } = {},
): (url: string, start: number, end: number) => AsyncIterable<Uint8Array> {
  const f = o.fetch ?? fetch;
  const retries = o.retries ?? 4;
  const backoff = o.backoffMs ?? 250;
  return async function* (url, start, end) {
    let at = start;
    let failures = 0;
    const again = async (why: unknown, retryAfter?: string | null) => {
      if (++failures > retries)
        throw why instanceof Error ? why : new XetHttpError(`${url}: ${String(why)}`);
      // a 429's Retry-After (seconds, up to a minute) over the growing pause
      const asked = Number(retryAfter);
      const wait =
        retryAfter && Number.isFinite(asked) && asked > 0
          ? Math.min(asked, 60) * 1000
          : backoff * 2 ** (failures - 1);
      await sleep(wait, o.signal);
    };
    while (at <= end) {
      let res: Response;
      try {
        res = await f(url, { headers: { range: `bytes=${at}-${end}` }, signal: o.signal });
      } catch (e) {
        if (o.signal?.aborted) throw e;
        await again(e);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel().catch(() => {});
        await again(
          new XetHttpError(`${url}: HTTP ${res.status}`, res.status),
          res.headers.get("retry-after"),
        );
        continue;
      }
      let skip = 0;
      if (res.status === 200)
        skip = at; // Range ignored: the whole object
      else if (res.status === 206) {
        const m = /^bytes (\d+)-/.exec(res.headers.get("content-range") ?? "");
        if (!m || Number(m[1]) !== at) {
          await res.body?.cancel().catch(() => {});
          throw new XetHttpError(
            `${url}: answered another range (${res.headers.get("content-range")})`,
          );
        }
      } else {
        await res.body?.cancel().catch(() => {});
        throw new XetHttpError(`${url}: HTTP ${res.status}`, res.status);
      }
      if (!res.body) {
        await again(new XetHttpError(`${url}: no body`));
        continue;
      }
      const reader = res.body.getReader();
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          let piece = r.value;
          if (skip) {
            const s = Math.min(skip, piece.length);
            piece = piece.subarray(s);
            skip -= s;
          }
          if (at + piece.length > end + 1) piece = piece.subarray(0, end + 1 - at);
          if (!piece.length) {
            if (at > end) break;
            continue;
          }
          at += piece.length;
          failures = 0;
          yield piece;
          if (at > end) break;
        }
      } catch (e) {
        if (o.signal?.aborted) throw e;
        await again(e);
        continue;
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (at <= end) await again(new XetHttpError(`${url}: body ended at byte ${at}`));
    }
  };
}

/**
 * A file of a Hub repository (stored with Xet) streamed: its path info, a read token, the
 * reconstruction answer (all of it, or `range`), and the xorb ranges fetched with retries and
 * resumed. `verify` checks chunks and terms as they stream (`verifierFromShard`).
 */
export async function* downloadXetFile(
  r: RepoRef,
  path: string,
  o: {
    range?: { start: number; end: number };
    version?: 1 | 2;
    verify?: ReconstructionVerifier;
    retries?: number;
    backoffMs?: number;
    signal?: AbortSignal;
  } = {},
): AsyncGenerator<Uint8Array> {
  const info = await hubPathInfo(r, path, { signal: o.signal });
  if (!info.xetHash) throw new XetHttpError(`${path}: not stored with Xet`);
  const token = await xetReadToken(r, { signal: o.signal });
  const answer = await fetchReconstruction({
    token,
    fileHash: info.xetHash,
    range: o.range,
    version: o.version,
    fetch: r.fetch,
    signal: o.signal,
  });
  const length = o.range ? o.range.end - o.range.start + 1 : undefined;
  yield* reconstruct(
    answer,
    httpRanges({ fetch: r.fetch, retries: o.retries, backoffMs: o.backoffMs, signal: o.signal }),
    { length, verify: o.verify },
  );
}
