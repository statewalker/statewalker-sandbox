// DERIVED-FROM-NOTE: 11-Prototype 1 API Reference.md §6 (ProjectionMode,
// ProjectionPolicy, ProjectedTool, the three function signatures, `:` -> `__`,
// deny-by-default, `POST /commands/{key}` + `x-httpeers-projection`)
// DERIVED-FROM-NOTE: 07-Projection to OpenAPI and MCP Tools.md §2 and §4 (the
// field-by-field mapping table; the three modes and what each means)
//
// RECONSTRUCTED, NOT RECOVERED.
//
// Both entry points are async because `inputJsonSchema` is a lazily-derived
// Promise: `@statewalker/shared-commands` loads its schema-vendor adapters by
// dynamic import, so derivation is async-first.

import type { CommandsRegistry } from "@statewalker/shared-commands";

/**
 * - `tool` — safe to expose as an OpenAPI operation and an MCP tool.
 * - `ui-only` — human-invocable only: palette, menu, keybinding. Never a tool.
 * - `hazardous` — projectable but consequential; needs an explicit grant.
 */
export type ProjectionMode = "tool" | "ui-only" | "hazardous";

/**
 * A hand-written side table, so the shared package needs no httpeers-specific
 * field. Keys unlisted here are treated as `ui-only` — deny by default. It
 * should plausibly be derived from the manifest at build time; nothing derives
 * it yet.
 */
export type ProjectionPolicy = Readonly<Record<string, ProjectionMode>>;

/** One MCP tool descriptor. */
export interface ProjectedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly mode: ProjectionMode;
}

/**
 * Several MCP clients reject `:` in a tool name, so command keys are mapped to
 * `__`. The transformation round-trips.
 */
function toolNameFromCommandKey(key: string): string {
  return key.replaceAll(":", "__");
}

/** Inverse of the tool-name mapping. `shell__dialog__open` -> `shell:dialog:open`. */
export function commandKeyFromToolName(name: string): string {
  return name.replaceAll("__", ":");
}

function modeOf(policy: ProjectionPolicy, key: string): ProjectionMode {
  return policy[key] ?? "ui-only";
}

/**
 * Project a registry into MCP tool descriptors.
 *
 * `ui-only` commands are never projected. `hazardous` commands are withheld
 * unless `includeHazardous` is explicitly passed: an agent's default tool list
 * contains only what was opted in as `tool`.
 */
export async function projectToTools(
  registry: CommandsRegistry,
  policy: ProjectionPolicy,
  opts?: { includeHazardous?: boolean },
): Promise<ProjectedTool[]> {
  const includeHazardous = opts?.includeHazardous ?? false;
  const out: ProjectedTool[] = [];
  for (const decl of registry.list()) {
    const mode = modeOf(policy, decl.key);
    if (mode === "ui-only") continue;
    if (mode === "hazardous" && !includeHazardous) continue;
    const [inputSchema, outputSchema] = await Promise.all([
      decl.inputJsonSchema,
      decl.outputJsonSchema,
    ]);
    out.push({
      name: toolNameFromCommandKey(decl.key),
      description: decl.description ?? decl.label ?? decl.key,
      inputSchema,
      outputSchema,
      mode,
    });
  }
  return out;
}

/**
 * Project a registry into an OpenAPI document.
 *
 * Commands are actions, so POST is the honest verb; no REST resource modelling
 * is invented on top of a command bus. Each emitted operation carries the
 * `x-httpeers-projection` extension with its mode.
 *
 * NOTE — an inference, not something the notes state. The signature in
 * `11-Prototype 1 API Reference.md §6` has no `includeHazardous` option, yet
 * the same section says the OpenAPI document carries an extension "carrying
 * the mode". An extension is only informative if more than one mode can
 * appear, so `hazardous` operations are emitted here and labelled, while
 * `ui-only` is excluded. The withhold-unless-asked rule stays where the notes
 * put it: on the agent tool list.
 */
export async function projectToOpenApi(
  registry: CommandsRegistry,
  policy: ProjectionPolicy,
  info: { title: string; version: string },
): Promise<Record<string, unknown>> {
  const paths: Record<string, unknown> = {};
  for (const decl of registry.list()) {
    const mode = modeOf(policy, decl.key);
    if (mode === "ui-only") continue;
    const [inputSchema, outputSchema] = await Promise.all([
      decl.inputJsonSchema,
      decl.outputJsonSchema,
    ]);
    paths[`/commands/${decl.key}`] = {
      post: {
        operationId: decl.key,
        ...(decl.label !== undefined ? { summary: decl.label } : {}),
        ...(decl.description !== undefined
          ? { description: decl.description }
          : {}),
        "x-httpeers-projection": mode,
        requestBody: {
          required: true,
          content: { "application/json": { schema: inputSchema } },
        },
        responses: {
          "200": {
            description: "The command settled.",
            content: { "application/json": { schema: outputSchema } },
          },
        },
      },
    };
  }
  return { openapi: "3.1.0", info, paths };
}
