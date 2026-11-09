// The file capability as a loopback service binding, for tool isolates on runtimes that cannot
// pass an RpcTarget into a Worker Loader isolate (celld: "could not be cloned"). The Agent hands
// the tool `ctx.exports.ToolFilesEntrypoint({ props: { workspace, token } })` in its `env`: the
// props stay on this side (the tool cannot read them), and the tool can only call the file
// methods. Every call goes through the Workspace with the token, like TokenCap.

import { WorkerEntrypoint } from "cloudflare:workers";
import { TokenCap, type WorkspaceEnv } from "./caps.ts";

interface Props {
  workspace: string;
  token: string;
}

export class ToolFilesEntrypoint extends WorkerEntrypoint<WorkspaceEnv> {
  #cap() {
    const { workspace, token } = (this.ctx as unknown as { props: Props }).props ?? ({} as Props);
    if (!workspace || !token) throw new Error("EACCES: no file capability bound");
    return new TokenCap(this.env, workspace, token);
  }
  call(method: string, path: string, ...args: unknown[]) {
    return this.#cap().call(method, path, ...args);
  }
  readdir(path: string) {
    return this.#cap().readdir(path);
  }
  move(kind: "cp" | "mv", src: string, dst: string, opts?: unknown) {
    return this.#cap().move(kind, src, dst, opts);
  }
}
