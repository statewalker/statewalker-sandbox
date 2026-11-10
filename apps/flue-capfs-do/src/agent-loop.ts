// An LLM agent on the capability file system: the model loop Flue is built on (pi-agent-core)
// with Flue's own model-facing tools (read, write, edit, grep, glob, bash) over the same
// capability-backed sandbox the `flue` task uses. Every file access the model asks for is a
// capability call, authorized in the Workspace cell.
//
// The model is the deployment's: the `LLM` var (JSON or object) names an OpenAI-compatible
// endpoint ({ baseUrl, model, api?, contextWindow?, maxTokens?, headers?, callerToken?,
// callerTokenHeader? }) and the `LLM_API_KEY` secret holds its key. Nothing in a request chooses
// the endpoint or sees the key.
//
// A caller can bring its own credential for the model (`llmToken`, handed down the delegation
// chain by Agent.run; a hop can replace it). `callerToken` says whether the deployment accepts
// one ("allow", the default), insists on one ("require") or refuses one ("forbid"). The token is
// sent as the API key, or, with `callerTokenHeader`, in that header beside the deployment's key
// (for a gateway that authenticates the caller and holds the provider key itself).
//
// A conversation can be kept in the Agent cell (`session`), stored per capability: the messages
// hold file contents read with that capability, so another capability starts its own
// conversation even under the same session name. The key is the capability the request brought
// (its revocation id) and the delegation chain it named (`scope`, from Agent.run), not the token
// the last hop holds: attenuation mints fresh block keys on every run.

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
import { trimHistory } from "./agent-history.ts";
import { CapFs } from "./capfs.ts";
import type { Cap } from "./caps.ts";
import { rgForFlue } from "./flue-compat.ts";
import { type LlmConfig, llmConfig, llmCredentials, redactor } from "./llm-config.ts";

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

export interface AgentLoopOptions {
  /** Where the session is kept: the requester's revocation id and chain (see Agent.run). */
  scope: string;
  sandboxId: string;
  /** The caller's model credential (see the header comment). */
  llmToken?: string;
}

export { llmConfig };

export interface AgentLoopEnv {
  LLM?: unknown;
  LLM_API_KEY?: string;
}

interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
}

const SESSION_MESSAGES = 200;
const SESSION_BYTES = 1024 * 1024;
/** Sessions kept per Agent cell; the least recently used one is dropped beyond this. */
const SESSIONS_PER_CELL = 32;
const SESSION_INDEX = "agent-sessions";
const TEXT_LIMIT = 4000;
const ERROR_LIMIT = 500;
/** prompt and instructions, each. */
const INPUT_LIMIT = 100_000;
/** After the timeout aborts the loop, how long it may take to wind down. */
const GRACE_MS = 5000;
/** Rough characters per token, to keep a stored history within the model's context. */
const CHARS_PER_TOKEN = 3;

let providersRegistered = false;

function modelOf(c: LlmConfig, extraHeaders: Record<string, string> = {}) {
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
    headers: { ...c.headers, ...extraHeaders },
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
  toolCallId?: string;
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
  usage?: { input?: number; output?: number };
};
const textOf = (m: Message | undefined) =>
  typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => c.text ?? "").join("");

// One run at a time per session (per Agent cell: a cell runs in one isolate). `hold` keeps
// the session locked past the return, until a run that outlived its deadline has settled.
const sessionLocks = new Map<string, Promise<unknown>>();
async function withSessionLock<T>(
  key: string | undefined,
  fn: (hold: (p: Promise<unknown>) => void) => Promise<T>,
): Promise<T> {
  let held: Promise<unknown> = Promise.resolve();
  const hold = (p: Promise<unknown>) => {
    held = p;
  };
  if (!key) return fn(hold);
  const prev = sessionLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => fn(hold));
  const tail = run.catch(() => {}).then(() => held.catch(() => {}));
  sessionLocks.set(key, tail);
  tail.then(() => {
    if (sessionLocks.get(key) === tail) sessionLocks.delete(key);
  });
  return run;
}

// The cell's session index is updated one run at a time (sessions have locks of their own).
let indexQueue: Promise<unknown> = Promise.resolve();
function touchSession(storage: Storage, key: string) {
  const next = indexQueue.catch(() => {}).then(() => updateIndex(storage, key));
  indexQueue = next;
  return next;
}
async function updateIndex(storage: Storage, key: string) {
  const index = ((await storage.get<string[]>(SESSION_INDEX)) ?? []).filter((k) => k !== key);
  index.push(key);
  for (const old of index.splice(0, Math.max(0, index.length - SESSIONS_PER_CELL)))
    await storage.delete(old);
  await storage.put(SESSION_INDEX, index);
}

export async function runAgentLoop(
  cap: Cap,
  req: AgentLoopRequest,
  env: AgentLoopEnv,
  storage: Storage,
  { scope, sandboxId, llmToken }: AgentLoopOptions,
) {
  if (typeof req.prompt !== "string" || !req.prompt)
    throw new Error("EINVAL: agent: prompt is required");
  if (req.session !== undefined && String(req.session).length > 200)
    throw new Error("EINVAL: agent: session name is too long");
  if (req.prompt.length > INPUT_LIMIT) throw new Error("EINVAL: agent: prompt is too long");
  if (req.instructions !== undefined && String(req.instructions).length > INPUT_LIMIT)
    throw new Error("EINVAL: agent: instructions are too long");
  const config = llmConfig(env);
  if (!config) throw new Error("ENOSYS: no model configured for this deployment (LLM)");
  const credentials = llmCredentials(config, env.LLM_API_KEY, llmToken);
  // Neither credential may come back in an error.
  const redact = redactor([credentials.apiKey, llmToken, env.LLM_API_KEY]);
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

  const sessionKey = req.session ? `agent-session:${scope}:${String(req.session)}` : undefined;
  // Whatever fails below, its message carries no credential.
  return withSessionLock(sessionKey && `${sandboxId}\n${sessionKey}`, async (hold) => {
    const model = modelOf(config, credentials.headers);
    // What is sent back each turn stays within the context, leaving room for the reply.
    const contextBytes = Math.max(
      (model.contextWindow - model.maxTokens) * CHARS_PER_TOKEN,
      16 * 1024,
    );
    const stored = (sessionKey ? await storage.get<Message[]>(sessionKey) : undefined) ?? [];
    const history = trimHistory(stored, SESSION_MESSAGES, Math.min(SESSION_BYTES, contextBytes));
    const agent = new LoopAgent({
      streamFn: streamSimple as never,
      getApiKey: () => credentials.apiKey,
      initialState: {
        systemPrompt:
          req.instructions ??
          "You work on a file system through your tools. Paths are absolute; you see only what you are allowed to.",
        model: model as never,
        tools: tools as never,
        messages: history as never,
      },
    } as never);

    const maxTurns = Math.min(Math.max(Number(req.maxTurns) || 12, 1), 50);
    const timeoutMs = Math.min(Math.max(Number(req.timeoutMs) || 120_000, 1000), 600_000);
    let turns = 0;
    let stopped: string | undefined;
    agent.subscribe((e: { type: string; message?: Message; toolResults?: unknown[] }) => {
      if (e.type !== "turn_end" || stopped) return; // the turn cut short by the abort does not count
      turns += 1;
      // Only a turn that asked for tools leads to another one: a run that ends on its last
      // allowed turn is not a limit stop.
      if (
        turns >= maxTurns &&
        (e.message?.stopReason === "toolUse" || (e.toolResults?.length ?? 0) > 0)
      ) {
        stopped = `stopped after ${maxTurns} turns`;
        agent.abort();
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hard: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        stopped ??= `stopped after ${timeoutMs} ms`;
        agent.abort();
        // A tool that ignores the abort does not hold the run past the grace period.
        hard = setTimeout(resolve, GRACE_MS);
      }, timeoutMs);
    });
    const loop = (async () => {
      await agent.prompt(req.prompt);
      await agent.waitForIdle();
    })();
    // A run that outlives the grace period keeps its session locked until it settles: a tool
    // that ignores the abort may still finish a write, but no other run on the session starts.
    hold(loop);
    try {
      await Promise.race([loop, deadline]);
    } finally {
      clearTimeout(timer);
      clearTimeout(hard);
    }

    const messages = (agent.state.messages as unknown as Message[]).filter(
      (m) => m.role !== "system",
    );
    const fresh = messages.slice(history.length);
    const toolCalls: {
      tool: string;
      arguments: unknown;
      isError: boolean;
      result: string;
      id?: string;
      done?: boolean;
    }[] = [];
    for (const m of fresh) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const c of m.content)
          if (c.type === "toolCall")
            toolCalls.push({
              tool: String(c.name),
              arguments: c.arguments,
              isError: false,
              result: "",
              id: c.id,
            });
      } else if (m.role === "toolResult") {
        const call = toolCalls.find((t) => !t.done && t.id !== undefined && t.id === m.toolCallId);
        if (call) {
          call.done = true;
          call.isError = !!m.isError;
          call.result = clip(textOf(m));
        }
      }
    }
    const assistants = fresh.filter((m) => m.role === "assistant");
    const last = assistants.at(-1);
    // The reply is the last real answer: an abort appends an empty "aborted" message.
    const answer = [...assistants]
      .reverse()
      .find((m) => m.stopReason !== "aborted" && m.stopReason !== "error");
    const usage = fresh.reduce(
      (u, m) => ({
        input: u.input + (m.usage?.input ?? 0),
        output: u.output + (m.usage?.output ?? 0),
      }),
      { input: 0, output: 0 },
    );
    for (const c of toolCalls)
      if (!c.done) {
        c.isError = true;
        c.result = "no result (the run was stopped)";
      }
    // The provider's message, without the URLs it may name, and clipped.
    const providerError =
      last?.stopReason === "error"
        ? clip(
            redact(String(last.errorMessage ?? "error")).replace(/\b\w+:\/\/\S+/g, "<url>"),
            ERROR_LIMIT,
          )
        : undefined;
    const errors = [stopped, providerError].filter(Boolean);

    let kept = messages.length;
    if (sessionKey) {
      const keep = trimHistory(messages, SESSION_MESSAGES, SESSION_BYTES);
      kept = keep.length;
      await storage.put(sessionKey, keep);
      await touchSession(storage, sessionKey);
    }
    return {
      reply: clip(textOf(answer)),
      stopReason: stopped ? "limit" : (last?.stopReason ?? "unknown"),
      error: errors.length ? errors.join("; ") : undefined,
      turns,
      toolCalls: toolCalls.map(({ id: _id, done: _done, ...c }) => c),
      usage,
      session: req.session ? { name: String(req.session), messages: kept } : undefined,
    };
  }).catch((e: unknown) => {
    throw new Error(redact(String((e as Error)?.message ?? e)));
  });
}
