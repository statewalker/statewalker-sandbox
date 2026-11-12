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
  /**
   * Decides on the commands before any pack byte is read: a message refuses that command. A push
   * whose every command needing a pack is refused is answered without reading (storing) its pack.
   */
  authorize?: (commands: PushCommand[]) => Promise<(string | undefined)[]>;
  /** refuse one ref: a message, or undefined to accept */
  update?: (command: PushCommand) => Promise<string | undefined>;
  /**
   * git's post-receive: the commands whose refs moved, once the report is written (whether or not
   * anyone reads it). It cannot change the outcome; what it throws is ignored.
   */
  postReceive?: (updated: PushCommand[]) => void | Promise<void>;
  /** more commands in one push are refused (400). Default 65536. */
  maxCommands?: number;
  /** a request body silent this long is abandoned (a stalled upload). Default 60 s. */
  idleTimeoutMs?: number;
}

const ZERO = "0".repeat(40);
const OID = /^[0-9a-f]{40}$/;

class ProtocolError extends Error {}

/** The body, bounded in size and in silence (a stalled upload is abandoned). */
async function* limited(body: ReadableStream<Uint8Array> | null, max: number, idleMs: number) {
  if (!body) return;
  const reader = body.getReader();
  let n = 0;
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ProtocolError(`request idle for ${idleMs} ms`)),
          idleMs,
        );
      });
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(timer);
      }
      if (r.done) return;
      n += r.value.length;
      if (n > max) throw new ProtocolError(`request over ${max} bytes`);
      yield r.value;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * git's connectivity check (one `rev-list --objects <tips> --not --all` for the push): everything
 * the tips need is here, down to what the refs already reach. Undefined: connected; otherwise the
 * walk's error (a missing object).
 */
async function connected(repo: Repository, tips: string[], known: string[]): Promise<boolean> {
  try {
    const { objects } = await listObjectsWithEdges(repo, tips, known);
    for (const o of objects) if (!(await repo.objects.has(o.oid))) return false;
    return true;
  } catch {
    return false;
  }
}

/** The object's type, or undefined when absent (its stream closed). */
async function typeOf(repo: Repository, oid: string): Promise<string | undefined> {
  const o = await repo.objects.get(oid);
  await o?.content[Symbol.asyncIterator]().return?.();
  return o?.type;
}

/** One report line per command, never a line break inside (hook messages are free text). */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export function receivePackHandler(
  repo: Repository,
  opts: ReceivePackOptions = {},
): (req: Request) => Promise<Response> {
  const agent = opts.agent ?? "webrun-vcs/0.0";
  const maxRequest = opts.maxRequestBytes ?? 2 * 2 ** 30;
  const maxCommands = opts.maxCommands ?? 65536;
  const idleMs = opts.idleTimeoutMs ?? 60_000;
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
    const reader = new PktReader(
      limited(body as ReadableStream<Uint8Array> | null, maxRequest, idleMs),
    );

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
        // a shallow client's boundary (gitprotocol-pack: *shallow before the commands)
        if (!commands.length && /^shallow [0-9a-f]{40}$/.test(line)) continue;
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
        if (commands.length > maxCommands)
          throw new ProtocolError(`more than ${maxCommands} commands`);
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

    // The head goes out now, the report when the pack is in and the refs are updated: a relay that
    // bounds a call until its response head (httpeers' bridge: 30 s) must not time out a long push.
    const authorized = opts.authorize ? await opts.authorize(commands) : [];
    const updated: PushCommand[] = []; // the refs moved, in command order, for postReceive
    const finish = async (): Promise<Uint8Array> => {
      // --- the pack (unless every command is a delete); a status per command (a ref may appear twice)
      let unpack = "ok";
      const status: (string | undefined)[] = commands.map(() => undefined); // undefined: ok so far
      const fail = (i: number, reason: string) => {
        status[i] ??= oneLine(reason);
      };
      const open = () =>
        commands.flatMap((c, i) => (status[i] === undefined ? [[c, i] as const] : []));
      authorized.forEach((msg, i) => {
        if (msg) fail(i, msg);
      });
      if (commands.some((c) => c.new !== ZERO)) {
        // a push refused for every ref that needs the pack: the pack is not read, nothing stored
        if (!commands.some((c, i) => c.new !== ZERO && status[i] === undefined)) {
          await reader.close().catch(() => {});
        } else
          try {
            await repo.objects.installPack(reader.rest());
          } catch (e) {
            unpack = oneLine(e instanceof Error ? e.message : String(e)).slice(0, 200);
            commands.forEach((_, i) => {
              fail(i, "unpacker error");
            });
          }
      }

      // --- checks: names, ids, current branch, branch tips are commits, connectivity, hooks
      const head = await repo.refs.read("HEAD");
      const current = head && "symref" in head ? head.symref : undefined;
      const known = new Set<string>();
      for await (const r of repo.refs.list("refs/")) known.add(r.oid);
      for (const [c, i] of open()) {
        if (!c.ref.startsWith("refs/") || !checkRefFormat(c.ref)) fail(i, "funny refname");
        else if (!OID.test(c.old) || !OID.test(c.new)) fail(i, "invalid id");
        else if (c.new === ZERO && c.ref === current)
          fail(i, "deletion of the current branch prohibited");
        else if (
          c.new !== ZERO &&
          c.ref.startsWith("refs/heads/") &&
          (await typeOf(repo, c.new)) !== "commit"
        )
          fail(i, "failed to update ref (not a commit: a branch must point at a commit)");
      }
      // one walk for every new tip; only if it fails, one per tip to name the broken ones
      const tips = open().filter(([c]) => c.new !== ZERO);
      if (
        tips.length &&
        !(await connected(repo, [...new Set(tips.map(([c]) => c.new))], [...known]))
      )
        for (const [c, i] of tips)
          if (!(await connected(repo, [c.new], [...known]))) fail(i, "missing necessary objects");
      if (opts.preReceive && open().length) {
        const msg = await opts.preReceive(
          open().map(([c]) => c),
          pushOptions,
        );
        if (msg)
          commands.forEach((_, i) => {
            fail(i, `pre-receive hook declined: ${msg}`);
          });
      }
      if (opts.update)
        for (const [c, i] of open()) {
          const msg = await opts.update(c);
          if (msg) fail(i, `hook declined: ${msg}`);
        }

      // --- the ref transaction(s); deleting a ref that does not exist is a no-op (git: a warning)
      const toCommand = (c: PushCommand) => ({
        name: c.ref,
        old: c.old === ZERO ? null : c.old,
        new: c.new === ZERO ? null : c.new,
      });
      const noop = (c: PushCommand) => c.old === ZERO && c.new === ZERO;
      const reasonOf = (r: string | undefined) =>
        r === "mismatch"
          ? "failed to update ref (stale old value)"
          : r === "locked"
            ? "failed to lock"
            : `failed to update ref (${r ?? "rejected"})`;
      if (requested.has("atomic")) {
        if (status.some((x) => x !== undefined)) {
          commands.forEach((_, i) => {
            fail(i, "atomic push failure");
          });
        } else {
          const todo = commands.filter((c) => !noop(c));
          const res = todo.length
            ? await repo.refs.batch(todo.map(toCommand), { message: "push" })
            : { ok: true, rejected: [] };
          if (!res.ok)
            commands.forEach((c, i) => {
              const own = res.rejected.find((x) => x.name === c.ref);
              fail(i, own ? reasonOf(own.reason) : "atomic push failure");
            });
          else updated.push(...todo);
        }
      } else
        for (const [c, i] of open()) {
          if (noop(c)) continue;
          const res = await repo.refs.batch([toCommand(c)], { message: "push" });
          if (!res.ok) fail(i, reasonOf(res.rejected[0]?.reason));
          else updated.push(c);
        }

      // --- report-status
      if (!requested.has("report-status")) return new Uint8Array(0);
      const report: Uint8Array[] = [pkt(`unpack ${unpack}\n`)];
      commands.forEach((c, i) => {
        const reason = status[i];
        report.push(pkt(reason !== undefined ? `ng ${c.ref} ${reason}\n` : `ok ${c.ref}\n`));
      });
      report.push(FLUSH);
      const reportBytes = new Uint8Array(await new Blob(report as BlobPart[]).arrayBuffer());
      const out = requested.has("side-band-64k")
        ? [...sideband(1, reportBytes), FLUSH]
        : [reportBytes];
      return new Uint8Array(await new Blob(out as BlobPart[]).arrayBuffer());
    };
    // an error after the head cannot change the status: it is answered as a report (unpack
    // internal error, every ref refused) when report-status was asked, else the stream errors
    const internal = async (e: unknown) => {
      if (!requested.has("report-status")) throw e;
      const msg = oneLine(e instanceof Error ? e.message : String(e)).slice(0, 200);
      const report: Uint8Array[] = [pkt(`unpack internal error: ${msg}\n`)];
      for (const c of commands) report.push(pkt(`ng ${c.ref} internal error\n`));
      report.push(FLUSH);
      const bytes = new Uint8Array(await new Blob(report as BlobPart[]).arrayBuffer());
      const out = requested.has("side-band-64k") ? [...sideband(1, bytes), FLUSH] : [bytes];
      return new Uint8Array(await new Blob(out as BlobPart[]).arrayBuffer());
    };
    const result = finish().catch(internal);
    result.catch(() => {}); // observed by the stream below
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(ctrl) {
          try {
            const bytes = await result;
            if (bytes.length) ctrl.enqueue(bytes);
            ctrl.close();
          } catch (e) {
            ctrl.error(e);
          }
          // as git and JGit do: after the report (queued into the response here, not necessarily
          // read yet), for the refs that moved, even after an error.
          // Apart from the stream: a hook that throws must not error a report not yet read.
          const hook = opts.postReceive;
          if (hook && updated.length)
            void (async () => {
              try {
                await hook([...updated]);
              } catch {}
            })();
        },
      }),
      {
        headers: {
          "content-type": "application/x-git-receive-pack-result",
          "cache-control": "no-cache",
        },
      },
    );
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
