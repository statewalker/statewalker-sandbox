/**
 * X8b — git's receive-pack (Documentation/gitprotocol-pack.txt, gitprotocol-http.txt) as a fetch
 * handler. git has no push in protocol v2: `git push` over HTTP speaks v0 —
 *
 *  - GET  …/info/refs?service=git-receive-pack: "# service=git-receive-pack", flush, the refs
 *    (capabilities after a NUL on the first; `capabilities^{}` when there are none), flush;
 *  - POST …/git-receive-pack: commands `<old> <new> <ref>` (capabilities on the first), flush,
 *    push options and a flush when negotiated, then the pack (absent when every command is a
 *    delete). The answer is report-status (`unpack ok|<error>`, `ok <ref>` / `ng <ref> <reason>`),
 *    in side-band-64k when asked.
 *
 * The pack streams into X6b's install (thin packs completed from the store; the request body is
 * never held whole). Then git's connectivity check (every object the new tips need is present,
 * walking down to what the refs already reach), the hooks (`preReceive` for the whole push,
 * `update` per ref), and X5's ref transaction: compare-and-set on each old value, one transaction
 * for `atomic`, one per ref otherwise. Objects of a refused push stay in the store (git
 * quarantines and drops them; here they are garbage for X18's gc).
 */
import { checkRefFormat } from "../../10-ref-transactions/src/refname.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { listObjectsWithEdges } from "../../18-pack-export/src/export.js";
import {
  FLUSH,
  PktError,
  PktReader,
  pkt,
  sideband,
  text,
} from "../../21-smart-http/src/pkt-line.js";
import { type UploadPackOptions, uploadPackHandler } from "../../21-smart-http/src/server.js";

export interface PushCommand {
  ref: string;
  old: string;
  new: string;
}
export interface ReceivePackOptions {
  agent?: string;
  /** request bodies (inflated) above this many bytes are refused. Default 2 GiB. */
  maxRequestBytes?: number;
  /** refuse the whole push: a message, or undefined to accept */
  preReceive?: (commands: PushCommand[], pushOptions: string[]) => Promise<string | undefined>;
  /** refuse one ref: a message, or undefined to accept */
  update?: (command: PushCommand) => Promise<string | undefined>;
}

const ZERO = "0".repeat(40);
const OID = /^[0-9a-f]{40}$/;

class ProtocolError extends Error {}

async function* limited(body: ReadableStream<Uint8Array> | null, max: number) {
  if (!body) return;
  let n = 0;
  for await (const c of body as unknown as AsyncIterable<Uint8Array>) {
    n += c.length;
    if (n > max) throw new ProtocolError(`request over ${max} bytes`);
    yield c;
  }
}

/** git's connectivity check: everything `tip` needs is here, down to what `known` already reaches. */
async function connected(repo: Repository, tip: string, known: string[]): Promise<boolean> {
  try {
    const { objects } = await listObjectsWithEdges(repo, [tip], known);
    for (const o of objects) if (!(await repo.objects.has(o.oid))) return false;
    return true;
  } catch {
    return false;
  }
}

export function receivePackHandler(
  repo: Repository,
  opts: ReceivePackOptions = {},
): (req: Request) => Promise<Response> {
  const agent = opts.agent ?? "webrun-vcs/0.0";
  const maxRequest = opts.maxRequestBytes ?? 2 * 2 ** 30;
  const caps = `report-status delete-refs side-band-64k quiet atomic ofs-delta push-options object-format=sha1 agent=${agent}`;
  return async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname.endsWith("/info/refs")) {
      if (url.searchParams.get("service") !== "git-receive-pack")
        return new Response("not found\n", { status: 404 });
      const lines: Uint8Array[] = [pkt("# service=git-receive-pack\n"), FLUSH];
      let first = true;
      for await (const r of repo.refs.list("refs/")) {
        lines.push(pkt(first ? `${r.oid} ${r.name}\0${caps}\n` : `${r.oid} ${r.name}\n`));
        first = false;
      }
      if (first) lines.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
      lines.push(FLUSH);
      return new Response(new Blob(lines as BlobPart[]), {
        headers: {
          "content-type": "application/x-git-receive-pack-advertisement",
          "cache-control": "no-cache",
        },
      });
    }
    if (req.method !== "POST" || !url.pathname.endsWith("/git-receive-pack"))
      return new Response("not found\n", { status: 404 });

    const encoding = (req.headers.get("content-encoding") ?? "").toLowerCase();
    if (encoding && encoding !== "gzip" && encoding !== "identity")
      return new Response(`unsupported content-encoding ${encoding}\n`, { status: 415 });
    const body =
      encoding === "gzip" && req.body
        ? req.body.pipeThrough(new DecompressionStream("gzip") as never)
        : req.body;
    const reader = new PktReader(limited(body as ReadableStream<Uint8Array> | null, maxRequest));

    // --- commands, capabilities, push options
    const commands: PushCommand[] = [];
    const requested = new Set<string>();
    const pushOptions: string[] = [];
    try {
      for (;;) {
        const p = await reader.read();
        if (!p) throw new ProtocolError("request ends before the commands' flush");
        if (p.kind === "flush") break;
        if (p.kind !== "data") throw new ProtocolError(`unexpected ${p.kind} packet`);
        let line = text(p) as string;
        if (!commands.length) {
          const nul = line.indexOf("\0");
          if (nul >= 0) {
            for (const c of line.slice(nul + 1).split(" "))
              if (c) requested.add(c.split("=")[0] as string);
            line = line.slice(0, nul);
          }
        }
        const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
        if (!m) throw new ProtocolError(`protocol error: expected old/new/ref, got '${line}'`);
        commands.push({ old: m[1] as string, new: m[2] as string, ref: m[3] as string });
      }
      if (requested.has("push-options"))
        for (;;) {
          const p = await reader.read();
          if (!p || p.kind === "flush") break;
          if (p.kind === "data") pushOptions.push(text(p) as string);
        }
    } catch (e) {
      if (e instanceof ProtocolError || e instanceof PktError)
        return new Response(`${e.message}\n`, { status: 400 });
      throw e;
    }
    if (!commands.length) return new Response(new Blob([FLUSH as BlobPart]));

    // --- the pack (unless every command is a delete)
    let unpack = "ok";
    const status = new Map<string, string>(); // ref → "" (ok) or a reason
    const fail = (ref: string, reason: string) => {
      if (!status.has(ref)) status.set(ref, reason);
    };
    if (commands.some((c) => c.new !== ZERO)) {
      try {
        await repo.objects.installPack(reader.rest());
      } catch (e) {
        unpack = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);
        for (const c of commands) fail(c.ref, "unpacker error");
      }
    }

    // --- checks: names, current branch, connectivity, hooks
    const head = await repo.refs.read("HEAD");
    const current = head && "symref" in head ? head.symref : undefined;
    const known: string[] = [];
    for await (const r of repo.refs.list("refs/")) known.push(r.oid);
    for (const c of commands) {
      if (status.has(c.ref)) continue;
      if (!c.ref.startsWith("refs/") || !checkRefFormat(c.ref)) fail(c.ref, "funny refname");
      else if (!OID.test(c.old) || !OID.test(c.new)) fail(c.ref, "invalid id");
      else if (c.new === ZERO && c.ref === current)
        fail(c.ref, "deletion of the current branch prohibited");
      else if (c.new !== ZERO && !(await connected(repo, c.new, known)))
        fail(c.ref, "missing necessary objects");
    }
    if (opts.preReceive && commands.some((c) => !status.has(c.ref))) {
      const msg = await opts.preReceive(
        commands.filter((c) => !status.has(c.ref)),
        pushOptions,
      );
      if (msg) for (const c of commands) fail(c.ref, `pre-receive hook declined: ${msg}`);
    }
    if (opts.update)
      for (const c of commands) {
        if (status.has(c.ref)) continue;
        const msg = await opts.update(c);
        if (msg) fail(c.ref, `hook declined: ${msg}`);
      }

    // --- the ref transaction(s)
    const toCommand = (c: PushCommand) => ({
      name: c.ref,
      old: c.old === ZERO ? null : c.old,
      new: c.new === ZERO ? null : c.new,
    });
    const reasonOf = (r: string | undefined) =>
      r === "mismatch"
        ? "failed to update ref (stale old value)"
        : r === "locked"
          ? "failed to lock"
          : `failed to update ref (${r ?? "rejected"})`;
    if (requested.has("atomic")) {
      if (commands.some((c) => status.has(c.ref))) {
        for (const c of commands) fail(c.ref, "atomic push failure");
      } else {
        const res = await repo.refs.batch(commands.map(toCommand), { message: "push" });
        if (!res.ok)
          for (const c of commands) {
            const own = res.rejected.find((x) => x.name === c.ref);
            fail(c.ref, own ? reasonOf(own.reason) : "atomic push failure");
          }
      }
    } else
      for (const c of commands) {
        if (status.has(c.ref)) continue;
        const res = await repo.refs.batch([toCommand(c)], { message: "push" });
        if (!res.ok) fail(c.ref, reasonOf(res.rejected[0]?.reason));
      }

    // --- report-status
    if (!requested.has("report-status")) return new Response(new Blob([]));
    const report: Uint8Array[] = [pkt(`unpack ${unpack}\n`)];
    for (const c of commands) {
      const reason = status.get(c.ref);
      report.push(pkt(reason ? `ng ${c.ref} ${reason}\n` : `ok ${c.ref}\n`));
    }
    report.push(FLUSH);
    const reportBytes = new Uint8Array(await new Blob(report as BlobPart[]).arrayBuffer());
    const out = requested.has("side-band-64k")
      ? [...sideband(1, reportBytes), FLUSH]
      : [reportBytes];
    return new Response(new Blob(out as BlobPart[]), {
      headers: {
        "content-type": "application/x-git-receive-pack-result",
        "cache-control": "no-cache",
      },
    });
  };
}

/** upload-pack (X8a) and receive-pack (X8b) behind one handler. */
export function gitHandler(
  repo: Repository,
  opts: ReceivePackOptions & { upload?: UploadPackOptions } = {},
): (req: Request) => Promise<Response> {
  const upload = uploadPackHandler(repo, opts.upload);
  const receive = receivePackHandler(repo, opts);
  return async (req) => {
    const url = new URL(req.url);
    const isReceive =
      url.pathname.endsWith("/git-receive-pack") ||
      (url.pathname.endsWith("/info/refs") &&
        url.searchParams.get("service") === "git-receive-pack");
    return isReceive ? receive(req) : upload(req);
  };
}
