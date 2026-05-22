import type { FlueEvent, FlueSession } from "@flue/runtime";
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

export interface NewAgentCommandOptions {
  /** Late-bound session getter so the command can be wired before the session resolves. */
  session: () => FlueSession;
  /**
   * Subscribe to the FlueContext's event stream for the duration of the
   * `agent` call. The returned disposer is invoked after the prompt
   * resolves (success, error, or abort). Typically `ctx.subscribeEvent`
   * from `FlueContextInternal`.
   *
   * Caveat: this is a context-wide stream — events from other concurrent
   * sessions (if any exist in the same FlueContext) would also reach this
   * terminal. Today the workbench runs exactly one session, so this is
   * fine. When multi-session lands, filter by run id at subscription time.
   */
  subscribeEvent: (cb: (event: FlueEvent) => void) => () => void;
  /** Terminal to write streaming output into. */
  term: Terminal;
}

const POSIX_SIGINT_EXIT_CODE = 130;

/**
 * `agent <prompt>` custom command for the human-facing `Bash`.
 *
 * Streams `text_delta` and decorates `tool_start` / `thinking_start` events
 * into the supplied `Terminal` *while* the prompt is in flight (i.e. before
 * `session.prompt(...)` resolves). Ctrl-C from the terminal — surfaced as an
 * `AbortSignal` on the command's context — aborts the in-flight call and
 * returns POSIX exit code 130 (SIGINT convention).
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

    const dispose = opts.subscribeEvent((event) => {
      if (event.type === "text_delta") {
        opts.term.write(event.text.replace(/\n/g, "\r\n"));
      } else if (event.type === "tool_start") {
        opts.term.write(`\r\n\x1b[2m[${event.toolName}]\x1b[0m `);
      } else if (event.type === "thinking_start") {
        opts.term.write(`\r\n\x1b[2m… thinking …\x1b[0m\r\n`);
      }
    });

    try {
      const handle = opts.session().prompt(prompt, {
        signal: (ctx as { signal?: AbortSignal } | undefined)?.signal,
      });
      await handle;
      opts.term.write("\r\n");
      return { stdout: "", stderr: "", exitCode: 0 };
    } catch (err) {
      const name = (err as { name?: string } | undefined)?.name;
      if (name === "AbortError") {
        opts.term.write("\r\n\x1b[33m[aborted]\x1b[0m\r\n");
        return { stdout: "", stderr: "", exitCode: POSIX_SIGINT_EXIT_CODE };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { stdout: "", stderr: `agent: ${message}\n`, exitCode: 1 };
    } finally {
      dispose();
    }
  });
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
 */
export function newSessionCommand(opts: {
  sessions: FilesApiSessionStore;
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
