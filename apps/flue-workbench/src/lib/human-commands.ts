import { type AgentInstanceHandle, AgentRunError, type FlueEvent } from "@flue/runtime";
import { type Command, defineCommand } from "just-bash";
import type { FilesApiSecretStore } from "./files-api-secret-store.js";
import type { FilesApiSessionStore } from "./files-api-session-store.js";
import type { Terminal } from "./terminal-contract.js";

/**
 * Custom commands registered on the human-facing `Bash` only.
 *
 * Never registered on the model-facing bash — otherwise the model could
 * read its own API key (`secret get GEMINI_API_KEY`) or wipe the session
 * mid-conversation. The audience invariant is encoded by the file
 * boundary: anything exported from here belongs to the human bash.
 */

// ── agent ─────────────────────────────────────────────────────────────

/**
 * The slice of Flue 2's `AgentInstanceHandle` (from `init(agent, { id })`)
 * the `agent` command drives: admit a prompt, await its settled reply,
 * durably abort the instance's work.
 */
export type AgentConversation = Pick<AgentInstanceHandle, "dispatch" | "read" | "abort">;

export interface NewAgentCommandOptions {
  /**
   * Late-bound handle getter so the command can be wired before the runtime
   * is (re)started — `session reset` swaps the runtime underneath it.
   */
  instance: () => AgentConversation;
  /**
   * Subscribe to the live `FlueEvent` stream of this agent instance for the
   * duration of the `agent` call. The returned disposer is invoked after the
   * reply settles (success, error, or abort). `createWorkbench` backs this
   * with Flue's process-global `observe()`, filtered to the workbench
   * instance id — so events of other instances never reach this terminal.
   */
  subscribeEvent: (cb: (event: FlueEvent) => void) => () => void;
  /** Terminal to write streaming output into. */
  term: Terminal;
}

const POSIX_SIGINT_EXIT_CODE = 130;

/**
 * `agent <prompt>` custom command for the human-facing `Bash`.
 *
 * Dispatches the prompt to the agent instance, then streams `text_delta`
 * and decorates `tool_start` / `thinking_start` events into the supplied
 * `Terminal` *while* the reply is in flight (i.e. before `read(...)`
 * settles). Ctrl-C from the terminal — surfaced as an `AbortSignal` on the
 * command's context — requests a durable abort of the instance's work
 * (Flue 2's `handle.abort()`), stops waiting, and returns POSIX exit code
 * 130 (SIGINT convention).
 */
export function newAgentCommand(opts: NewAgentCommandOptions): Command {
  return defineCommand("agent", async (args, ctx) => {
    const prompt = args.join(" ").trim();
    if (!prompt) {
      return {
        stdout: "",
        stderr: "usage: agent <prompt>\n",
        exitCode: 2,
      };
    }

    const signal = (ctx as { signal?: AbortSignal } | undefined)?.signal;
    const instance = opts.instance();
    const dispose = opts.subscribeEvent((event) => {
      if (event.type === "text_delta") {
        opts.term.write(event.text.replace(/\n/g, "\r\n"));
      } else if (event.type === "tool_start") {
        opts.term.write(`\r\n\x1b[2m[${event.toolName}]\x1b[0m `);
      } else if (event.type === "thinking_start") {
        opts.term.write(`\r\n\x1b[2m… thinking …\x1b[0m\r\n`);
      }
    });
    // Cancelling the local `read()` alone would leave the model running and
    // spending; `abort()` is what actually stops the instance's work.
    const abortRun = () => {
      instance.abort().catch(() => undefined);
    };
    signal?.addEventListener("abort", abortRun, { once: true });

    try {
      signal?.throwIfAborted();
      const receipt = await instance.dispatch(prompt);
      // Ctrl-C may land while admission was in flight: abort what we just
      // admitted (the listener fired before it existed) and stop waiting.
      if (signal?.aborted) {
        abortRun();
        signal.throwIfAborted();
      }
      await instance.read(receipt, signal ? { signal } : undefined);
      opts.term.write("\r\n");
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (err) {
      if (isAbort(err) || signal?.aborted) {
        opts.term.write("\r\n\x1b[33m[aborted]\x1b[0m\r\n");
        return { stdout: "", stderr: "", exitCode: POSIX_SIGINT_EXIT_CODE };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { stdout: "", stderr: `agent: ${message}\n`, exitCode: 1 };
    } finally {
      signal?.removeEventListener("abort", abortRun);
      dispose();
    }
  });
}

/** A local cancel (`AbortError`) or a run that settled `aborted`. */
function isAbort(err: unknown): boolean {
  if (err instanceof AgentRunError) return err.outcome === "aborted";
  return (err as { name?: string } | undefined)?.name === "AbortError";
}

// ── secret / session ──────────────────────────────────────────────────

const ok = () => ({ stdout: "", stderr: "", exitCode: 0 });

/** `secret get <key>` / `secret set <key> <value>` / `secret delete <key>` / `secret list` */
export function newSecretCommand(opts: { secrets: FilesApiSecretStore }): Command {
  return defineCommand("secret", async (args) => {
    const [op, key, ...rest] = args;
    if (op === "get" && key) {
      const v = (await opts.secrets.get(key)) ?? "";
      return { stdout: v ? `${v}\n` : "", stderr: "", exitCode: 0 };
    }
    if (op === "set" && key) {
      const value = rest.join(" ");
      await opts.secrets.set(key, value);
      return ok();
    }
    if (op === "delete" && key) {
      await opts.secrets.delete(key);
      return ok();
    }
    if (op === "list") {
      const keys = await opts.secrets.list();
      return { stdout: `${keys.join("\n")}\n`, stderr: "", exitCode: 0 };
    }
    return {
      stdout: "",
      stderr: "usage: secret get|set|delete|list [key] [value]\n",
      exitCode: 2,
    };
  });
}

/**
 * `session reset` — wipes the persisted session under the configured id.
 * Useful for starting a fresh conversation without nuking the workspace.
 *
 * `sessions.delete` must be safe to call while the workbench is live;
 * `createWorkbench` passes a wrapper that stops the Flue runtime, deletes
 * the files, and restarts it (Flue 2 stores have no per-session deletion).
 */
export function newSessionCommand(opts: {
  sessions: Pick<FilesApiSessionStore, "delete">;
  sessionId: string;
}): Command {
  return defineCommand("session", async (args) => {
    const [op] = args;
    if (op === "reset") {
      await opts.sessions.delete(opts.sessionId);
      return ok();
    }
    return {
      stdout: "",
      stderr: "usage: session reset\n",
      exitCode: 2,
    };
  });
}
