import {
  ACTION_KEYS,
  type ActionKey,
  type FileRef,
  filesCopy,
  filesDelete,
  filesMkdir,
  filesMove,
  filesRename,
  filesResolveActions,
} from "@fm/core";
import {
  type CommandDeclaration,
  CommandError,
  type Commands,
  CommandsRegistry,
} from "@statewalker/shared-commands";
import {
  panelsClose,
  panelsNavigate,
  panelsRefresh,
  panelsSelect,
  panelsSetSort,
} from "./declarations.js";

/**
 * The priority the core's own handlers listen at. Negative, always: it is the
 * package's documented fallback convention, and it is the whole mechanism by
 * which a host overrides an operation without touching app code.
 */
export const CORE_PRIORITY = -1;

/**
 * Has a host already claimed this command? Await this as the FIRST statement of
 * every core handler that does real work.
 *
 * The bus does not stop dispatch when a higher-priority listener claims — only
 * when the command SETTLES, and a listener answering with a promise settles a
 * microtask later. So at the moment a negative-priority handler runs, `settled`
 * is still false even though the override has already won. A core handler that
 * acted immediately would delete the file the host rerouted to a trash mount.
 *
 * One yield puts the core after every listener's settle. The bus discards a
 * resolution that arrives after settling, so standing down needs no answer.
 */
export async function overridden(cmd: { settled: boolean }): Promise<boolean> {
  await Promise.resolve();
  return cmd.settled;
}

/** Menus render from the registry, so the registry has to hold the surface. */
export function commandRegistry(): { registry: CommandsRegistry; corePriority: number } {
  return {
    registry: CommandsRegistry.create(
      filesCopy,
      filesMove,
      filesDelete,
      filesMkdir,
      filesRename,
      // Coarse panel actions are commands too. Continuous view state — cursor,
      // scroll — is not: the test is whether a host would ever override it or an
      // agent ever invoke it. Navigate yes, scroll no.
      panelsNavigate,
      panelsSetSort,
      panelsSelect,
      panelsRefresh,
      panelsClose,
    ),
    corePriority: CORE_PRIORITY,
  };
}

export interface MenuItem {
  key: string;
  /** What a translator overrides. The view layer resolves it. */
  labelKey: string;
  label?: string;
  description?: string;
  icon?: string;
}

/**
 * Projects declarations as menu items.
 *
 * `label` / `description` / `icon` on the declaration are i18n FALLBACKS,
 * overridden via `command.{key}.label` — the convention `shared-commands`
 * already established, so the app carries one i18n idiom rather than two.
 */
export function menuItems(
  registry: CommandsRegistry,
  catalogue: Record<string, string> = {},
): MenuItem[] {
  return registry.list().map((decl) => {
    const labelKey = `command.${decl.key}.label`;
    return {
      key: decl.key,
      labelKey,
      label: catalogue[labelKey] ?? decl.label,
      description: catalogue[`command.${decl.key}.description`] ?? decl.description,
      icon: decl.icon,
    };
  });
}

export interface AgentTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  invoke(commands: Commands, input: unknown): Promise<unknown>;
}

/**
 * The agent-tool projection, with no extra bridge: the same declarations that
 * drive the menus drive an agent, because the payload carries resolved locations
 * and the JSON Schema comes off the declaration itself.
 *
 * Panel-scoped commands are NOT projected. An agent has no panel, so a `panelId`
 * is not its to supply, and a command addressed to a panel that does not exist
 * rejects as `not-claimed` — a confusing answer to give a caller that never had
 * one.
 */
export async function agentTools(registry: CommandsRegistry): Promise<AgentTool[]> {
  const tools: AgentTool[] = [];
  for (const decl of registry.list()) {
    if (!decl.key.startsWith("files:")) continue;
    tools.push({
      name: decl.key,
      description: decl.label,
      inputSchema: await decl.inputJsonSchema,
      invoke: (commands, input) =>
        commands.call(decl as CommandDeclaration<unknown, unknown>, input).promise,
    });
  }
  return tools;
}

/**
 * Asks the host which of the file commands apply to this selection.
 *
 * **When no handler claims it, the whole namespace is offered.** That is not a
 * fallback for convenience: it is what keeps applicability policy entirely
 * host-side, so the app never grows a MIME table of its own.
 */
export async function resolveActions(commands: Commands, files: FileRef[]): Promise<ActionKey[]> {
  try {
    const { actions } = await commands.call(filesResolveActions, { files }).promise;
    return actions;
  } catch (err) {
    const kind = err instanceof CommandError ? err.kind : undefined;
    if (kind === "no-handlers" || kind === "not-claimed") return [...ACTION_KEYS];
    throw err;
  }
}
