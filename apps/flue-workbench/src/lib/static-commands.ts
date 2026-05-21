import { type Command, defineCommand } from "just-bash";
import type { FilesApiSecretStore } from "./files-api-secret-store.js";
import type { FilesApiSessionStore } from "./files-api-session-store.js";

const ok = () => ({ stdout: "", stderr: "", exitCode: 0 });

/**
 * `secret get <key>` / `secret set <key> <value>` / `secret list`
 *
 * Human-terminal-only. Never registered on the model-facing bash —
 * otherwise the model could read its own API key into context via
 * `secret get GEMINI_API_KEY`.
 */
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
