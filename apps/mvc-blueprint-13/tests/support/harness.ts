import {
  type DialogContribution,
  dialogsSlot,
  headerSlot,
  menuSlot,
  notificationsSlot,
  type PanelContribution,
  panelsSlot,
  shellCoverage,
} from "@p5/shell/api";
import { reactRenderersSlot } from "@p5/shell/api/react";
import { headlessShell } from "@p5/shell.test";
import {
  type ApplicationManifest,
  application,
  type Context,
  configAdapter,
  type FeatureManifest,
  getSlots,
  type KernelSlots,
  loggerAdapter,
} from "@p5/kernel";
import { byOrder } from "@p5/kit-slots";
import {
  contacts,
  hello,
  todos,
  todosContacts,
  todosStatusFeature,
} from "../../src/features/logic.js";
import { contactsReact, helloReact, todosReact } from "../../src/features/react.js";
import { type LoggedCall, newRecordingLogger } from "./logging.js";

/** The headless test shell as a feature, checking coverage against the React renderer slot. */
export const headlessShellFeature: FeatureManifest = {
  id: "shell",
  bundles: [
    {
      id: "shell.test",
      activator: headlessShell(reactRenderersSlot),
      provides: ["shell:coverage"],
    },
  ],
};

/** The workbench's features, headless. */
export const workbenchHeadless: ApplicationManifest = {
  id: "workbench.headless",
  features: [
    headlessShellFeature,
    todos,
    todosStatusFeature,
    todosReact,
    contacts,
    contactsReact,
    todosContacts,
    hello,
    helloReact,
  ],
};

export const todosHeadless: ApplicationManifest = {
  id: "todos.headless",
  features: [headlessShellFeature, todos, todosStatusFeature, todosReact],
};

export const contactsHeadless: ApplicationManifest = {
  id: "contacts.headless",
  features: [headlessShellFeature, contacts, contactsReact],
};

export interface Running {
  readonly context: Context;
  readonly slots: KernelSlots;
  readonly logs: LoggedCall[];
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Services set on the context before activation (e.g. `todos:api`). */
  readonly services?: Record<string, unknown>;
  readonly config?: Record<string, unknown>;
}

/** Activates `manifest` on a fresh context with a recording logger. */
export async function start(
  manifest: ApplicationManifest,
  options: StartOptions = {},
): Promise<Running> {
  const context: Context = { ...options.services };
  const { logger, calls } = newRecordingLogger();
  loggerAdapter.set(context, logger);
  configAdapter.set(
    context,
    Object.freeze({ "shell:notification-timeout-ms": 60_000, ...options.config }),
  );
  const stop = (await application(manifest)(context)) ?? (async () => {});
  await settle();
  return {
    context,
    slots: getSlots(context),
    logs: calls,
    stop: async () => {
      await stop();
    },
  };
}

/** Lets microtasks and zero-delay timers run. */
export async function settle(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Polls `predicate` over real turns. */
export async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}

// ── reading the shell's slots, as a headless "screen" ───────────────────────────────────────
export const panel = <M>(slots: KernelSlots, id: string) =>
  slots.getSnapshot(panelsSlot).get(id) as PanelContribution<M> | undefined;
export const dialog = <M>(slots: KernelSlots, id: string) =>
  slots.getSnapshot(dialogsSlot).get(id) as DialogContribution<M> | undefined;
export const header = (slots: KernelSlots) =>
  byOrder(slots.getSnapshot(headerSlot)).map((h) => h.model.getState().text);
export const menu = (slots: KernelSlots) =>
  byOrder(slots.getSnapshot(menuSlot)).map((m) => ({
    group: m.groupLabel,
    label: m.action.getState().label,
    action: m.action,
  }));
export const menuItem = (slots: KernelSlots, label: string) => {
  const found = menu(slots).find((m) => m.label === label);
  if (!found) throw new Error(`no menu item "${label}"`);
  return found.action;
};
export const toasts = (slots: KernelSlots) =>
  slots.getSnapshot(notificationsSlot).map((n) => n.model.getState());
export const errorLogs = (logs: readonly LoggedCall[]) =>
  logs.filter((l) => l.level === "error" || l.level === "fatal");
export const coverageOf = (context: Context) => shellCoverage.get(context).getReport();
