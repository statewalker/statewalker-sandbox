import type { BashFactory } from "@flue/runtime";
import { createExecutor, type ExecutorHandle } from "@just-bash/executor";
import type { FilesApi } from "@statewalker/webrun-files";
import type { CustomCommand } from "just-bash";
import { filesApiBashFactory } from "./bash-factory.js";

export interface BuildBashTool {
  description?: string;
  // Permissive `any` here lets consumers narrow `args` to their tool-specific
  // shape (`{ text: string }`, etc.). The executor decodes JSON, so the runtime
  // shape is always `Record<string, unknown>` at the boundary anyway.
  // biome-ignore lint/suspicious/noExplicitAny: see comment above
  execute: (args: any) => unknown;
}

export interface BuildBashOptions {
  files: FilesApi;
  cwd?: string;
  /**
   * Tools exposed both as `tools.<name>(...)` inside js-exec and as
   * bash commands at the same name. Maps `name → { description, execute }`.
   */
  tools?: Record<string, BuildBashTool>;
  /** Extra customCommands appended after the executor's command set. */
  extraCommands?: CustomCommand[];
  env?: Record<string, string>;
}

export interface BuildBashResult {
  executor: ExecutorHandle;
  factory: BashFactory;
}

/**
 * Compose the executor + bash-factory pair the workbench wires into Flue.
 *
 * The model-facing factory carries the executor's commands and `invokeTool`
 * hook so the LLM can call host-provided tools from bash AND from `js-exec`.
 * The human-facing terminal builds its own `Bash` (in `createWorkbench`)
 * sharing the same `FilesApi` and reusing the executor's commands — see
 * spec scenario "two-bash / one FS".
 */
export async function buildBash(opts: BuildBashOptions): Promise<BuildBashResult> {
  const executor = await createExecutor({
    tools: opts.tools,
  });

  const factory = filesApiBashFactory({
    files: opts.files,
    cwd: opts.cwd,
    env: opts.env,
    customCommands: [...executor.commands, ...(opts.extraCommands ?? [])],
    javascript: { invokeTool: executor.invokeTool },
  });

  return { executor, factory };
}
