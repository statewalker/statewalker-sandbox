// The file capability as a loopback service binding, for tool isolates on runtimes that cannot
// pass an RpcTarget into a Worker Loader isolate (celld: "could not be cloned"). The Agent hands
// the tool `ctx.exports.ToolFilesEntrypoint({ props: { workspace, token, agent, run } })` in its
// `env`. The props stay on this side (the tool cannot read them), and the tool can only call the
// file methods. Every call goes through the Workspace with the token, like TokenCap.
//
// The binding lives as long as the tool's isolate, not as long as the call: a tool could keep it
// (ctx.waitUntil) and use it after `run` returned. So each call first asks the Agent cell whether
// the run named in the props is still active; the Agent forgets the run when `run` settles. This
// also makes the entrypoint useless to anything else that could bind to it (another Worker of
// the account, with forged props): it would need the nonce of a live run.

import { WorkerEntrypoint } from "cloudflare:workers";
import { TokenCap, type WorkspaceEnv } from "./caps.ts";

interface Props {
  workspace: string;
  token: string;
  agent: string;
  run: string;
}

interface Env extends WorkspaceEnv {
  AGENT: DurableObjectNamespace;
}

const refuse = (): never => {
  throw new Error("EPERM: not available to tools");
};

export class ToolFilesEntrypoint extends WorkerEntrypoint<Env> {
  async #cap() {
    const p = (this.ctx as unknown as { props?: Partial<Props> }).props ?? {};
    if (!p.workspace || !p.token || !p.agent || !p.run)
      throw new Error("EACCES: no file capability bound");
    const agent = this.env.AGENT.get(this.env.AGENT.idFromName(p.agent)) as unknown as {
      toolRunActive(run: string): Promise<boolean>;
    };
    if (!(await agent.toolRunActive(p.run))) throw new Error("EACCES: the tool's run is over");
    return new TokenCap(this.env, p.workspace, p.token);
  }
  async call(method: string, path: string, ...args: unknown[]) {
    return (await this.#cap()).call(method, path, ...args);
  }
  async readdir(path: string) {
    return (await this.#cap()).readdir(path);
  }
  async move(kind: "cp" | "mv", src: string, dst: string, opts?: unknown) {
    return (await this.#cap()).move(kind, src, dst, opts);
  }
  // Some runtimes (cellb 0.5.2) dispatch any function-valued name of the instance, including
  // Object.prototype's: `valueOf()` would hand the tool this instance, with ctx.props. Shadow them.
  valueOf = refuse;
  toString = refuse;
  toLocaleString = refuse;
  hasOwnProperty = refuse;
  isPrototypeOf = refuse;
  propertyIsEnumerable = refuse;
  __defineGetter__ = refuse;
  __defineSetter__ = refuse;
  __lookupGetter__ = refuse;
  __lookupSetter__ = refuse;
}
