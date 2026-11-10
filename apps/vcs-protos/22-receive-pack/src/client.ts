/**
 * X8b — a smart-HTTP push client (git's send-pack over remote-curl), with global `fetch`:
 * the receive-pack advertisement (v0), commands from refspecs (`[+]src:dst`, `:dst` deletes),
 * git's fast-forward rule checked locally (a non-fast-forward or an unknown remote tip is refused
 * unless forced), then one POST: the commands, push options, and a thin pack against what the
 * remote has (X6e's search over X6c's walk), streamed as it is produced; the report-status
 * answers per ref.
 */
import { readCommit } from "../../17-repository/src/commands.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { listObjectsWithEdges } from "../../18-pack-export/src/export.js";
import { writePackSearching } from "../../20-delta-search/src/export-search.js";
import {
  FLUSH,
  PktError,
  PktReader,
  pkt,
  readSideband,
  text,
} from "../../21-smart-http/src/pkt-line.js";

export interface PushResult {
  ref: string;
  ok: boolean;
  reason?: string;
}
export interface PushOptions {
  refspecs: string[];
  atomic?: boolean;
  pushOptions?: string[];
  fetch?: typeof fetch;
  signal?: AbortSignal;
  agent?: string;
  /** bytes of the request body sent (commands and pack) */
  stats?: { bytes: number };
}

const ZERO = "0".repeat(40);
const OID = /^[0-9a-f]{40}$/;

async function advertisement(url: string, f: typeof fetch, signal?: AbortSignal) {
  const res = await f(`${url}/info/refs?service=git-receive-pack`, { signal });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const r = new PktReader(res.body as unknown as AsyncIterable<Uint8Array>);
  let p = await r.read();
  if (p && text(p) === "# service=git-receive-pack") {
    p = await r.read();
    if (p?.kind !== "flush") throw new PktError("no flush after the service line");
    p = await r.read();
  }
  const refs = new Map<string, string>();
  const caps = new Set<string>();
  let first = true;
  while (p && p.kind !== "flush") {
    let line = text(p) as string;
    if (line.startsWith("ERR ")) throw new Error(`remote: ${line.slice(4)}`);
    if (first) {
      const nul = line.indexOf("\0");
      if (nul >= 0) {
        for (const c of line.slice(nul + 1).split(" ")) if (c) caps.add(c);
        line = line.slice(0, nul);
      }
      first = false;
    }
    const [oid, name] = line.split(" ");
    if (oid && name && OID.test(oid) && name !== "capabilities^{}") refs.set(name, oid);
    p = await r.read();
  }
  return { refs, caps };
}

async function isAncestor(repo: Repository, a: string, b: string): Promise<boolean> {
  const seen = new Set<string>();
  const stack = [b];
  while (stack.length && seen.size < 100_000) {
    const x = stack.pop() as string;
    if (x === a) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    const c = await readCommit(repo, x).catch(() => undefined);
    if (c) stack.push(...c.parents);
  }
  return false;
}

/** Resolves a local refspec source: a ref name (as git: HEAD, a branch, a tag) or an id. */
async function resolveLocal(repo: Repository, src: string): Promise<string | undefined> {
  if (OID.test(src)) return src;
  for (const name of [src, `refs/heads/${src}`, `refs/tags/${src}`]) {
    const oid = await repo.refs.resolve(name);
    if (oid) return oid;
  }
  return undefined;
}

export async function push(
  url: string,
  repo: Repository,
  opts: PushOptions,
): Promise<PushResult[]> {
  const f = opts.fetch ?? fetch;
  const base = url.replace(/\/+$/, "");
  const { refs: remote, caps } = await advertisement(base, f, opts.signal);
  if (opts.atomic && !caps.has("atomic"))
    throw new Error("the server does not support atomic pushes");
  if (opts.pushOptions?.length && !caps.has("push-options"))
    throw new Error("the server does not support push options");

  // --- commands
  const results: PushResult[] = [];
  const commands: { ref: string; old: string; new: string }[] = [];
  for (const spec of opts.refspecs) {
    const force = spec.startsWith("+");
    const body = force ? spec.slice(1) : spec;
    const i = body.indexOf(":");
    const src = i < 0 ? body : body.slice(0, i);
    let dst = i < 0 ? body : body.slice(i + 1);
    if (!dst.startsWith("refs/")) dst = `refs/heads/${dst}`;
    const old = remote.get(dst) ?? ZERO;
    if (!src) {
      if (old === ZERO) results.push({ ref: dst, ok: false, reason: "remote ref does not exist" });
      else commands.push({ ref: dst, old, new: ZERO });
      continue;
    }
    const neu = await resolveLocal(repo, src);
    if (!neu) throw new Error(`src refspec ${src} does not match any local ref`);
    if (old === neu) {
      results.push({ ref: dst, ok: true, reason: "up to date" });
      continue;
    }
    if (old !== ZERO && !force && dst.startsWith("refs/heads/")) {
      // git's rule: the remote tip must be known here and an ancestor of what is pushed
      if (!(await repo.objects.has(old))) {
        results.push({ ref: dst, ok: false, reason: "rejected (fetch first)" });
        continue;
      }
      if (!(await isAncestor(repo, old, neu))) {
        results.push({ ref: dst, ok: false, reason: "rejected (non-fast-forward)" });
        continue;
      }
    }
    if (old !== ZERO && !force && dst.startsWith("refs/tags/")) {
      results.push({ ref: dst, ok: false, reason: "rejected (already exists)" });
      continue;
    }
    commands.push({ ref: dst, old, new: neu });
  }
  if (opts.atomic && results.some((r) => !r.ok)) {
    // git: an atomic push refused locally sends nothing
    return [
      ...results,
      ...commands.map((c) => ({ ref: c.ref, ok: false, reason: "atomic push failure" })),
    ];
  }
  if (!commands.length) return results;

  // --- the request: commands, options, a thin pack (none when every command is a delete)
  const want = [
    "report-status",
    "side-band-64k",
    "ofs-delta",
    `agent=${opts.agent ?? "webrun-vcs/0.0"}`,
  ];
  if (caps.has("object-format=sha1")) want.push("object-format=sha1");
  if (opts.atomic) want.push("atomic");
  if (opts.pushOptions?.length) want.push("push-options");
  if (caps.has("quiet")) want.push("quiet");
  const head: Uint8Array[] = commands.map((c, i) =>
    pkt(
      i === 0 ? `${c.old} ${c.new} ${c.ref}\0${want.join(" ")}\n` : `${c.old} ${c.new} ${c.ref}\n`,
    ),
  );
  head.push(FLUSH);
  if (opts.pushOptions?.length) {
    for (const o of opts.pushOptions) head.push(pkt(`${o}\n`));
    head.push(FLUSH);
  }
  const tips = commands.filter((c) => c.new !== ZERO).map((c) => c.new);
  const haves: string[] = [];
  for (const oid of new Set(remote.values())) if (await repo.objects.has(oid)) haves.push(oid);
  const stats = opts.stats;
  const signal = opts.signal;
  async function* bodyChunks() {
    for (const h of head) yield h;
    if (!tips.length) return;
    const { objects, edges, receiverHas } = await listObjectsWithEdges(repo, tips, haves, {
      signal,
    });
    yield* writePackSearching(repo, objects, {
      signal,
      thin: true,
      edges,
      receiverHas: (o) => receiverHas.has(o),
    });
  }
  const it = bodyChunks();
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const r = await it.next();
      if (r.done) ctrl.close();
      else {
        if (stats) stats.bytes += r.value.length;
        ctrl.enqueue(r.value);
      }
    },
    async cancel() {
      await it.return?.(undefined);
    },
  });
  const res = await f(`${base}/git-receive-pack`, {
    method: "POST",
    headers: {
      "content-type": "application/x-git-receive-pack-request",
      accept: "application/x-git-receive-pack-result",
    },
    body: stream,
    signal,
    // @ts-expect-error a streamed request body needs duplex: "half" (fetch standard)
    duplex: "half",
  });
  if (!res.ok) throw new Error(`${base}: HTTP ${res.status} ${await res.text()}`);

  // --- report-status (in side-band)
  const outer = new PktReader(res.body as unknown as AsyncIterable<Uint8Array>);
  const inner = new PktReader(readSideband(outer, () => {}));
  const first = await inner.read();
  const unpack = first ? text(first) : undefined;
  if (!unpack?.startsWith("unpack ")) throw new PktError(`unexpected report: ${unpack}`);
  if (unpack !== "unpack ok") throw new Error(`remote: ${unpack}`);
  const reported = new Map<string, PushResult>();
  for (;;) {
    const p = await inner.read();
    if (!p || p.kind === "flush") break;
    const line = text(p) as string;
    const ok = /^ok (.+)$/.exec(line);
    const ng = /^ng (\S+) (.*)$/.exec(line);
    if (ok) reported.set(ok[1] as string, { ref: ok[1] as string, ok: true });
    else if (ng) reported.set(ng[1] as string, { ref: ng[1] as string, ok: false, reason: ng[2] });
  }
  for (const c of commands)
    results.push(
      reported.get(c.ref) ?? { ref: c.ref, ok: false, reason: "no report from the server" },
    );
  return results;
}
