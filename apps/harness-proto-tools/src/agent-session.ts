// PROTOTYPE (statewalker/statewalker-root#90). One agent session = one Durable Object.
// Configured with the user's capability (a workspace token), their role in the project, the
// agent and the mode, it derives the session's tool set from the catalog and serves it two ways:
//   run(prompt)  — Flue's agent loop (pi-agent-core) with the projected AgentTools
//   mcp(request) — a per-session MCP endpoint listing and calling exactly the same set (d)
// Every call is re-checked against the CURRENT set (the mode can change), so a tool the model
// or an MCP client names without being offered it is refused.

import { DurableObject } from "cloudflare:workers";
import { Agent as LoopAgent } from "@earendil-works/pi-agent-core";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import { registerApiProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { TokenCap, type WorkspaceEnv } from "../../flue-capfs-do/src/caps.ts";
import { CATALOG } from "./catalog.ts";
import {
  agentRequests,
  type Narrowed,
  NS,
  narrow,
  readCatalog,
  type ToolDefinition,
} from "./definitions.ts";
import { type ToolResult, toAgentTool, toMcpTool } from "./projections.ts";
import { failed, runTool } from "./tools.ts";
import type { Workspace } from "./workspace.ts";

export interface Env extends WorkspaceEnv {
  WORKSPACE: DurableObjectNamespace<Workspace>;
  AGENT: DurableObjectNamespace<AgentSession>;
  LLM_BASE_URL?: string;
  MCP_GITHUB_URL?: string;
  WEATHER_URL?: string;
  WEATHER_API_KEY?: string;
}

export interface SessionConfig {
  workspace: string;
  token: string;
  project: string;
  user: string;
  role: string;
  agent: string;
  mode: string;
}

interface Approval {
  id: string;
  tool: string;
  args: unknown;
  state: "pending" | "done" | "refused";
  result?: ToolResult;
}

let registered = false;
function model(baseUrl: string) {
  if (!registered) {
    registerApiProvider(
      {
        api: "openai-completions",
        stream: openaiCompletions.stream as never,
        streamSimple: openaiCompletions.streamSimple as never,
      },
      "harness-proto-tools",
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

export class AgentSession extends DurableObject<Env> {
  #defs?: Promise<ToolDefinition[]>;

  async #config(): Promise<SessionConfig> {
    const c = await this.ctx.storage.get<SessionConfig>("config");
    if (!c) throw new Error("ENOENT: session not configured");
    return c;
  }

  /** The whole catalog as tool definitions (read once per cell, through a FilesApi). */
  #catalog(): Promise<ToolDefinition[]> {
    this.#defs ??= (async () => {
      const files = new MemFilesApi();
      for (const [path, text] of Object.entries(CATALOG)) await writeText(files, path, text);
      return readCatalog(files, this.env as unknown as Record<string, string | undefined>);
    })();
    return this.#defs;
  }

  async #narrowed(c: SessionConfig): Promise<Narrowed> {
    const files = new MemFilesApi();
    for (const [path, text] of Object.entries(CATALOG)) await writeText(files, path, text);
    const requests = await agentRequests(files, c.agent);
    return narrow(await this.#catalog(), { role: c.role, requests, mode: c.mode });
  }

  async configure(config: SessionConfig) {
    await this.ctx.storage.put("config", config);
    return this.tools();
  }

  async setMode(mode: string) {
    const c = await this.#config();
    await this.ctx.storage.put("config", { ...c, mode });
    return this.tools();
  }

  /** The session's tool set: offered (with the definitions) and absent (with why). */
  async tools() {
    const n = await this.#narrowed(await this.#config());
    return {
      offered: n.offered.map((o) => ({
        id: o.def[NS].id,
        name: o.def[NS].name,
        decision: o.decision,
      })),
      absent: n.absent,
      definitions: n.offered.map((o) => o.def),
    };
  }

  /** Every definition in the catalog, before narrowing (for inspecting the profile). */
  async catalog() {
    return this.#catalog();
  }

  /** One call, by projected name, re-checked against the current set. */
  async #call(name: string, args: unknown, approved = false): Promise<ToolResult> {
    const c = await this.#config();
    const n = await this.#narrowed(c);
    const o = n.offered.find((x) => x.def[NS].name === name);
    if (!o) {
      const def = (await this.#catalog()).find((d) => d[NS].name === name);
      const why = def ? n.absent.find((a) => a.id === def[NS].id)?.why : "no such tool";
      return failed(`refused: ${name} is not offered in this session (${why})`);
    }
    if (o.decision === "ask" && !approved) {
      const approval: Approval = { id: crypto.randomUUID(), tool: name, args, state: "pending" };
      await this.ctx.storage.put(`approval:${approval.id}`, approval);
      return {
        content: [{ type: "text", text: `approval required: ${approval.id}` }],
        details: { approval: approval.id },
        terminate: true, // the turn stops here; answering the approval runs the stored call
      };
    }
    const workspace = this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(c.workspace));
    return runTool(o.def, args, {
      cap: new TokenCap(this.env, c.workspace, c.token),
      cwd: `/${c.project}`,
      project: c.project,
      token: c.token,
      harness: (entry, project, token, a) =>
        workspace.harnessTool(
          entry,
          project,
          token,
          a as Record<string, unknown>,
        ) as Promise<unknown>,
      secrets: { WEATHER_API_KEY: this.env.WEATHER_API_KEY },
    });
  }

  /** The user's answer. Approving re-checks the call against the current set before it runs. */
  async approve(id: string, allow: boolean) {
    const a = await this.ctx.storage.get<Approval>(`approval:${id}`);
    if (a?.state !== "pending") throw new Error("ENOENT: no pending approval");
    if (!a) throw new Error("ENOENT: no pending approval");
    if (!allow) a.state = "refused";
    else {
      a.result = await this.#call(a.tool, a.args, true);
      a.state = a.result.isError ? "refused" : "done";
    }
    await this.ctx.storage.put(`approval:${id}`, a);
    return a;
  }

  /** One turn of Flue's agent loop with the session's tools; returns what happened. */
  async run(prompt: string) {
    const c = await this.#config();
    const n = await this.#narrowed(c);
    const calls: { name: string; args: unknown; result: string; isError: boolean }[] = [];
    const tools = n.offered.map((o) =>
      toAgentTool(o.def, async (args) => {
        const r = await this.#call(o.def[NS].name, args);
        calls.push({
          name: o.def[NS].name,
          args,
          result: r.content[0]?.text ?? "",
          isError: !!r.isError,
        });
        return r;
      }),
    );
    const agent = new LoopAgent({
      streamFn: streamSimple as never,
      getApiKey: async () => "sk-fake",
      initialState: {
        systemPrompt: `You are the ${c.agent} agent in project ${c.project}.`,
        model: model(String(this.env.LLM_BASE_URL)) as never,
        tools: tools as never,
        messages: [],
      },
    } as never);
    // A tool the model names but was never offered: pi answers "Tool <name> not found".
    agent.subscribe(
      (e: {
        type: string;
        toolName?: string;
        result?: { content?: { text?: string }[] };
        isError?: boolean;
      }) => {
        if (e.type === "tool_execution_end" && !tools.some((t) => t.name === e.toolName))
          calls.push({
            name: String(e.toolName),
            args: null,
            result: e.result?.content?.[0]?.text ?? "",
            isError: true,
          });
      },
    );
    await agent.prompt(prompt);
    await agent.waitForIdle();
    const messages = (agent.state as { messages: { role: string; content?: unknown }[] }).messages;
    const last = messages.filter((m) => m.role === "assistant").at(-1);
    const text = Array.isArray(last?.content)
      ? (last.content as { type: string; text?: string }[]).map((p) => p.text ?? "").join("")
      : String(last?.content ?? "");
    return { offered: tools.map((t) => t.name), calls, text };
  }

  /** The per-session MCP endpoint (JSON-RPC over Streamable HTTP, JSON responses). */
  async mcp(req: {
    jsonrpc: string;
    id?: number | string;
    method: string;
    params?: Record<string, unknown>;
  }) {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: req.id ?? null, result });
    const error = (code: number, message: string) => ({
      jsonrpc: "2.0",
      id: req.id ?? null,
      error: { code, message },
    });
    switch (req.method) {
      case "initialize":
        return reply({
          protocolVersion: "2026-07-28",
          capabilities: { tools: {} },
          serverInfo: { name: "harness-session", version: "0" },
        });
      case "tools/list": {
        const n = await this.#narrowed(await this.#config());
        return reply({ tools: n.offered.map((o) => toMcpTool(o.def)) });
      }
      case "tools/call": {
        const name = String(req.params?.name ?? "");
        const r = await this.#call(name, req.params?.arguments ?? {});
        if (r.isError && r.content[0]?.text.startsWith("refused:"))
          return error(-32602, r.content[0].text);
        return reply({
          content: r.content,
          ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}),
          isError: !!r.isError,
        });
      }
      default:
        return error(-32601, `method not found: ${req.method}`);
    }
  }
}
