// DERIVED-FROM-NOTE: 11-Prototype 1 API Reference.md §2 (the four contribution
// types, the four slot declarations and their keys, plain vs keyed)
// DERIVED-FROM-NOTE: 03-The VS Code Contribution Model.md §3 (one plain slot
// with `location` as an open-ended string, not one slot per menu location; a
// separate numeric `order` instead of VS Code's `group@N`)
//
// RECONSTRUCTED, NOT RECOVERED.
//
// Slots are for what is contributed *and enumerated*. Menu items, views,
// status items and keybindings are all listed by the shell at render time, so
// they are slots. Notifications and dialogs are not — see commands.ts.

import { defineKeyedSlot, defineSlot } from "@statewalker/shared-slots";

/**
 * A menu contribution.
 *
 * Nothing here is resolved at registration time: `command` is an unresolved
 * `CommandDeclaration` key and `when` is an unevaluated string. That split
 * between registration time and render time is the load-bearing design — it is
 * what lets a static, build-time-generated manifest behave dynamically.
 *
 * `location` is open-ended. An app declares a location simply by rendering
 * one; any other app contributes by naming it. There is no registry of
 * locations to keep in sync.
 */
export interface MenuItem {
  readonly location: string;
  readonly command: string;
  /** `"navigation"` pins first; other groups sort lexicographically. */
  readonly group?: string;
  readonly order?: number;
  readonly args?: unknown;
  readonly when?: string;
}

/**
 * A view contribution.
 *
 * `root` is typed `unknown` because prototype 1 is headless — there is no DOM
 * to narrow it to. **Prototype 2 must narrow this.**
 *
 * `View` carries no `id` field: the id is a separate argument to
 * `slots.register`, because `viewsSlot` is a keyed slot.
 */
export interface View {
  readonly title: string;
  readonly icon?: string;
  readonly preferredSurface?: "main" | "sidebar" | "panel";
  mount(root: unknown, ctx: object): void | (() => void);
}

/** A status-bar contribution. */
export interface StatusItem {
  readonly text: string;
  readonly command?: string;
  readonly alignment?: "left" | "right";
  readonly priority?: number;
  readonly when?: string;
}

/**
 * A keybinding contribution. Declared at rung 1 but nothing consumes them yet
 * — recorded as an open thread, not as a feature.
 */
export interface Keybinding {
  readonly key: string;
  readonly command: string;
  readonly args?: unknown;
  readonly when?: string;
}

/** Plain slot: accumulates. `slots.provide(decl, value) -> dispose`. */
export const menuItemsSlot = defineSlot<MenuItem>("shell:menu-items");

/** Keyed slot: id-addressed. `slots.register(decl, id, value) -> dispose`. */
export const viewsSlot = defineKeyedSlot<View>("shell:views");

/** Plain slot. */
export const statusItemsSlot = defineSlot<StatusItem>("shell:status-items");

/** Plain slot. */
export const keybindingsSlot = defineSlot<Keybinding>("shell:keybindings");
