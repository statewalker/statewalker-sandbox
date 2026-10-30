/**
 * The slice of the SandClaw suite's runtime a Feature sees, as
 * sandclaw `apps/ui-protos.app/src/app/{runtime,contracts}.ts` define it
 * (sandclaw `d9b89ebd`). Copied, not imported: ui-protos is an app, not a
 * package. Views carry a `render` the shell calls; here it returns a plain
 * descriptor, so the Feature is testable without React.
 */

import {
  Commands,
  CommandsRegistry,
  type MutableCommandsRegistry,
} from "@statewalker/shared-commands";
import { defineKeyedSlot, defineSlot, Slots } from "@statewalker/shared-slots";

export interface AppRuntime {
  slots: Slots;
  commands: Commands;
  /** Every command some Feature handles: a menu item naming any other is a bug. */
  handled: MutableCommandsRegistry;
}

export function createRuntime(): AppRuntime {
  return { slots: new Slots(), commands: Commands.create(), handled: CommandsRegistry.create() };
}

export interface Feature {
  id: string;
  label: string;
  contribute(rt: AppRuntime): () => void;
}

export interface AppView {
  id: string;
  title: string;
  zone: "left" | "center" | "right" | "bottom";
  render(): unknown;
}

export interface AppMenuItem {
  id: string;
  menu: string;
  label: string;
  order: number;
  /** The command the item runs, and its payload. */
  command: string;
  payload?: unknown;
}

export const appViewsSlot = defineKeyedSlot<AppView>("app:views");
export const menuItemsSlot = defineSlot<AppMenuItem>("app:menu-items");

export function all(...disposers: Array<() => void>): () => void {
  return () => {
    for (const dispose of [...disposers].reverse()) dispose();
  };
}
