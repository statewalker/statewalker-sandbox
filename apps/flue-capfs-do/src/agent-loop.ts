// An LLM agent on the capability file system: the model loop Flue is built on (pi-agent-core)
// with Flue's own model-facing tools (read, write, edit, grep, glob, bash) over the same
// capability-backed sandbox the `flue` task uses. Every file access the model asks for is a
// capability call, authorized in the Workspace cell.
//
// The model is the deployment's: the `LLM` var (JSON or object) names an OpenAI-compatible
// endpoint ({ baseUrl, model, api?, contextWindow?, maxTokens?, headers? }) and the `LLM_API_KEY`
// secret holds its key. Nothing in a request chooses the endpoint or sees the key.
//
// A conversation can be kept in the Agent cell (`session`), stored per capability (its
// revocation id): the messages hold file contents read with that capability, so another
// capability starts its own conversation even under the same session name.

import { Agent as LoopAgent } from "@earendil-works/pi-agent-core";
import * as anthropicMessages from "@earendil-works/pi-ai/api/anthropic-messages";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import * as openaiResponses from "@earendil-works/pi-ai/api/openai-responses";
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
import { CapFs } from "./capfs.ts";
import type { Cap } from "./caps.ts";
import { rgForFlue } from "./flue-compat.ts";

export interface AgentLoopRequest {
  prompt: string;
  /** System instructions (default: a short description of the file system). */
  instructions?: string;
  /** Model turns before the run is stopped (default 12, at most 50). */
  maxTurns?: number;
  /** Wall-clock limit in ms (default 120 s, at most 600 s). */
  timeoutMs?: number;
  /** Keep the conversation under this name (per capability) and continue it next time. */
  session?: string;
  cwd?: string;
}

export interface LlmConfig {
  baseUrl: string;
  model: string;
  api?: "openai-completions" | "openai-responses" | "anthropic-messages";
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
}

export interface AgentLoopEnv {
  LLM?: unknown;
  LLM_API_KEY?: string;
}

interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

const SESSION_MESSAGES = 200;
const SESSION_BYTES = 1024 * 1024;
const TEXT_LIMIT = 4000;

/** The deployment's model, or undefined when none is configured. */
export function llmConfig(env: AgentLoopEnv): LlmConfig | undefined {
  const raw = env.LLM;
  if (raw === undefined || raw === null || raw === "") return undefined;
  let c: Partial<LlmConfig>;
  try {
    c = typeof raw === "string" ? JSON.parse(raw) : (raw as Partial<LlmConfig>);
  } catch {
    throw new Error("EINVAL: LLM is not valid JSON");
  }
  if (typeof c.baseUrl !== "string" || typeof c.model !== "string") {
    throw new Error("EINVAL: LLM needs baseUrl and model");
  }
  return c as LlmConfig;
}

let providersRegistered = false;

function modelOf(c: LlmConfig) {
  if (!providersRegistered) {
    // Only the APIs an LLM config can name (registering every built-in one pulls in providers
    // that import node:fs and friends, which a browser cannot load).
    for (const [api, m] of [
      ["openai-completions", openaiCompletions],
      ["openai-responses", openaiResponses],
      ["anthropic-messages", anthropicMessages],
    ] as const) {
      registerApiProvider(
        { api, stream: m.stream as never, streamSimple: m.streamSimple as never },
        "flue-capfs-do",
      );
    }
    providersRegistered = true;
  }
  return {
    id: c.model,
    name: c.model,
    api: c.api ?? "openai-completions",
    provider: "deployment",
    baseUrl: c.baseUrl,
    headers: c.headers,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: c.contextWindow ?? 128_000,
    maxTokens: c.maxTokens ?? 4096,
  };
}

const clip = (s: string, n = TEXT_LIMIT) =>
  s.length > n ? `${s.slice(0, n)}… [${s.length - n} more]` : s;
type Content = { type: string; text?: string; name?: string; arguments?: unknown; id?: string };
type Message = {
  role: string;
  content?: Content[] | string;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
  usage?: { input?: number; output?: number };
};
const textOf = (m: Message | undefined) =>
  typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => c.text ?? "").join("");

export async function runAgentLoop(
  cap: Cap,
  req: AgentLoopRequest,
  env: AgentLoopEnv,
  storage: Storage,
  sandboxId: string,
) {
  if (typeof req.prompt !== "string" || !req.prompt)
    throw new Error("EINVAL: agent: prompt is required");
  const config = llmConfig(env);
  if (!config) throw new Error("ENOSYS: no model configured for this deployment (LLM)");
  const cwd = req.cwd ?? "/";
  const sandbox = await flueBash(
    () => new Bash({ fs: new CapFs(cap) as never, cwd, customCommands: [rgForFlue] }) as never,
  ).createSandbox({ id: sandboxId });
  const tools = [
    createReadTool,
    createWriteTool,
    createEditTool,
    createGrepTool,
    createGlobTool,
    createBashTool,
  ].map((make) => make(sandbox));

  const sessionKey = req.session
    ? `agent-session:${await cap.revocationId()}:${String(req.session)}`
    : undefined;
  const history = (sessionKey ? await storage.get<Message[]>(sessionKey) : undefined) ?? [];
  const agent = new LoopAgent({
    streamFn: streamSimple as never,
    getApiKey: () => env.LLM_API_KEY,
    initialState: {
      systemPrompt:
        req.instructions ??
        "You work on a file system through your tools. Paths are absolute; you see only what you are allowed to.",
      model: modelOf(config) as never,
      tools: tools as never,
      messages: history as never,
    },
  } as never);

  const maxTurns = Math.min(Math.max(Number(req.maxTurns) || 12, 1), 50);
  const timeoutMs = Math.min(Math.max(Number(req.timeoutMs) || 120_000, 1000), 600_000);
  let turns = 0;
  let stopped: string | undefined;
  agent.subscribe((e: { type: string }) => {
    if (e.type !== "turn_end" || stopped) return; // the turn cut short by the abort does not count
    turns += 1;
    if (turns >= maxTurns) {
      stopped = `stopped after ${maxTurns} turns`;
      agent.abort();
    }
  });
  const timer = setTimeout(() => {
    stopped ??= `stopped after ${timeoutMs} ms`;
    agent.abort();
  }, timeoutMs);
  try {
    await agent.prompt(req.prompt);
    await agent.waitForIdle();
  } finally {
    clearTimeout(timer);
  }

  const messages = (agent.state.messages as unknown as Message[]).filter(
    (m) => m.role !== "system",
  );
  const fresh = messages.slice(history.length);
  const toolCalls: { tool: string; arguments: unknown; isError: boolean; result: string }[] = [];
  for (const m of fresh) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const c of m.content)
        if (c.type === "toolCall")
          toolCalls.push({
            tool: String(c.name),
            arguments: c.arguments,
            isError: false,
            result: "",
          });
    } else if (m.role === "toolResult") {
      const call = [...toolCalls].reverse().find((t) => t.tool === m.toolName && t.result === "");
      if (call) {
        call.isError = !!m.isError;
        call.result = clip(textOf(m));
      }
    }
  }
  const last = [...fresh].reverse().find((m) => m.role === "assistant");
  const usage = fresh.reduce(
    (u, m) => ({
      input: u.input + (m.usage?.input ?? 0),
      output: u.output + (m.usage?.output ?? 0),
    }),
    { input: 0, output: 0 },
  );

  if (sessionKey) {
    let keep = messages.slice(-SESSION_MESSAGES);
    while (keep.length && JSON.stringify(keep).length > SESSION_BYTES)
      keep = keep.slice(Math.ceil(keep.length / 4));
    await storage.put(sessionKey, keep);
  }
  return {
    reply: clip(textOf(last)),
    stopReason: stopped ? "limit" : (last?.stopReason ?? "unknown"),
    error: stopped ?? (last?.stopReason === "error" ? last.errorMessage : undefined),
    turns,
    toolCalls,
    usage,
    session: req.session ? { name: String(req.session), messages: messages.length } : undefined,
  };
}
