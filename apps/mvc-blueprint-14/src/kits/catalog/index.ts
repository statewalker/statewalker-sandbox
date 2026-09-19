import { type Catalog, defineCatalog, defineSchema } from "@json-render/core";
import { type ZodType, z } from "zod";

/**
 * The catalog kit (J1): turns the definitions contributed to `ui:catalog` and `agent:actions` into
 * a json-render `Catalog` (prompt + validation), and the prop helpers a definition uses.
 *
 * json-render's schema is copied from `@json-render/react/schema` with three changes:
 * - **no built-in actions** (`setState`, `pushState`, `removeState`, `validateForm` never reach a
 *   prompt; research §6.4);
 * - `on` / `watch` / `state` are kept on the element and the spec (the React schema strips them
 *   silently on `validate`, so a validated spec would lose its events) — the agent's policy checks
 *   them;
 * - components declare the `events` they emit.
 */
export const agentSchema = defineSchema(
  (s) => ({
    spec: s.object({
      root: s.string(),
      elements: s.record(
        s.object({
          type: s.ref("catalog.components"),
          props: s.propsOf("catalog.components"),
          children: s.array(s.string()),
          visible: { ...s.any(), ...s.optional() },
          repeat: { ...s.any(), ...s.optional() },
          on: { ...s.any(), ...s.optional() },
          watch: { ...s.any(), ...s.optional() },
        }),
      ),
      state: { ...s.any(), ...s.optional() },
    }),
    catalog: s.object({
      components: s.map({
        props: s.zod(),
        slots: s.array(s.string()),
        events: s.array(s.string()),
        description: s.string(),
      }),
      actions: s.map({
        params: s.zod(),
        description: s.string(),
      }),
    }),
  }),
  {
    builtInActions: [],
    defaultRules: [
      'Every element MUST include a "children" array; leaves use [].',
      'Inputs bind with {"$bindState":"/form/<field>"} and every such field MUST be seeded with a /state/form/<field> patch.',
      'Read-only application data lives under /data (see DATA); read it with {"$state":"/data/..."}. Never write /data.',
      'Actions go on the element: "on": {"press": {"action": "<name>", "params": {...}}}. Params are literals or {"$state": "/form/..."} / {"$state": "/data/..."}. Bind each action at most once.',
      "Never use watch, onSuccess, onError, confirm or action lists.",
      // The default prompt teaches built-ins even when `builtInActions` is empty; override it.
      "IMPORTANT: setState, pushState, removeState and validateForm DO NOT EXIST here; the rules above that mention them do not apply. Use only the AVAILABLE ACTIONS.",
    ],
  },
);

/** A read of the state tree, the only expression a plain prop accepts. */
const stateRead = z.object({ $state: z.string() }).strict();
/** A two-way binding into the form group. */
const stateBind = z.object({ $bindState: z.string() }).strict();

/**
 * A prop that may be a literal or a `$state` read. json-render's `catalog.validate` checks props
 * against the raw Zod type, so a plain `z.string()` REJECTS `{ "$state": … }` — its own docs'
 * example does not validate. Every dynamic prop must say so.
 */
export const dyn = <T extends ZodType>(type: T) => z.union([type, stateRead]);
/** A prop that may also be bound two-way (`$bindState`) — Input, Select, Checkbox. */
export const bindable = <T extends ZodType>(type: T) => z.union([type, stateRead, stateBind]);

/** A component definition as contributed to `ui:catalog` (technology-neutral). */
export interface ComponentDef {
  readonly props: ZodType;
  readonly slots: readonly string[];
  readonly events: readonly string[];
  readonly description: string;
}
/** An action definition: its params schema and what it does. */
export interface ActionDef {
  readonly params: ZodType;
  readonly description: string;
}

export type AgentCatalog = Catalog;

/** Aggregates contributions (keyed by name) into one catalog. Called again when a slot changes. */
export function buildCatalog(
  components: ReadonlyMap<string, ComponentDef>,
  actions: ReadonlyMap<string, ActionDef>,
): AgentCatalog {
  const sorted = <T>(m: ReadonlyMap<string, T>) =>
    Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)));
  return defineCatalog(agentSchema, {
    components: sorted(components) as never,
    actions: sorted(actions) as never,
  });
}
