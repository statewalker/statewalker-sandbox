// The holder side: what an agent, sub-agent or tool cell holds. Two transports behind one
// interface, so just-bash and Flue never know which one is in use.
//   StubCap  — an RPC stub of the owner's FilteredFiles (passed by reference)
//   TokenCap — the Biscuit token string + the workspace name; calls Workspace.fsCall
// attenuate() on a StubCap is an RPC (the owner creates the narrower capability);
// on a TokenCap it is local and offline (appending a Biscuit block needs no key).

import { RpcTarget } from "cloudflare:workers";
import { Biscuit } from "@statewalker/webrun-biscuit";
import type { FsRequest, ModelAction, ModelUsage } from "./authority.ts";
import { rebuildError } from "./path.ts";
import type { FilteredFiles, Workspace } from "./workspace.ts";

export interface Cap {
  call(method: string, path: string, ...args: unknown[]): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  move(kind: "cp" | "mv", src: string, dst: string, opts?: unknown): Promise<void>;
  /** A files-RPC call (webrun-files-rpc); `capFiles(cap)` is the FilesApi over it. */
  rpc(method: string, args: unknown[]): Promise<unknown>;
  attenuate(datalog: string): Promise<Cap>;
  revocationId(): Promise<string>;
  /** The model right and budget, decided in the owner cell (the `agent` task only). */
  model(action: ModelAction, metered: boolean, usage?: ModelUsage): Promise<unknown>;
  /** What to send to the next cell (a stub, or the token string). */
  handoff(): CapHandoff;
}

export type CapHandoff =
  | { transport: "stub"; files: FilteredFiles }
  | { transport: "token"; workspace: string; token: string };

export interface WorkspaceEnv {
  WORKSPACE: DurableObjectNamespace<Workspace>;
}

const wrap = <T>(p: Promise<T>): Promise<T> =>
  p.catch((e) => {
    throw rebuildError(e);
  });

export class StubCap implements Cap {
  #stub: FilteredFiles;
  constructor(stub: FilteredFiles) {
    this.#stub = stub;
  }
  call(method: string, path: string, ...args: unknown[]) {
    return wrap(Promise.resolve(this.#stub.call(method, path, ...args)));
  }
  readdir(path: string) {
    return wrap(Promise.resolve(this.#stub.readdir(path)));
  }
  move(kind: "cp" | "mv", src: string, dst: string, opts?: unknown) {
    return wrap(Promise.resolve(this.#stub.move(kind, src, dst, opts)));
  }
  rpc(method: string, args: unknown[]) {
    return wrap(Promise.resolve(this.#stub.rpc(method, args)));
  }
  async attenuate(datalog: string): Promise<Cap> {
    return new StubCap(
      (await wrap(Promise.resolve(this.#stub.attenuate(datalog)))) as unknown as FilteredFiles,
    );
  }
  revocationId() {
    return wrap(Promise.resolve(this.#stub.revocationId()));
  }
  model(action: ModelAction, metered: boolean, usage?: ModelUsage) {
    return wrap(Promise.resolve(this.#stub.model(action, metered, usage)));
  }
  handoff(): CapHandoff {
    return { transport: "stub", files: this.#stub };
  }
}

export class TokenCap implements Cap {
  #env: WorkspaceEnv;
  #workspace: string;
  #token: string;
  constructor(env: WorkspaceEnv, workspace: string, token: string) {
    this.#env = env;
    this.#workspace = workspace;
    this.#token = token;
  }
  #ws() {
    return this.#env.WORKSPACE.get(this.#env.WORKSPACE.idFromName(this.#workspace));
  }
  #send(req: FsRequest) {
    return wrap(Promise.resolve(this.#ws().fsCall(this.#token, req)));
  }
  call(method: string, path: string, ...args: unknown[]) {
    return this.#send({ op: "call", method, path, args });
  }
  readdir(path: string) {
    return this.#send({ op: "readdir", path }) as Promise<string[]>;
  }
  move(kind: "cp" | "mv", src: string, dst: string, opts?: unknown) {
    return this.#send({ op: "move", kind, path: src, dst, opts }) as Promise<void>;
  }
  rpc(method: string, args: unknown[]) {
    return this.#send({ op: "rpc", method, args });
  }
  async attenuate(datalog: string): Promise<Cap> {
    return new TokenCap(
      this.#env,
      this.#workspace,
      Biscuit.fromBase64(this.#token).attenuate(datalog).toBase64(),
    );
  }
  model(action: ModelAction, metered: boolean, usage?: ModelUsage) {
    return this.#send({ op: "model", action, metered, usage });
  }
  async revocationId() {
    return ((await wrap(Promise.resolve(this.#ws().revocationIds(this.#token)))) as string[]).at(
      -1,
    ) as string;
  }
  handoff(): CapHandoff {
    return { transport: "token", workspace: this.#workspace, token: this.#token };
  }
}

export function capFromHandoff(env: WorkspaceEnv, h: CapHandoff): Cap {
  if (h?.transport === "stub") return new StubCap(h.files);
  if (h?.transport === "token") return new TokenCap(env, h.workspace, h.token);
  throw new Error("EINVAL: unknown capability transport");
}

/**
 * What a sandboxed tool isolate receives: an RpcTarget exposing ONLY the file methods.
 * No token, no attenuation, no handoff — the tool can use the capability, not pass it on.
 */
export class ToolFiles extends RpcTarget {
  #cap: Cap;
  constructor(cap: Cap) {
    super();
    this.#cap = cap;
  }
  call(method: string, path: string, ...args: unknown[]) {
    return this.#cap.call(method, path, ...args);
  }
  readdir(path: string) {
    return this.#cap.readdir(path);
  }
  move(kind: "cp" | "mv", src: string, dst: string, opts?: unknown) {
    return this.#cap.move(kind, src, dst, opts);
  }
  rpc(method: string, args: unknown[]) {
    return this.#cap.rpc(method, args);
  }
}
