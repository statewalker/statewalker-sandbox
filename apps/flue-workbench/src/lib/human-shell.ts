import type { FilesApi } from "@statewalker/webrun-files";
import { Bash, type CustomCommand } from "just-bash";
import { FilesApiAdapter } from "./files-api-adapter.js";
import type { Terminal } from "./terminal-contract.js";

export interface AttachHumanShellOptions {
  /** The user-visible files (typically `views.userFiles`). */
  files: FilesApi;
  /** Initial cwd; tracks subsequent `cd` invocations across calls. */
  cwd: string;
  /** Terminal the shell reads input from and writes output to. */
  terminal: Terminal;
  /** Human-only commands registered on the bash (`agent`, `secret`, `session`). */
  customCommands: CustomCommand[];
}

export interface HumanShell {
  /**
   * Run a single command line through the human bash. Threads cwd/env state
   * across calls (see SHELL-STATE PERSISTENCE below).
   */
  runShellLine(line: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Detach the `onData` handler and stop the interactive loop. */
  dispose(): void;
}

// \x01 (SOH) is the sentinel — chosen because it never appears in real
// command output, so the marker is unambiguous and easy to strip.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional SOH sentinel
const CWD_MARKER_RE = /\x01CWD:(.*?)\x01/;
const CWD_PROBE = `; printf '\\x01CWD:%s\\x01' "$(pwd)"`;

/**
 * Construct the human-facing bash, wire `terminal.onData` to feed lines into
 * it, render a shell-style prompt, and thread cwd/env state across calls.
 *
 * SHELL-STATE PERSISTENCE
 * -----------------------
 * `Bash.exec()` builds a copy of `this.state` for each call and runs the
 * script against the copy — internal `cd` / `export FOO=bar` mutations are
 * thrown away when the call returns. Without compensation, typing `cd /foo`
 * then `ls` would list the constructor cwd, not `/foo`.
 *
 * The fix:
 *   1. Maintain `currentCwd` + `currentEnv` between calls.
 *   2. Append a cwd probe (`; printf '\x01CWD:%s\x01' "$(pwd)"`) to every
 *      script so the post-execution cwd shows up at the end of stdout.
 *   3. Pass `{ cwd, env }` into every `exec()` so the user-visible state
 *      threads forward. `env` comes from `BashExecResult.env` directly
 *      (already exposes the post-script env, including `export`s).
 *
 * The minimal `onData` line-buffered loop here is the "task 6.2 follow-up"
 * landing point in the README — a production-grade input-handler port lands
 * inside this module without touching `createWorkbench`.
 */
export function attachHumanShell(opts: AttachHumanShellOptions): HumanShell {
  const humanBash = new Bash({
    fs: new FilesApiAdapter({ files: opts.files, cwd: opts.cwd }),
    cwd: opts.cwd,
    customCommands: opts.customCommands,
  });

  let currentCwd = opts.cwd;
  let currentEnv: Record<string, string> | undefined;

  const runShellLine = async (line: string) => {
    const r = await humanBash.exec(`{ ${line}; } ${CWD_PROBE}`, {
      cwd: currentCwd,
      env: currentEnv,
      replaceEnv: currentEnv !== undefined,
    });
    let stdout = r.stdout;
    const m = CWD_MARKER_RE.exec(stdout);
    if (m?.[1]) {
      currentCwd = m[1];
      stdout = stdout.replace(CWD_MARKER_RE, "");
    }
    currentEnv = r.env;
    return { ...r, stdout };
  };

  // Shell-style prompt: cyan `flue-workbench:<cwd>$`. Re-read every time so
  // the cwd reflects the most recent `cd`. The reset (`\x1b[0m`) immediately
  // follows the `$` so the user's typed text is rendered in the default
  // terminal colour, not cyan.
  const writePrompt = () => {
    opts.terminal.write(`\x1b[36mflue-workbench\x1b[0m:${currentCwd} $ `);
  };
  writePrompt();

  // xterm.js's default Backspace mapping is \x7f (DEL); some configs send \b
  // (BS, \x08). Accept both.
  const isBackspace = (ch: string) => ch === "\x7f" || ch === "\b";

  const lineBuffer: string[] = [];

  const handleChunk = async (chunk: string) => {
    for (const ch of chunk) {
      if (ch === "\r" || ch === "\n") {
        const line = lineBuffer.join("").trim();
        lineBuffer.length = 0;
        opts.terminal.write("\r\n");
        if (!line) {
          writePrompt();
          continue;
        }
        try {
          const r = await runShellLine(line);
          if (r.stdout) opts.terminal.write(r.stdout.replace(/\n/g, "\r\n"));
          if (r.stderr) {
            opts.terminal.write(`\x1b[31m${r.stderr.replace(/\n/g, "\r\n")}\x1b[0m`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          opts.terminal.write(`\x1b[31m${msg}\r\n\x1b[0m`);
        }
        writePrompt();
      } else if (isBackspace(ch)) {
        if (lineBuffer.length > 0) {
          lineBuffer.pop();
          // `\b \b` overwrites the visible glyph then steps back over the space.
          opts.terminal.write("\b \b");
        }
      } else {
        lineBuffer.push(ch);
        opts.terminal.write(ch);
      }
    }
  };

  // Serialize chunks. xterm.onData fires reentrantly while the async handler
  // is awaiting — without this chain, two chunks can race on `lineBuffer`,
  // `currentCwd`/`currentEnv`, and interleave output on the same terminal.
  let processing: Promise<void> = Promise.resolve();
  const inputDisposer = opts.terminal.onData((chunk) => {
    processing = processing.then(() => handleChunk(chunk));
  });

  return {
    runShellLine,
    dispose: () => inputDisposer.dispose(),
  };
}
