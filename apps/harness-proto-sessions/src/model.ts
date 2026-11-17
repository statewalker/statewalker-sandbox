// PROTOTYPE (statewalker/statewalker-root#89). The session model's rules, as plain data.

export type Action = "read" | "write";
export type Decision = "allow" | "ask" | "deny";

/** Mode rules per action kind (#79). */
export const MODES: Record<string, Record<Action, Decision>> = {
  default: { read: "allow", write: "ask" },
  acceptEdits: { read: "allow", write: "allow" },
  plan: { read: "allow", write: "deny" },
  dontAsk: { read: "allow", write: "deny" },
  bypassPermissions: { read: "allow", write: "allow" },
};
const RANK: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };
export const strictest = (ds: Decision[]): Decision =>
  ds.reduce<Decision>((a, b) => (RANK[b] > RANK[a] ? b : a), "allow");

/** Flue's tools each role's `*.use` defaults grant (#80). */
export const ROLE_TOOLS: Record<string, string[]> = {
  reader: ["read", "grep", "glob"],
  editor: ["read", "grep", "glob", "edit", "write"],
  owner: ["read", "grep", "glob", "edit", "write", "bash"],
};

/** Agent definitions: requested tools are requests, not grants (#73); `mode` only adds strictness. */
export const AGENTS: Record<string, { tools: string[]; mode?: string }> = {
  coder: { tools: ["read", "grep", "glob", "edit", "write", "bash"] },
  reviewer: { tools: ["read", "grep"], mode: "plan" },
  writer: { tools: ["read", "write"] },
};

/** Which file method is which action. */
export const ACTIONS: Record<string, Action> = {
  readFile: "read",
  readFileBuffer: "read",
  exists: "read",
  stat: "read",
  lstat: "read",
  readdir: "read",
  readdirStat: "read",
  realpath: "read",
  writeFile: "write",
  writeFileBuffer: "write",
  appendFile: "write",
  appendFileBuffer: "write",
  mkdir: "write",
  rm: "write",
  chmod: "write",
  utimes: "write",
};
