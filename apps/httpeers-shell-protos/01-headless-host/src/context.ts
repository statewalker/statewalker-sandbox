// DERIVED-FROM-NOTE: 11-Prototype 1 API Reference.md §1 (HostContext,
// AppIdentity, newShellContext, newAppContext, the five adapter pairs and
// their keys and scopes)
// DERIVED-FROM-NOTE: 10-Prototype 1 Functional Description.md §4 "Startup" and
// "Per-application context" (what newShellContext populates; why an app reading
// `shell:commands` gets the *same bus instance*; why `shell:app` does not leak up)
//
// RECONSTRUCTED, NOT RECOVERED.

import { newAdapter } from "@statewalker/shared-adapters";
import {
  Commands,
  CommandsRegistry,
  type MutableCommandsRegistry,
} from "@statewalker/shared-commands";
import { Slots } from "@statewalker/shared-slots";
import { shellCommands } from "./commands.js";
import { type Enablement, factSetEnablement } from "./enablement.js";

/**
 * The host context. Passed untyped — it is a plain object — and accessed typed,
 * through the adapters below. `parent` is the inheritance chain.
 */
export interface HostContext {
  parent?: HostContext;
  [key: string]: unknown;
}

/**
 * An application's identity.
 *
 * `origin` is an **opaque URL**. The host is provenance-blind: a remote HTTPS
 * host and a peer-backed local endpoint travel the same path, and nothing in
 * the shell branches on which it is.
 */
export interface AppIdentity {
  readonly id: string;
  readonly origin: string;
}

// === Adapters =====================================================
//
// `newAdapter` returns [get, set, remove]; the shell only ever needs the first
// two. The default `getParent` walks `.parent`, which is what makes the four
// shell-scoped adapters inherited by every application context.
//
// Getters throw `Adapter not found: {key}` when unset. `undefined` counts as
// unset — store `null` for "present but empty".

const [getCommands, setCommands] = newAdapter<Commands, HostContext>("shell:commands");
const [getRegistry, setRegistry] = newAdapter<CommandsRegistry, HostContext>("shell:registry");
const [getSlots, setSlots] = newAdapter<Slots, HostContext>("shell:slots");
const [getEnablement, setEnablement] = newAdapter<Enablement, HostContext>("shell:enablement");

// App identity is app-local: `getParent` returns undefined, so a lookup never
// climbs the chain. Reading `shell:app` from the shell context throws.
const [getApp, setApp] = newAdapter<AppIdentity, HostContext>(
  "shell:app",
  undefined,
  () => undefined,
);

export {
  getApp,
  getCommands,
  getEnablement,
  getRegistry,
  getSlots,
  setApp,
  setCommands,
  setEnablement,
  setRegistry,
  setSlots,
};

/**
 * Build the shell context: a plain object populated with four adapters — a
 * `Commands` bus, a `Slots` bus, a `factSetEnablement()` evaluator, and a
 * `CommandsRegistry` seeded with the four shell standard-library commands.
 */
export function newShellContext(): HostContext {
  const ctx: HostContext = {};
  setCommands(ctx, Commands.create());
  setSlots(ctx, new Slots());
  setEnablement(ctx, factSetEnablement());
  const registry: MutableCommandsRegistry = CommandsRegistry.create(...shellCommands);
  setRegistry(ctx, registry);
  return ctx;
}

/**
 * Build a per-application context: `{ parent: shell }` plus a local
 * `shell:app` entry. Because the shell adapters walk `.parent`, an application
 * reading `shell:commands` receives the *same bus instance* as the shell.
 * Identity does not leak upward.
 */
export function newAppContext(parent: HostContext, app: AppIdentity): HostContext {
  const ctx: HostContext = { parent };
  setApp(ctx, app);
  return ctx;
}
