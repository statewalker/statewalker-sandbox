// PROTOTYPE (statewalker/statewalker-root#90). The two derived shapes of a tool definition.
// Neither is ever stored (decision (a)): both are computed from the OpenAPI document.

import { type Action, inputOf, NS, outputOf, type ToolDefinition } from "./definitions.ts";

/** An entry of MCP `tools/list`. */
export function toMcpTool(d: ToolDefinition) {
  const x = d[NS];
  const output = outputOf(d);
  return {
    name: x.name,
    title: d.info.title,
    description: d.info.description,
    inputSchema: inputOf(d),
    ...(output ? { outputSchema: output } : {}),
    annotations: {
      readOnlyHint: x.action === "read",
      destructiveHint: x.action === "admin",
      openWorldHint: x.source === "mcp" || x.source === "rest",
    },
  };
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  details: unknown;
  structuredContent?: unknown;
  isError?: boolean;
  terminate?: boolean;
}

/**
 * A pi-agent-core `AgentTool`, the tool type Flue's agent loop runs. Read tools may run in
 * parallel; tools that change something run one at a time (decision (f)). `execute` goes back
 * to the harness, which re-checks the tool against the session's current set before running it.
 */
export function toAgentTool(
  d: ToolDefinition,
  execute: (args: unknown, signal?: AbortSignal) => Promise<ToolResult>,
) {
  const x = d[NS];
  const output = outputOf(d);
  return {
    name: x.name,
    label: d.info.title,
    description: d.info.description,
    parameters: inputOf(d),
    ...(output ? { outputSchema: output } : {}),
    executionMode: (x.action as Action) === "read" ? "parallel" : "sequential",
    execute: (_id: string, args: unknown, signal?: AbortSignal) => execute(args, signal),
  };
}
