// PROTOTYPE (statewalker/statewalker-root#89). One agent session = one Durable Object running
// Flue's agent loop (pi-agent-core) with Flue's own file tools over the session's capability.
// It holds the capability, never the user's access token: an agent keeps working after that
// token expires. Every file call goes to the Workspace cell's gate, which decides it then.

import { DurableObject } from "cloudflare:workers";
import { Agent as LoopAgent } from "@earendil-works/pi-agent-core";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import { registerApiProvider, streamSimple } from "@earendil-works/pi-ai/compat";
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
import { CapFs } from "../../flue-capfs-do/src/capfs.ts";
import type { Cap } from "../../flue-capfs-do/src/caps.ts";
import { rgForFlue } from "../../flue-capfs-do/src/flue-compat.ts";
import { fsError, rebuildError } from "../../flue-capfs-do/src/path.ts";
import type { Workspace } from "./workspace.ts";

export interface Env {
  WORKSPACE: DurableObjectNamespace<Workspace>;
  LLM_BASE_URL?: string;
}

export interface AgentConfig {
  id: string;
  workspace: string;
  project: string;
  agent: string;
  tools: string[];
  capability: string;
}

const MAKERS: Record<string, (s: never) => unknown> = {
  read: createReadTool as never,
  write: createWriteTool as never,
  edit: createEditTool as never,
  grep: createGrepTool as never,
  glob: createGlobTool as never,
  bash: createBashTool as never,
};

let registered = false;
function model(baseUrl: string) {
  if (!registered) {
    registerApiProvider(
      {
        api: "openai-completions",
        stream: openaiCompletions.stream as never,
        streamSimple: openaiCompletions.streamSimple as never,
      },
      "harness-proto-sessions",
    );
    registered = true;
  }
  return {
    id: "fake-model",
    name: "fake-model",
    api: "openai-completions",
    provider: "deployment",
    baseUrl,
    headers: {},
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

/** The capability as Flue's sandbox sees it: every call is a gate call in the Workspace cell. */
function gateCap(env: Env, c: AgentConfig): Cap {
  const ws = () => env.WORKSPACE.get(env.WORKSPACE.idFromName(c.workspace));
  const send = (method: string, path: string, args: unknown[]) =>
    Promise.resolve(ws().fsCall(c.capability, method, path, args)).catch((e) => {
      throw rebuildError(e);
    });
  const no = async () => {
    throw fsError("ENOSYS", "not in this prototype");
  };
  return {
    call: (method: string, path: string, ...args: unknown[]) => send(method, path, args),
    readdir: (path: string) => send("readdir", path, []) as Promise<string[]>,
    move: no,
    rpc: no,
    attenuate: no,
    revocationId: no,
    model: no,
    handoff: () => {
      throw fsError("ENOSYS", "not in this prototype");
    },
  } as unknown as Cap;
}

export class AgentSession extends DurableObject<Env> {
  async configure(config: AgentConfig) {
    await this.ctx.storage.put("config", config);
  }

  /** One turn: Flue's loop with the session's tools. A call that needs approval ends the turn. */
  async run(prompt: string) {
    const c = await this.ctx.storage.get<AgentConfig>("config");
    if (!c) throw new Error("ENOENT: session not configured");
    const cap = gateCap(this.env, c);
    const sandbox = await flueBash(
      () =>
        new Bash({
          fs: new CapFs(cap) as never,
          cwd: `/${c.project}`,
          customCommands: [rgForFlue],
        }) as never,
    ).createSandbox({ id: c.id });
    const calls: { name: string; result: string; isError: boolean }[] = [];
    let approval: string | undefined;
    const tools = c.tools.map((name) => {
      const tool = MAKERS[name]?.(sandbox as never) as {
        name: string;
        execute: (...a: unknown[]) => Promise<{ content: { text?: string }[] }>;
      };
      return {
        ...tool,
        async execute(...args: unknown[]) {
          let result: {
            content: { type?: string; text?: string }[];
            isError?: boolean;
            terminate?: boolean;
          };
          try {
            result = await tool.execute(...args);
          } catch (e) {
            result = {
              content: [{ type: "text", text: String((e as Error).message) }],
              isError: true,
            };
          }
          const text = result.content.map((p) => p.text ?? "").join("");
          const asked = /approval required: (ap-[\w-]+)/.exec(text)?.[1];
          if (asked) {
            approval = asked;
            result = {
              content: [{ type: "text", text: `approval required: ${asked}` }],
              isError: false,
              terminate: true,
            };
          }
          calls.push({
            name,
            result: result.content.map((p) => p.text ?? "").join(""),
            isError: !!result.isError,
          });
          return result;
        },
      };
    });
    const agent = new LoopAgent({
      streamFn: streamSimple as never,
      getApiKey: async () => "sk-fake",
      initialState: {
        systemPrompt: `You are the ${c.agent} agent in /${c.project}.`,
        model: model(String(this.env.LLM_BASE_URL)) as never,
        tools: tools as never,
        messages: [],
      },
    } as never);
    agent.subscribe(
      (e: { type: string; toolName?: string; result?: { content?: { text?: string }[] } }) => {
        if (e.type === "tool_execution_end" && !c.tools.includes(String(e.toolName)))
          calls.push({
            name: String(e.toolName),
            result: e.result?.content?.[0]?.text ?? "",
            isError: true,
          });
      },
    );
    await agent.prompt(prompt);
    await agent.waitForIdle();
    const last = (agent.state as { messages: { role: string; content?: unknown }[] }).messages
      .filter((m) => m.role === "assistant")
      .at(-1);
    const text = Array.isArray(last?.content)
      ? (last.content as { text?: string }[]).map((p) => p.text ?? "").join("")
      : String(last?.content ?? "");
    return { offered: tools.map((t) => t.name), calls, text, approval };
  }
}
