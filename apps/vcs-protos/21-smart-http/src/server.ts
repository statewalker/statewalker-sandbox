/**
 * X8a — git's upload-pack, protocol v2 (Documentation/gitprotocol-v2.txt, gitprotocol-http.txt),
 * as a fetch handler: `(Request) => Promise<Response>`, so it runs behind node:http, a Durable
 * Object, a Service Worker or httpeers alike.
 *
 *  - GET  …/info/refs?service=git-upload-pack with `Git-Protocol: version=2`: the capability
 *    advertisement (as `git http-backend` in v2: no "# service" preamble).
 *  - POST …/git-upload-pack: `ls-refs` (symrefs, peel, ref-prefix, unborn) and `fetch` (want,
 *    have, done, thin-pack, no-progress, include-tag, ofs-delta, shallow, deepen).
 *
 * Wants must be advertised tips (git's default: no reachable or arbitrary ids). Negotiation is
 * stateless: each request carries the client's haves; the server ACKs those it has and says
 * "ready" once every want reaches a common commit (git's ok_to_give_up). The pack is X6c's walk
 * written by X6e's search (or X6d's reuse with `search: false`) and streamed in side-band-64k as
 * it is produced; progress goes on band 2 while the search runs; a cancelled response aborts the
 * generation. A malformed or hostile request gets an `ERR` packet, never a pack.
 */
import { readCommit } from "../../17-repository/src/commands.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { listObjectsWithEdges } from "../../18-pack-export/src/export.js";
import { writePackReusing } from "../../19-delta-reuse/src/export-reuse.js";
import { type SearchOptions, writePackSearching } from "../../20-delta-search/src/export-search.js";
import { DELIM, FLUSH, PktError, PktReader, pkt, sideband, text } from "./pkt-line.js";

export interface UploadPackOptions {
  agent?: string;
  /** delta search (git's); false: reuse only (X6d), the pack streams from the first objects */
  search?: boolean;
  searchOptions?: SearchOptions;
  /** request bodies above this many bytes are refused. Default 64 MiB. */
  maxRequestBytes?: number;
  /** tests: never say "ready" (the client must end the negotiation with "done") */
  neverReady?: boolean;
}

const OID = /^[0-9a-f]{40}$/;
const enc = new TextEncoder();

class ProtocolError extends Error {}

/** A byte channel for a streamed response: bounded queue, cancel → abort. */
function channel(highWater = 8) {
  const queue: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  let drained: (() => void) | undefined;
  let closed = false;
  let failure: unknown;
  const abort = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      while (!queue.length && !closed) await new Promise<void>((r) => (wake = r));
      if (queue.length) {
        ctrl.enqueue(queue.shift() as Uint8Array);
        drained?.();
      } else if (failure) ctrl.error(failure);
      else ctrl.close();
    },
    cancel() {
      abort.abort(new Error("the client went away"));
      drained?.();
    },
  });
  return {
    stream,
    signal: abort.signal,
    async write(chunk: Uint8Array) {
      abort.signal.throwIfAborted();
      queue.push(chunk);
      wake?.();
      while (queue.length > highWater && !abort.signal.aborted)
        await new Promise<void>((r) => (drained = r));
      abort.signal.throwIfAborted();
    },
    close(err?: unknown) {
      closed = true;
      failure = err;
      wake?.();
    },
  };
}

async function* limited(body: ReadableStream<Uint8Array> | null, max: number) {
  if (!body) return;
  let n = 0;
  for await (const c of body as unknown as AsyncIterable<Uint8Array>) {
    n += c.length;
    if (n > max) throw new ProtocolError(`request over ${max} bytes`);
    yield c;
  }
}

/** Advertised refs: HEAD (symref target) and every ref, tags peeled. */
async function advertised(repo: Repository) {
  const refs: { name: string; oid: string; peeled?: string; symref?: string }[] = [];
  const head = await repo.refs.read("HEAD");
  const headOid = await repo.refs.resolve("HEAD");
  for await (const r of repo.refs.list("refs/")) {
    let peeled: string | undefined;
    const o = await repo.objects.get(r.oid);
    if (o?.type === "tag") {
      // follow tag chains to the first non-tag
      let cur = r.oid;
      for (let i = 0; i < 10; i++) {
        const t = await repo.objects.get(cur);
        if (!t || t.type !== "tag") break;
        const bytes = new Uint8Array(await new Response(t.content as never).arrayBuffer());
        const m = /^object ([0-9a-f]{40})/m.exec(new TextDecoder().decode(bytes));
        if (!m) break;
        cur = m[1] as string;
      }
      peeled = cur;
    } else await o?.content[Symbol.asyncIterator]().return?.();
    refs.push(peeled ? { ...r, peeled } : r);
  }
  return {
    refs,
    head: headOid
      ? { oid: headOid, symref: head && "symref" in head ? head.symref : undefined }
      : undefined,
    unbornTarget: !headOid && head && "symref" in head ? head.symref : undefined,
  };
}

/** Reads a v2 request: command, capabilities, then arguments up to the flush. */
async function readRequest(r: PktReader) {
  let command: string | undefined;
  const caps: string[] = [];
  const args: string[] = [];
  let section: "caps" | "args" = "caps";
  for (;;) {
    const p = await r.read();
    if (!p) throw new ProtocolError("request ends before its flush");
    if (p.kind === "flush") break;
    if (p.kind === "end") throw new ProtocolError("unexpected response-end packet");
    if (p.kind === "delim") {
      if (section === "args") throw new ProtocolError("second delimiter");
      section = "args";
      continue;
    }
    const line = text(p) as string;
    if (section === "caps") {
      if (line.startsWith("command=")) {
        if (command) throw new ProtocolError("two commands");
        command = line.slice(8);
      } else caps.push(line);
    } else args.push(line);
  }
  if (!command) throw new ProtocolError("no command");
  for (const c of caps)
    if (!/^(agent|object-format|server-option|session-id)(=.*)?$/.test(c))
      throw new ProtocolError(`unknown capability ${c}`);
  if (caps.some((c) => c.startsWith("object-format=") && c !== "object-format=sha1"))
    throw new ProtocolError("only object-format=sha1 is served");
  return { command, args };
}

/** git's ok_to_give_up: every want reaches a common commit (or is one), walking no older than the oldest common. */
async function okToGiveUp(repo: Repository, wants: string[], common: Set<string>) {
  if (!common.size) return false;
  let oldest = Number.POSITIVE_INFINITY;
  const commits = new Map<string, { parents: string[]; when: number } | null>();
  const load = async (oid: string) => {
    if (!commits.has(oid)) {
      try {
        const c = await readCommit(repo, oid);
        commits.set(oid, { parents: c.parents, when: c.committer.when });
      } catch {
        commits.set(oid, null); // not a commit, or absent (a shallow boundary)
      }
    }
    return commits.get(oid);
  };
  for (const c of common) {
    const x = await load(c);
    if (x) oldest = Math.min(oldest, x.when);
  }
  for (const w of wants) {
    const seen = new Set<string>();
    const stack = [w];
    let found = false;
    while (stack.length && !found) {
      const x = stack.pop() as string;
      if (seen.has(x)) continue;
      seen.add(x);
      if (common.has(x)) found = true;
      else {
        const c = await load(x);
        if (!c || c.when < oldest) continue;
        stack.push(...c.parents);
      }
    }
    if (!found) return false;
  }
  return true;
}

/** Commits at `depth` from the wants that have parents: the new shallow boundary (git's deepen). */
async function deepenBoundary(repo: Repository, wants: string[], depth: number) {
  const boundary: string[] = [];
  const seen = new Set<string>();
  let level: string[] = [];
  for (const w of wants) {
    try {
      await readCommit(repo, w);
      level.push(w);
    } catch {
      // a want that is not a commit has no history
    }
  }
  for (let d = 1; d <= depth && level.length; d++) {
    const next: string[] = [];
    for (const c of level) {
      if (seen.has(c)) continue;
      seen.add(c);
      const commit = await readCommit(repo, c);
      if (d === depth) {
        if (commit.parents.length) boundary.push(c);
      } else next.push(...commit.parents);
    }
    level = next;
  }
  return boundary;
}

export function uploadPackHandler(
  repo: Repository,
  opts: UploadPackOptions = {},
): (req: Request) => Promise<Response> {
  const agent = opts.agent ?? "webrun-vcs/0.0";
  const maxRequest = opts.maxRequestBytes ?? 64 * 2 ** 20;
  const errorResponse = (msg: string) =>
    new Response(new Blob([pkt(`ERR ${msg}\n`) as BlobPart, FLUSH as BlobPart]), {
      status: 200,
      headers: { "content-type": "application/x-git-upload-pack-result" },
    });
  return async (req) => {
    const url = new URL(req.url);
    const v2 = (req.headers.get("git-protocol") ?? "").split(":").includes("version=2");
    if (req.method === "GET" && url.pathname.endsWith("/info/refs")) {
      if (url.searchParams.get("service") !== "git-upload-pack")
        return new Response("only git-upload-pack is served\n", { status: 403 });
      if (!v2)
        return new Response("this server speaks git protocol v2 only (git ≥ 2.26)\n", {
          status: 400,
        });
      const body = [
        pkt("version 2\n"),
        pkt(`agent=${agent}\n`),
        pkt("ls-refs=unborn\n"),
        pkt("fetch=shallow\n"),
        pkt("server-option\n"),
        pkt("object-format=sha1\n"),
        FLUSH,
      ];
      return new Response(new Blob(body as BlobPart[]), {
        headers: {
          "content-type": "application/x-git-upload-pack-advertisement",
          "cache-control": "no-cache",
        },
      });
    }
    if (req.method !== "POST" || !url.pathname.endsWith("/git-upload-pack"))
      return new Response("not found\n", { status: 404 });
    if (!v2) return new Response("git protocol v2 required\n", { status: 400 });

    let request: Awaited<ReturnType<typeof readRequest>>;
    const reader = new PktReader(limited(req.body, maxRequest));
    try {
      request = await readRequest(reader);
    } catch (e) {
      if (e instanceof ProtocolError || e instanceof PktError) return errorResponse(e.message);
      throw e;
    }
    try {
      if (request.command === "ls-refs") return await lsRefs(repo, request.args);
      if (request.command === "fetch") return await fetchCommand(repo, request.args, opts);
      return errorResponse(`unknown command ${request.command}`);
    } catch (e) {
      if (e instanceof ProtocolError) return errorResponse(e.message);
      throw e;
    }
  };
}

async function lsRefs(repo: Repository, args: string[]): Promise<Response> {
  let symrefs = false;
  let peel = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === "symrefs") symrefs = true;
    else if (a === "peel") peel = true;
    else if (a === "unborn") unborn = true;
    else if (a.startsWith("ref-prefix ")) prefixes.push(a.slice(11));
    else throw new ProtocolError(`unexpected line: '${a}'`);
  }
  const want = (name: string) => !prefixes.length || prefixes.some((p) => name.startsWith(p));
  const adv = await advertised(repo);
  const out: Uint8Array[] = [];
  if (want("HEAD")) {
    if (adv.head)
      out.push(
        pkt(
          `${adv.head.oid} HEAD${symrefs && adv.head.symref ? ` symref-target:${adv.head.symref}` : ""}\n`,
        ),
      );
    else if (unborn && adv.unbornTarget)
      out.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${adv.unbornTarget}` : ""}\n`));
  }
  for (const r of adv.refs)
    if (want(r.name))
      out.push(pkt(`${r.oid} ${r.name}${peel && r.peeled ? ` peeled:${r.peeled}` : ""}\n`));
  out.push(FLUSH);
  return new Response(new Blob(out as BlobPart[]), {
    headers: { "content-type": "application/x-git-upload-pack-result" },
  });
}

async function fetchCommand(
  repo: Repository,
  args: string[],
  opts: UploadPackOptions,
): Promise<Response> {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let done = false;
  let thin = false;
  let progress = true;
  let includeTag = false;
  let deepen: number | undefined;
  for (const a of args) {
    const [k, v] = [a.split(" ", 1)[0] as string, a.slice(a.indexOf(" ") + 1)];
    if (k === "want") {
      if (!OID.test(v)) throw new ProtocolError(`bad want ${v}`);
      wants.push(v);
    } else if (k === "have") {
      if (!OID.test(v)) throw new ProtocolError(`bad have ${v}`);
      haves.push(v);
    } else if (k === "shallow") {
      if (!OID.test(v)) throw new ProtocolError(`bad shallow ${v}`);
      clientShallow.push(v);
    } else if (k === "deepen") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new ProtocolError(`bad deepen ${v}`);
      deepen = n;
    } else if (a === "done") done = true;
    else if (a === "thin-pack") thin = true;
    else if (a === "no-progress") progress = false;
    else if (a === "include-tag") includeTag = true;
    else if (a === "ofs-delta") {
      // accepted; REF_DELTA is written (both are valid in a pack)
    } else throw new ProtocolError(`unexpected line: '${a}'`);
  }
  if (!wants.length) throw new ProtocolError("no want");
  // wants must be advertised tips (or peeled tag targets): git's default
  const adv = await advertised(repo);
  const tips = new Set<string>();
  for (const r of adv.refs) {
    tips.add(r.oid);
    if (r.peeled) tips.add(r.peeled);
  }
  if (adv.head) tips.add(adv.head.oid);
  for (const w of wants) if (!tips.has(w)) throw new ProtocolError(`upload-pack: not our ref ${w}`);

  const common = new Set<string>();
  for (const h of haves) if (await repo.objects.has(h)) common.add(h);
  const ready = !done && !opts.neverReady && (await okToGiveUp(repo, wants, common));
  const head: Uint8Array[] = [];
  if (!done) {
    head.push(pkt("acknowledgments\n"));
    if (!common.size) head.push(pkt("NAK\n"));
    for (const c of common) head.push(pkt(`ACK ${c}\n`));
    if (!ready) {
      head.push(FLUSH);
      return new Response(new Blob(head as BlobPart[]), {
        headers: { "content-type": "application/x-git-upload-pack-result" },
      });
    }
    head.push(pkt("ready\n"), DELIM);
  }
  const boundary = deepen ? await deepenBoundary(repo, wants, deepen) : [];
  if (deepen) {
    head.push(pkt("shallow-info\n"));
    for (const b of boundary) head.push(pkt(`shallow ${b}\n`));
    head.push(DELIM);
  }
  head.push(pkt("packfile\n"));

  const ch = channel();
  const produce = async () => {
    for (const h of head) await ch.write(h);
    const say = async (m: string) => {
      if (progress) for (const p of sideband(2, enc.encode(m))) await ch.write(p);
    };
    const signal = ch.signal;
    const shallow = [...clientShallow, ...boundary];
    const { objects, edges, receiverHas } = await listObjectsWithEdges(repo, wants, [...common], {
      signal,
      shallow,
    });
    if (includeTag) {
      const sent = new Set(objects.map((o) => o.oid));
      for (const r of adv.refs)
        if (r.peeled && sent.has(r.peeled) && !sent.has(r.oid) && !common.has(r.oid)) {
          objects.push({ oid: r.oid, type: "tag" });
          sent.add(r.oid);
        }
    }
    await say(`Enumerating objects: ${objects.length}, done.\n`);
    let last = -1;
    const pending: Uint8Array[] = [];
    const pack =
      opts.search === false
        ? writePackReusing(repo, objects, {
            signal,
            thin,
            receiverHas: (o) => receiverHas.has(o),
          })
        : writePackSearching(repo, objects, {
            ...opts.searchOptions,
            signal,
            thin,
            edges,
            receiverHas: (o) => receiverHas.has(o),
            onProgress: (i, n) => {
              const pct = Math.floor((100 * i) / Math.max(1, n));
              if (progress && pct !== last) {
                last = pct;
                pending.push(
                  ...sideband(2, enc.encode(`Compressing objects: ${pct}% (${i}/${n})\r`)),
                );
              }
            },
          });
    for await (const chunk of pack) {
      while (pending.length) await ch.write(pending.shift() as Uint8Array);
      for (const p of sideband(1, chunk)) await ch.write(p);
    }
    await ch.write(FLUSH);
  };
  produce().then(
    () => ch.close(),
    (e) => {
      if (ch.signal.aborted) ch.close();
      else {
        // an error after the response started: on the error band, then end
        const msg = e instanceof Error ? e.message : String(e);
        ch.write(concat(sideband(3, enc.encode(`${msg}\n`)))).finally(() => ch.close());
      }
    },
  );
  return new Response(ch.stream, {
    headers: {
      "content-type": "application/x-git-upload-pack-result",
      "cache-control": "no-cache",
    },
  });
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
