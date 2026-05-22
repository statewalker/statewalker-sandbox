import type { BashFactory } from "@flue/runtime";
import { createExecutor, type ExecutorToolDef } from "@just-bash/executor";
import type { FilesApi } from "@statewalker/webrun-files";
import { filesApiBashFactory } from "./bash-factory.js";

export interface BuildBashOptions {
  files: FilesApi;
  cwd?: string;
  /**
   * Tools exposed both as `tools.<name>(...)` inside js-exec and as
   * bash commands at the same name. Maps `name → { description, execute }`.
   */
  tools?: Record<string, ExecutorToolDef>;
}

/**
 * Compose the executor-wired `BashFactory` the workbench plugs into Flue.
 *
 * The resulting factory carries the executor's commands + `invokeTool` hook
 * so the LLM can call host-provided tools from bash AND from `js-exec`. The
 * executor handle itself is captured inside the closure — there is no
 * supported reason to inspect it from outside.
 */
export async function buildBash(opts: BuildBashOptions): Promise<BashFactory> {
  const executor = await createExecutor({ tools: opts.tools });
  return filesApiBashFactory({
    files: opts.files,
    cwd: opts.cwd,
    customCommands: executor.commands,
    javascript: { invokeTool: executor.invokeTool },
  });
}
