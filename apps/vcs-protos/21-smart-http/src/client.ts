/**
 * X8a — a smart-HTTP fetch client, protocol v2 (git's fetch-pack over remote-curl), with global
 * `fetch`: discover the capabilities, `ls-refs`, then stateless negotiation and the pack streamed
 * straight into the repository's installPack (X6b: thin packs completed from the store).
 *
 * Negotiation is git's default ("consecutive") negotiator: local tips walked newest first; a have
 * the server ACKs marks its ancestors common (they are not sent); haves go in rounds of 16,
 * doubling (git's next_flush for stateless RPC, ×1.1 past 16384); every round re-sends the
 * commons. The client says "done" when it runs out of haves, or — once an ACK was seen — after
 * 256 haves in vain (git's MAX_IN_VAIN); the server's "ready" ends it sooner.
 */
import type { FilesApi } from "@statewalker/webrun-files";
import { readCommit } from "../../17-repository/src/commands.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { DELIM, FLUSH, PktError, PktReader, pkt, readSideband, text } from "./pkt-line.js";

export interface FetchStats {
  haves: number;
  rounds: number;
  objects: number;
}
export interface ShallowStore {
  read(): Promise<string[]>;
  write(oids: string[]): Promise<void>;
}
export interface FetchOptions {
  /** git refspecs: `[+]src:dst`, `*` once on each side. Default: heads to refs/remotes/origin. */
  refspecs?: string[];
  depth?: number;
  shallow?: ShallowStore;
  stats?: FetchStats;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  agent?: string;
  onProgress?: (message: string) => void;
  /** git's tag auto-follow: remote tags whose objects are now here are created. Default true. */
  followTags?: boolean;
}

const OID = /^[0-9a-f]{40}$/;
const INITIAL_FLUSH = 16;
const LARGE_FLUSH = 16384;
const MAX_IN_VAIN = 256;

/** git's shallow file (one id per line) on a FilesApi. */
export function filesShallow(files: FilesApi, path: string): ShallowStore {
  return {
    async read() {
      if (!(await files.exists(path))) return [];
      const parts: Uint8Array[] = [];
      for await (const c of files.read(path)) parts.push(c);
      const s = new TextDecoder().decode(
        new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer()),
      );
      return s.split("\n").filter((l) => OID.test(l));
    },
    async write(oids) {
      const unique = [...new Set(oids)].sort();
      if (!unique.length) {
        if (await files.exists(path)) await files.remove(path);
        return;
      }
      const tmp = `${path}.lock`;
      await files.write(tmp, [new TextEncoder().encode(`${unique.join("\n")}\n`)]);
      await files.move(tmp, path);
    },
  };
}

interface RemoteRef {
  name: string;
  oid: string;
  symref?: string;
  peeled?: string;
}
interface Refspec {
  force: boolean;
  src: string;
  dst: string;
}

function parseRefspec(s: string): Refspec {
  const force = s.startsWith("+");
  const body = force ? s.slice(1) : s;
  const i = body.indexOf(":");
  const src = i < 0 ? body : body.slice(0, i);
  const dst = i < 0 ? "" : body.slice(i + 1);
  if ((src.match(/\*/g) ?? []).length > 1 || src.includes("*") !== dst.includes("*"))
    throw new Error(`unsupported refspec ${s}`);
  return { force, src, dst };
}
const matchRefspec = (r: Refspec, name: string): string | undefined => {
  if (!r.src.includes("*")) return name === r.src ? r.dst : undefined;
  const [pre, post] = r.src.split("*") as [string, string];
  if (!name.startsWith(pre) || !name.endsWith(post) || name.length < pre.length + post.length)
    return undefined;
  return r.dst.replace("*", name.slice(pre.length, name.length - post.length));
};
const prefixOf = (r: Refspec) => (r.src.includes("*") ? r.src.slice(0, r.src.indexOf("*")) : r.src);

class Remote {
  constructor(
    readonly url: string,
    readonly f: typeof fetch,
    readonly agent: string,
    readonly signal?: AbortSignal,
  ) {}
  caps = new Map<string, string>();
  async discover() {
    const res = await this.f(`${this.url}/info/refs?service=git-upload-pack`, {
      headers: { "git-protocol": "version=2" },
      signal: this.signal,
    });
    if (!res.ok) throw new Error(`${this.url}: HTTP ${res.status}`);
    const r = new PktReader(res.body as unknown as AsyncIterable<Uint8Array>);
    let p = await r.read();
    if (p && text(p)?.startsWith("# service=")) {
      p = await r.read(); // its flush
      if (p?.kind !== "flush") throw new PktError("no flush after the service line");
      p = await r.read();
    }
    if (!p || text(p) !== "version 2") throw new Error(`${this.url} does not speak protocol v2`);
    for (;;) {
      const q = await r.read();
      if (!q || q.kind === "flush") break;
      const line = text(q) as string;
      const i = line.indexOf("=");
      this.caps.set(i < 0 ? line : line.slice(0, i), i < 0 ? "" : line.slice(i + 1));
    }
    if (!this.caps.has("fetch")) throw new Error("the server does not offer fetch");
  }
  async command(command: string, args: string[]): Promise<PktReader> {
    const body = [
      pkt(`command=${command}\n`),
      pkt(`agent=${this.agent}\n`),
      ...(this.caps.has("object-format") ? [pkt("object-format=sha1\n")] : []),
      DELIM,
      ...args.map((a) => pkt(`${a}\n`)),
      FLUSH,
    ];
    const res = await this.f(`${this.url}/git-upload-pack`, {
      method: "POST",
      headers: {
        "content-type": "application/x-git-upload-pack-request",
        accept: "application/x-git-upload-pack-result",
        "git-protocol": "version=2",
      },
      body: new Blob(body as BlobPart[]),
      signal: this.signal,
    });
    if (!res.ok) throw new Error(`${this.url}: HTTP ${res.status}`);
    return new PktReader(res.body as unknown as AsyncIterable<Uint8Array>);
  }
  async lsRefs(prefixes: string[]): Promise<RemoteRef[]> {
    const r = await this.command("ls-refs", [
      "symrefs",
      "peel",
      ...prefixes.map((p) => `ref-prefix ${p}`),
    ]);
    const refs: RemoteRef[] = [];
    for (;;) {
      const p = await r.read();
      if (!p || p.kind === "flush") break;
      const line = text(p) as string;
      if (line.startsWith("ERR ")) throw new Error(`remote: ${line.slice(4)}`);
      const [oid, name, ...attrs] = line.split(" ");
      if (!oid || !name || !OID.test(oid)) continue; // "unborn HEAD": nothing to fetch
      const ref: RemoteRef = { name, oid };
      for (const a of attrs) {
        if (a.startsWith("symref-target:")) ref.symref = a.slice(14);
        else if (a.startsWith("peeled:")) ref.peeled = a.slice(7);
      }
      refs.push(ref);
    }
    return refs;
  }
}

/** git's default negotiator over the local history. */
class Negotiator {
  private queue: { oid: string; when: number }[] = [];
  private seen = new Set<string>();
  private common = new Set<string>();
  readonly commonSent = new Set<string>();
  constructor(private repo: Repository) {}
  async push(oid: string) {
    if (this.seen.has(oid)) return;
    this.seen.add(oid);
    let when: number;
    try {
      when = (await readCommit(this.repo, oid)).committer.when;
    } catch {
      return; // not a commit, or below a shallow boundary
    }
    let i = this.queue.length;
    while (i > 0 && (this.queue[i - 1] as { when: number }).when < when) i--;
    this.queue.splice(i, 0, { oid, when });
  }
  /** The next have to send, or undefined when the local history is exhausted. */
  async next(): Promise<string | undefined> {
    for (;;) {
      const c = this.queue.shift();
      if (!c) return undefined;
      const commit = await readCommit(this.repo, c.oid).catch(() => undefined);
      if (commit)
        for (const p of commit.parents) if (await this.repo.objects.has(p)) await this.push(p);
      if (!this.common.has(c.oid)) return c.oid;
    }
  }
  /** An ACKed have: it and its ancestors are common (not sent again). */
  async ack(oid: string): Promise<boolean> {
    if (this.commonSent.has(oid)) return false;
    this.commonSent.add(oid);
    const stack = [oid];
    while (stack.length) {
      const x = stack.pop() as string;
      if (this.common.has(x)) continue;
      this.common.add(x);
      const c = await readCommit(this.repo, x).catch(() => undefined);
      if (c) for (const p of c.parents) if (this.seen.has(p)) stack.push(p);
    }
    return true;
  }
}

const nextFlush = (n: number) => (n < LARGE_FLUSH ? n * 2 : Math.floor((n * 11) / 10));

export async function fetchFrom(url: string, repo: Repository, opts: FetchOptions = {}) {
  const f = opts.fetch ?? fetch;
  const remote = new Remote(
    url.replace(/\/+$/, ""),
    f,
    opts.agent ?? "webrun-vcs/0.0",
    opts.signal,
  );
  await remote.discover();
  if (opts.depth && !(remote.caps.get("fetch") ?? "").split(" ").includes("shallow"))
    throw new Error("the server does not support shallow fetches");
  const specs = (opts.refspecs ?? ["+refs/heads/*:refs/remotes/origin/*"]).map(parseRefspec);
  const followTags = opts.followTags ?? true;
  const remoteRefs = await remote.lsRefs([
    "HEAD",
    ...specs.map(prefixOf),
    ...(followTags ? ["refs/tags/"] : []),
  ]);
  const updates: { name: string; oid: string; force: boolean }[] = [];
  for (const r of remoteRefs)
    for (const s of specs) {
      const dst = matchRefspec(s, r.name);
      if (dst) updates.push({ name: dst, oid: r.oid, force: s.force });
    }
  const stats = opts.stats;
  const wants = [...new Set(updates.map((u) => u.oid))];
  const missing: string[] = [];
  for (const w of wants) if (!(await repo.objects.has(w))) missing.push(w);
  const shallowBefore = (await opts.shallow?.read()) ?? [];
  let shallowAfter = shallowBefore;
  if (missing.length) {
    const neg = new Negotiator(repo);
    for await (const r of repo.refs.list("refs/")) await neg.push(r.oid);
    const head = await repo.refs.resolve("HEAD");
    if (head) await neg.push(head);
    const fixed = [
      ...missing.map((w) => `want ${w}`),
      ...shallowBefore.map((s) => `shallow ${s}`),
      ...(opts.depth ? [`deepen ${opts.depth}`] : []),
      "thin-pack",
      "ofs-delta",
      "include-tag",
      ...(opts.onProgress ? [] : ["no-progress"]),
    ];
    let flush = INITIAL_FLUSH;
    let inVain = 0;
    let seenAck = false;
    const sent: string[] = [];
    for (;;) {
      opts.signal?.throwIfAborted();
      const batch: string[] = [];
      let exhausted = false;
      while (batch.length < flush) {
        const h = await neg.next();
        if (!h) {
          exhausted = true;
          break;
        }
        batch.push(h);
      }
      sent.push(...batch);
      inVain += batch.length;
      if (stats) {
        stats.haves += batch.length;
        stats.rounds++;
      }
      const done = exhausted || (seenAck && inVain >= MAX_IN_VAIN);
      const args = [
        ...fixed,
        ...[...neg.commonSent].map((c) => `have ${c}`),
        ...batch.map((h) => `have ${h}`),
        ...(done ? ["done"] : []),
      ];
      const r = await remote.command("fetch", args);
      const result = await readFetchResponse(r, neg, done);
      if (result.newAcks) {
        seenAck = true;
        inVain = 0;
      }
      if (result.packReader) {
        if (result.shallow)
          shallowAfter = [...shallowBefore, ...result.shallow.shallow].filter(
            (s) => !result.shallow?.unshallow.includes(s),
          );
        const progress = opts.onProgress ?? (() => {});
        const received = { count: 0 };
        await repo.objects.installPack(
          countObjects(readSideband(result.packReader, progress), received),
        );
        if (stats) stats.objects += received.count;
        break;
      }
      flush = nextFlush(flush);
    }
    if (opts.shallow && shallowAfter !== shallowBefore) await opts.shallow.write(shallowAfter);
  }
  // auto-follow: tags (annotated: with their object here) pointing at what we now have
  if (followTags)
    for (const r of remoteRefs) {
      if (!r.name.startsWith("refs/tags/") || updates.some((u) => u.name === r.name)) continue;
      if (!(await repo.objects.has(r.oid)) || !(await repo.objects.has(r.peeled ?? r.oid)))
        continue;
      if (!(await repo.refs.resolve(r.name)))
        updates.push({ name: r.name, oid: r.oid, force: false });
    }
  // refs: forced or fast-forward
  const commands: { name: string; old?: string | null; new: string }[] = [];
  for (const u of updates) {
    const old = await repo.refs.resolve(u.name);
    if (old === u.oid) continue;
    if (old && !u.force && !(await isAncestor(repo, old, u.oid)))
      throw new Error(`${u.name}: ${u.oid} is not a fast-forward of ${old}`);
    commands.push({ name: u.name, old: old ?? null, new: u.oid });
  }
  if (commands.length) {
    const res = await repo.refs.batch(commands, { message: `fetch: ${url}` });
    if (!res.ok) throw new Error(`ref update rejected: ${JSON.stringify(res.rejected)}`);
  }
  const rejected: { name: string; reason: string }[] = [];
  return {
    refs: remoteRefs,
    updated: commands.map((c) => c.name),
    rejected,
    shallow: shallowAfter,
  };
}

async function readFetchResponse(r: PktReader, neg: Negotiator, done: boolean) {
  let newAcks = false;
  let shallow: { shallow: string[]; unshallow: string[] } | undefined;
  let section: string | undefined;
  for (;;) {
    const p = await r.read();
    if (!p) throw new PktError("fetch response ends early");
    if (p.kind === "flush") return { newAcks, shallow, packReader: undefined };
    if (p.kind === "delim") {
      section = undefined;
      continue;
    }
    if (p.kind !== "data") throw new PktError(`unexpected ${p.kind}`);
    const line = text(p) as string;
    if (line.startsWith("ERR ")) throw new Error(`remote: ${line.slice(4)}`);
    if (!section) {
      section = line;
      if (section === "packfile") return { newAcks, shallow, packReader: r };
      if (section === "acknowledgments" && done) throw new PktError("acknowledgments after done");
      continue;
    }
    if (section === "acknowledgments") {
      if (line.startsWith("ACK ")) {
        if (await neg.ack(line.slice(4))) newAcks = true;
      } else if (line !== "NAK" && line !== "ready") throw new PktError(`unexpected ${line}`);
    } else if (section === "shallow-info") {
      shallow ??= { shallow: [], unshallow: [] };
      if (line.startsWith("shallow ")) shallow.shallow.push(line.slice(8));
      else if (line.startsWith("unshallow ")) shallow.unshallow.push(line.slice(10));
    }
    // wanted-refs, packfile-uris: not requested
  }
}

/** Passes a pack through, reading its header's object count (what was received, before thin completion). */
async function* countObjects(pack: AsyncIterable<Uint8Array>, out: { count: number }) {
  const head: number[] = [];
  for await (const c of pack) {
    for (let i = 0; i < c.length && head.length < 12; i++) head.push(c[i] as number);
    if (head.length === 12 && !out.count)
      out.count =
        ((head[8] as number) << 24) |
        ((head[9] as number) << 16) |
        ((head[10] as number) << 8) |
        (head[11] as number);
    yield c;
  }
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

/** A clone: every branch and tag as the remote has them, HEAD as the remote's. */
export async function clone(url: string, repo: Repository, opts: FetchOptions = {}) {
  let refspecs = opts.refspecs ?? ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"];
  if (opts.depth && !opts.refspecs) {
    // git: --depth implies --single-branch (the remote HEAD's branch; tags by auto-follow)
    const remote = new Remote(
      url.replace(/\/+$/, ""),
      opts.fetch ?? fetch,
      opts.agent ?? "webrun-vcs/0.0",
      opts.signal,
    );
    await remote.discover();
    const head = (await remote.lsRefs(["HEAD"])).find((x) => x.name === "HEAD");
    if (head?.symref) refspecs = [`+${head.symref}:${head.symref}`];
  }
  const r = await fetchFrom(url, repo, { ...opts, refspecs });
  const head = r.refs.find((x) => x.name === "HEAD");
  if (head?.symref) await repo.refs.setSymref("HEAD", head.symref);
  return r;
}
