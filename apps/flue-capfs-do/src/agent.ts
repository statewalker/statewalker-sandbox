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
import { CapFs, safeExec } from "./capfs.ts";
import { type Cap, type CapHandoff, capFromHandoff, ToolFiles, type WorkspaceEnv } from "./caps.ts";
import { rgForFlue } from "./flue-compat.ts";
import { attenuationBlock } from "./policy.ts";
import { checkToolBundle } from "./tools/check.ts";
import { deploymentToolConfig, type ToolBundleConfig } from "./tools/config.ts";

export type AttenuationSpec = { scope?: string | string[]; readOnly?: boolean; datalog?: string };

export type Task =
  | { kind: "bash"; script: string; cwd?: string }
  | { kind: "flue"; calls: { tool: string; params: Record<string, unknown> }[]; cwd?: string }
  | { kind: "tool"; code: string; input?: unknown; bundled?: boolean }
  | { kind: "revocationId" };

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
  /** Run-side tool policy: JSON overrides of tool-bundle.config.json (see src/tools/config.ts). */
  TOOL_BUNDLE?: string;
}

/**
 * Whether Worker Loader isolates on this runtime can reach the host's files. cellb on Node runs
 * loaded code in a worker thread with the real node:fs — there a tool could read the cells'
 * SQLite files, including the Workspace root key — so tools are refused unless explicitly allowed.
 */
export const isolatesSeeHostFs = (): boolean =>
  /Node\.js/.test(globalThis.navigator?.userAgent ?? "");

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
        return this.#tool(cap, task.code, task.input, !!task.bundled);
      case "revocationId":
        return cap.revocationId();
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

  /** Tool code in its own isolate: no network, no bindings, only the narrowed capability as an argument. */
  async #tool(cap: Cap, code: string, input: unknown, bundled: boolean) {
    const loader = this.env.LOADER;
    if (!loader) throw new Error("ENOSYS: no Worker Loader binding (LOADER) in this runtime");
    const config = deploymentToolConfig(this.env.TOOL_BUNDLE);
    const policy = toolPolicy(this.env, config);
    if (policy === "refused") {
      throw new Error(
        "EPERM: tool isolates on this runtime can reach the host file system; refused",
      );
    }
    // A bundle (or any tool, under requireBundled / bundled-only) must pass the acceptance check.
    if (bundled || config.requireBundled || policy === "bundled-only") {
      if (!bundled)
        throw new Error("EPERM: this runtime accepts bundled tools only (bundle with bundleTool)");
      const r = checkToolBundle(code, config);
      if (!r.ok)
        throw new Error(`EPERM: tool bundle rejected: ${r.problems.slice(0, 5).join("; ")}`);
    }
    // A fresh isolate per invocation: an isolate keyed by the code would keep its globals between
    // callers, so data one user's capability read could be returned to the next user.
    const id = `tool-${crypto.randomUUID()}`;
    const worker = loader.get(id, async () => ({
      compatibilityDate: "2026-10-01",
      mainModule: "tool.js",
      modules: { "tool.js": code },
      env: {},
      globalOutbound: null,
    }));
    return worker.getEntrypoint().run(new ToolFiles(cap), input ?? null);
  }
}

/**
 * How this runtime treats tool tasks:
 *   "none"          no Worker Loader binding
 *   "isolated"      isolates have no host file system: raw modules and bundles run
 *   "bundled-only"  isolates see the host file system; checked bundles only (config opt-in)
 *   "refused"       isolates see the host file system; every tool refused (the default there)
 */
export function toolPolicy(
  env: Pick<AgentEnv, "LOADER" | "ALLOW_HOST_FS_TOOLS">,
  config: ToolBundleConfig,
): "none" | "isolated" | "bundled-only" | "refused" {
  if (!env.LOADER) return "none";
  if (!isolatesSeeHostFs() || env.ALLOW_HOST_FS_TOOLS === "1") return "isolated";
  return config.hostFsRuntimes === "bundled-only" ? "bundled-only" : "refused";
}
