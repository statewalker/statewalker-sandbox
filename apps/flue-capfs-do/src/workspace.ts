// The owner cell. One Workspace Durable Object per workspace (namespace): it owns the
// store (SqlFs on its own SQLite), the root key and the sessions. Nothing else ever
// touches file data. Two ways in, with identical rules:
//   - open(token)      → a FilteredFiles RpcTarget, passed BY REFERENCE to other cells
//                        (workerd, cellb); the holder never sees the token.
//   - fsCall(token, r) → token-string transport for runtimes where stubs cannot travel
//                        (another node, a celld fleet, a stub lost to hibernation).

import { DurableObject, RpcTarget } from "cloudflare:workers";
import { Biscuit } from "@statewalker/webrun-biscuit";
import {
  Authority,
  FsGate,
  type FsRequest,
  type ModelAction,
  type ModelGrant,
  type ModelUsage,
} from "./authority.ts";
import { bytesToString, stringToBytes } from "./bytes.ts";
import { fsError, normalise } from "./path.ts";
import { SqlFs } from "./sql-fs.ts";

/**
 * The capability. Lives in the owner cell; other cells only hold an RPC stub of it.
 * Private fields are unreachable through the stub; every method is async, so a denial
 * is a rejected promise. attenuate() creates the narrower capability HERE, in the owner.
 */
export class FilteredFiles extends RpcTarget {
  #gate: FsGate;
  #token: string;
  #auth: Authority;
  #store: SqlFs;
  constructor(store: SqlFs, auth: Authority, token: string) {
    super();
    this.#store = store;
    this.#auth = auth;
    this.#token = token;
    this.#gate = new FsGate(store, auth, token);
  }
  call(method: string, path: string, ...args: unknown[]) {
    return this.#gate.call(method, path, ...args);
  }
  readdir(path: string) {
    return this.#gate.readdir(path);
  }
  move(kind: "cp" | "mv", src: string, dst: string, opts?: unknown) {
    return this.#gate.move(kind, src, dst, opts);
  }
  /** The model right and budget (the `agent` task; never given to tools). */
  model(action: ModelAction, metered: boolean, usage?: ModelUsage) {
    return this.#gate.model(action, metered, usage);
  }
  /** Delegation: one more Biscuit block; the new capability can only be narrower. */
  async attenuate(datalog: string): Promise<FilteredFiles> {
    const token = Biscuit.fromBase64(this.#token).attenuate(datalog).toBase64();
    await this.#auth.verify(token);
    return new FilteredFiles(this.#store, this.#auth, token);
  }
  /** Revocation id of this capability's last block: revoking it cuts it and every descendant. */
  async revocationId(): Promise<string> {
    return (await this.#auth.revocationIds(this.#token)).at(-1) as string;
  }
}

export class Workspace extends DurableObject {
  #store: SqlFs;
  #auth: Authority;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.#store = new SqlFs(ctx.storage.sql);
    this.#auth = new Authority(ctx.storage.sql);
  }

  // ---- issuer / admin (called by the gateway after it authenticated the user) ----

  /** Mints the session token and creates the right directories (an admin act, unlike agent writes). */
  async startSession(user: string, rights: string[], mode?: string, model?: ModelGrant) {
    const started = this.#auth.startSession(user, rights, mode, model);
    for (const r of rights) {
      const p = normalise(r);
      if (p !== "/" && !(await this.#store.exists(p)))
        await this.#store.mkdir(p, { recursive: true });
    }
    return started;
  }
  setMode(session: string, mode: string) {
    return this.#auth.setMode(session, mode);
  }
  setModelBudget(session: string, limits: { turns?: number | null; tokens?: number | null }) {
    return this.#auth.setModelBudget(session, limits);
  }
  revoke(session: string, rid?: string) {
    return this.#auth.revoke(session, rid);
  }
  sessionInfo(session: string) {
    return this.#auth.sessionInfo(session);
  }
  /** Seed files without rights checks (admin import): text, or `{ $b64 }` for binary content. */
  async seed(files: Record<string, string | { $b64: string }>) {
    for (const [p, content] of Object.entries(files ?? {})) {
      if (typeof content === "string") await this.#store.writeFile(normalise(p), content);
      else if (content && typeof content === "object" && typeof content.$b64 === "string")
        await this.#store.writeFileBuffer(normalise(p), stringToBytes(content.$b64, "base64"));
      else throw fsError("EINVAL", `seed '${p}': a value is a string or { $b64 }`);
    }
    return Object.keys(files).length;
  }
  /**
   * Every file and its contents, for audits and tests (admin): as text, or with
   * `encoding: "base64"` the stored bytes in base64.
   */
  async dump(encoding?: "base64"): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const walk = async (dir: string) => {
      for (const name of await this.#store.readdir(dir)) {
        const p = dir === "/" ? `/${name}` : `${dir}/${name}`;
        const st = await this.#store.stat(p);
        if (st.isDirectory) await walk(p);
        else if (encoding === "base64")
          out[p] = bytesToString(await this.#store.readFileBuffer(p), "base64");
        else out[p] = await this.#store.readFile(p);
      }
    };
    await walk("/");
    return out;
  }
  stats() {
    return { ...this.#auth.stats };
  }

  // ---- transport 1: capability by reference ----

  async open(token: string): Promise<FilteredFiles> {
    await this.#auth.sessionOf(token); // reject forged tokens before handing anything out
    return new FilteredFiles(this.#store, this.#auth, token);
  }

  // ---- transport 2: token string per request ----

  fsCall(token: string, req: FsRequest): Promise<unknown> {
    return new FsGate(this.#store, this.#auth, token).dispatch(req);
  }
  revocationIds(token: string) {
    return this.#auth.revocationIds(token);
  }
}
