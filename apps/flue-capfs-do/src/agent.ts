// The agent cell. One Agent Durable Object per agent instance. It receives a capability
// (a FilteredFiles stub or a token), never a path, a store or a credential, and works on
// files only through it:
//   - "bash": a just-bash shell over CapFs
//   - "flue": Flue's own model-facing tools (read/write/edit/bash/grep/glob) over the same
//             sandbox an agent's `useSandbox(bash(...))` gets, called as a model would
//   - "tool": untrusted tool code in a Worker Loader isolate with no network, holding only
//             the narrowed capability
// Delegation: `chain` lists attenuations; each hop narrows the capability and hands it to
// a NEW sub-agent cell, which can narrow it again.

import { DurableObject } from "cloudflare:workers";
import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
  bash as flueBash,
} from "@flue/runtime";
import { Bash } from "just-bash/browser";
import { type AgentLoopRequest, runAgentLoop } from "./agent-loop.ts";
import { CapFs, safeExec } from "./capfs.ts";
import { type Cap, type CapHandoff, capFromHandoff, ToolFiles, type WorkspaceEnv } from "./caps.ts";
import { rgForFlue } from "./flue-compat.ts";
import { attenuationBlock } from "./policy.ts";
import { engineHost } from "./python/hosts.ts";
import { PythonKernel, type PythonRunRequest } from "./python/kernel.ts";
import { deploymentToolConfig } from "./tools/config.ts";
import { admitTool, toolPolicy } from "./tools/policy.ts";

export type AttenuationSpec = { scope?: string | string[]; readOnly?: boolean; datalog?: string };

export type Task =
  | { kind: "bash"; script: string; cwd?: string }
  | { kind: "flue"; calls: { tool: string; params: Record<string, unknown> }[]; cwd?: string }
  | { kind: "tool"; code: string; input?: unknown; bundled?: boolean }
  | { kind: "revocationId" }
  | ({ kind: "python" } & PythonRunRequest)
  | ({ kind: "agent" } & AgentLoopRequest);

interface WorkerLoader {
  get(
    id: string,
    load: () => Promise<{
      compatibilityDate: string;
      compatibilityFlags?: string[];
      mainModule: string;
      modules: Record<string, string>;
      env?: Record<string, unknown>;
      globalOutbound?: null;
    }>,
  ): { getEntrypoint(): { run(files: unknown, input: unknown): Promise<unknown> } };
}

export interface AgentEnv extends WorkspaceEnv {
  AGENT: DurableObjectNamespace<Agent>;
  LOADER?: WorkerLoader;
  /** "1" allows tool isolates on runtimes whose isolates can reach the host file system (cellb on Node). */
  ALLOW_HOST_FS_TOOLS?: string;
  /** Run-side tool policy: overrides of tool-bundle.config.json, a JSON string or an object. */
  TOOL_BUNDLE?: unknown;
  /** Python engine location (see src/python/hosts.ts). */
  /** The model of the `agent` task (see src/agent-loop.ts) and its key (a secret). */
  LLM?: unknown;
  LLM_API_KEY?: string;
  PYTHON_ENGINE?: string;
  PYODIDE_INDEX?: string;
  PYTHON?: string;
}

export interface RunResult {
  hops: string[];
  result: unknown;
}

const FLUE_TOOLS = {
  read: createReadTool,
  write: createWriteTool,
  edit: createEditTool,
  bash: createBashTool,
  grep: createGrepTool,
  glob: createGlobTool,
} as const;

export class Agent extends DurableObject<AgentEnv> {
  async run(
    name: string,
    handoff: CapHandoff,
    chain: AttenuationSpec[],
    task: Task,
  ): Promise<RunResult> {
    const cap = capFromHandoff(this.env, handoff);
    if (chain.length > 0) {
      const [first, ...rest] = chain as [AttenuationSpec, ...AttenuationSpec[]];
      const narrower = await cap.attenuate(attenuationBlock(first));
      const subName = `${name}/sub`;
      const sub = this.env.AGENT.get(this.env.AGENT.idFromName(subName));
      const r = (await sub.run(subName, narrower.handoff(), rest, task)) as RunResult;
      return { hops: [name, ...r.hops], result: r.result };
    }
    return { hops: [name], result: await this.#execute(name, cap, task) };
  }

  async #execute(name: string, cap: Cap, task: Task): Promise<unknown> {
    switch (task.kind) {
      case "bash": {
        const sh = new Bash({ fs: new CapFs(cap) as never, cwd: task.cwd ?? "/" });
        return safeExec(sh, task.script);
      }
      case "flue":
        return this.#flue(name, cap, task);
      case "tool":
        return this.#tool(name, cap, task.code, task.input, !!task.bundled);
      case "revocationId":
        return cap.revocationId();
      case "python":
        return this.#python().run(cap, task);
      case "agent":
        return runAgentLoop(cap, task, this.env, this.ctx.storage as never, name);
      default:
        throw new Error(`EINVAL: unknown task '${(task as { kind?: string }).kind}'`);
    }
  }

  /** Flue's tools over the capability-backed sandbox — exactly what a Flue agent's model calls. */
  async #flue(name: string, cap: Cap, task: Extract<Task, { kind: "flue" }>) {
    const cwd = task.cwd ?? "/";
    const sandbox = await flueBash(
      () => new Bash({ fs: new CapFs(cap) as never, cwd, customCommands: [rgForFlue] }) as never,
    ).createSandbox({
      id: name,
    });
    const out: { tool: string; isError: boolean; text: string }[] = [];
    let i = 0;
    for (const call of task.calls) {
      const make = FLUE_TOOLS[call.tool as keyof typeof FLUE_TOOLS];
      if (!make) {
        out.push({ tool: call.tool, isError: true, text: `unknown tool '${call.tool}'` });
        continue;
      }
      const tool = make(sandbox) as unknown as {
        execute(
          id: string,
          params: unknown,
        ): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>;
      };
      try {
        const r = await tool.execute(`call-${++i}`, call.params);
        const text = r.content.map((c) => c.text ?? "").join("");
        out.push({ tool: call.tool, isError: !!r.isError, text });
      } catch (e) {
        out.push({ tool: call.tool, isError: true, text: String((e as Error)?.message ?? e) });
      }
    }
    return out;
  }

  #kernel?: PythonKernel;
  /** One Python engine per agent cell, started on first use. */
  #python(): PythonKernel {
    this.#kernel ??= new PythonKernel(engineHost(this.env));
    return this.#kernel;
  }

  /**
   * Tool code in its own isolate: no network and only the narrowed capability. That is an RpcTarget
   * argument (stub transport), or the env.FILES binding (token transport), which works only while
   * this run is active.
   */
  /** Tool runs whose file binding is live (see ToolFilesEntrypoint): dropped when `run` settles. */
  #activeToolRuns = new Set<string>();
  toolRunActive(run: string): boolean {
    return this.#activeToolRuns.has(run);
  }

  async #tool(name: string, cap: Cap, code: string, input: unknown, bundled: boolean) {
    const config = deploymentToolConfig(this.env.TOOL_BUNDLE);
    await admitTool({ code, bundled }, toolPolicy(this.env, config), config);
    const loader = this.env.LOADER as WorkerLoader;
    // A fresh isolate per invocation: an isolate keyed by the code would keep its globals between
    // callers, so data one user's capability read could be returned to the next user.
    const id = `tool-${crypto.randomUUID()}`;
    // How the tool gets its files: with the stub transport, the narrowed capability as an
    // RpcTarget argument (the Agent never holds a token); with the token transport, a loopback
    // service binding in env.FILES (portable: celld cannot pass RpcTargets into isolates). The
    // tool's `files` argument is then null; `files ?? this.env.FILES` works on every runtime.
    const handoff = cap.handoff();
    const exports = (
      this.ctx as unknown as { exports?: Record<string, (o: { props: unknown }) => unknown> }
    ).exports;
    const viaBinding = handoff.transport === "token";
    if (viaBinding && !exports?.ToolFilesEntrypoint) {
      throw new Error("ENOSYS: this runtime offers no ctx.exports for the tool's file binding");
    }
    const env = viaBinding
      ? {
          FILES: exports?.ToolFilesEntrypoint?.({
            props: { workspace: handoff.workspace, token: handoff.token, agent: name, run: id },
          }),
        }
      : {};
    const worker = loader.get(id, async () => ({
      compatibilityDate: "2026-10-01",
      mainModule: "tool.js",
      modules: { "tool.js": code },
      env,
      globalOutbound: null,
    }));
    this.#activeToolRuns.add(id);
    try {
      return await worker
        .getEntrypoint()
        .run(viaBinding ? null : new ToolFiles(cap), input ?? null);
    } finally {
      this.#activeToolRuns.delete(id); // the binding refuses from now on, even if the tool kept it
    }
  }
}
