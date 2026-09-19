import type { ComputedFunction } from "@json-render/core";

/**
 * `$computed` functions a spec may call. View arithmetic lives here, once, for every technology;
 * each one is a domain-hit candidate and is counted as view logic.
 */
export const functions: Record<string, ComputedFunction> = {
  /** `{ $computed: "includes", args: { list, value } }` — is `value` in `list`? */
  includes: ({ list, value }) => Array.isArray(list) && list.includes(value),
  /** `{ $computed: "at", args: { map, key } }` — `map[key]` (an action's state by its id). */
  at: ({ map, key }) => (map as Record<string, unknown> | undefined)?.[String(key)],
};
