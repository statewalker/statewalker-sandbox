import type { FlueEvent, FlueSession } from "@flue/runtime";
import { type Command, defineCommand } from "just-bash";
import type { Terminal } from "./terminal-contract.js";

export interface NewAgentCommandOptions {
  /** Late-bound session getter so the command can be wired before the session resolves. */
  session: () => FlueSession;
  /**
   * Per-call event subscription point. Returns a disposer that the command
   * invokes after the prompt resolves (success, error, or abort). Typically
   * `ctx.subscribeEvent` from `FlueContextInternal`.
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
