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
  /** the remote's messages (side-band 2: hooks, progress) */
  onMessage?: (message: string) => void;
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

/**
 * Resolves a local refspec source as git's ref_rev_parse_rules (an id, a full name, then
 * refs/<name>, refs/tags/<name>, refs/heads/<name>, refs/remotes/<name>); `HEAD` names the branch
 * it points at. Returns the id and the full ref name (undefined for an id).
 */
async function resolveLocal(
  repo: Repository,
  src: string,
): Promise<{ oid: string; name?: string } | undefined> {
  if (OID.test(src)) return { oid: src };
  if (src === "HEAD") {
    const h = await repo.refs.read("HEAD");
    const oid = await repo.refs.resolve("HEAD");
    if (!oid) return undefined;
    return h && "symref" in h ? { oid, name: h.symref } : { oid };
  }
  for (const name of [
    src,
    `refs/${src}`,
    `refs/tags/${src}`,
    `refs/heads/${src}`,
    `refs/remotes/${src}`,
  ]) {
    if (!name.startsWith("refs/")) continue;
    const oid = await repo.refs.resolve(name);
    if (oid) return { oid, name };
  }
  // an expression of a commit (HEAD~1, main^): resolved through the history
  const m = /^(.+?)((?:[~^]\d*)+)$/.exec(src);
  if (m) {
    const base = await resolveLocal(repo, m[1] as string);
    if (!base) return undefined;
    let oid = base.oid;
    for (const op of (m[2] as string).match(/[~^]\d*/g) ?? []) {
      const n = op.length > 1 ? Number(op.slice(1)) : 1;
      for (let k = 0; k < (op[0] === "~" ? n : 1); k++) {
        const c = await readCommit(repo, oid);
        const parent = c.parents[op[0] === "^" ? n - 1 : 0];
        if (!parent) return undefined;
        oid = parent;
      }
    }
    return { oid };
  }
  const tree = /^(.+)\^\{tree\}$/.exec(src);
  if (tree) {
    const base = await resolveLocal(repo, tree[1] as string);
    return base ? { oid: (await readCommit(repo, base.oid)).tree } : undefined;
  }
  return undefined;
}

/**
 * git's destination for a short name: the remote ref it names (refs/heads/x or refs/tags/x, if
 * exactly one exists), else by the source's kind (a tag source makes a tag).
 */
function remoteName(dst: string, remote: Map<string, string>, srcName?: string): string {
  if (dst.startsWith("refs/")) return dst;
  const matches = [`refs/heads/${dst}`, `refs/tags/${dst}`].filter((n) => remote.has(n));
  if (matches.length === 1) return matches[0] as string;
  return srcName?.startsWith("refs/tags/") ? `refs/tags/${dst}` : `refs/heads/${dst}`;
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
    if (!src) {
      // ":dst" deletes the remote ref it names
      const dst = remoteName(body.slice(i + 1), remote);
      const old = remote.get(dst) ?? ZERO;
      if (old === ZERO) results.push({ ref: dst, ok: false, reason: "remote ref does not exist" });
      else commands.push({ ref: dst, old, new: ZERO });
      continue;
    }
    const local = await resolveLocal(repo, src);
    if (!local) throw new Error(`src refspec ${src} does not match any local ref`);
    // no colon: the same name on the remote (git: "HEAD" pushes the current branch)
    const dstSpec = i < 0 ? (local.name ?? src) : body.slice(i + 1);
    const dst = remoteName(dstSpec, remote, local.name);
    const old = remote.get(dst) ?? ZERO;
    const neu = local.oid;
    if (old === neu) {
      results.push({ ref: dst, ok: true, reason: "up to date" });
      continue;
    }
    if (old !== ZERO && !force) {
      // git's set_ref_status_for_push: tags are never replaced without force; any other ref
      // must fast-forward from a remote tip known here, both ends commits
      if (dst.startsWith("refs/tags/")) {
        results.push({ ref: dst, ok: false, reason: "rejected (already exists)" });
        continue;
      }
      if (!(await repo.objects.has(old))) {
        results.push({ ref: dst, ok: false, reason: "rejected (fetch first)" });
        continue;
      }
      const isCommit = async (oid: string) =>
        (await readCommit(repo, oid).catch(() => undefined)) !== undefined;
      if (!(await isCommit(old)) || !(await isCommit(neu))) {
        results.push({ ref: dst, ok: false, reason: "rejected (needs force)" });
        continue;
      }
      if (!(await isAncestor(repo, old, neu))) {
        results.push({ ref: dst, ok: false, reason: "rejected (non-fast-forward)" });
        continue;
      }
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
  // only what the server advertised (gitprotocol-capabilities: a client MUST NOT ask for more)
  const want: string[] = [];
  for (const c of ["report-status", "side-band-64k"]) if (caps.has(c)) want.push(c);
  want.push(`agent=${opts.agent ?? "webrun-vcs/0.0"}`);
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

  // --- report-status (in side-band when negotiated); without report-status git assumes success
  if (!caps.has("report-status")) {
    await res.arrayBuffer();
    for (const c of commands) results.push({ ref: c.ref, ok: true });
    return results;
  }
  const outer = new PktReader(res.body as unknown as AsyncIterable<Uint8Array>);
  const inner = caps.has("side-band-64k")
    ? new PktReader(readSideband(outer, (m) => opts.onMessage?.(m)))
    : outer;
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
