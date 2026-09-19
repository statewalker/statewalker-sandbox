import {
  type DialogContribution,
  dialogsSlot,
  headerSlot,
  menuSlot,
  notificationsSlot,
  type PanelContribution,
  panelsSlot,
  shellCoverage,
} from "@b/shell/api";
import { viewSpecsSlot } from "@b/shell/api/spec";
import { headlessShell } from "@b/shell.test";
import {
  type ApplicationManifest,
  application,
  type Context,
  configAdapter,
  type FeatureManifest,
  getCommands,
  getSlots,
  type KernelCommands,
  type KernelSlots,
  loggerAdapter,
} from "@kernel";
import { byOrder } from "@kit/slots";
import {
  contacts,
  hello,
  todos,
  todosContacts,
  todosStatusFeature,
} from "../../src/features/logic.js";
import { contactsSpecs, helloSpecs, todosSpecs } from "../../src/features/ui.js";
import { type LoggedCall, newRecordingLogger } from "./logging.js";

/** The headless test shell as a feature, checking coverage against the view specs (J3: every kind has a spec). */
export const headlessShellFeature: FeatureManifest = {
  id: "shell",
  bundles: [
    {
      id: "shell.test",
      activator: headlessShell(viewSpecsSlot),
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
    todosSpecs,
    contacts,
    contactsSpecs,
    todosContacts,
    hello,
    helloSpecs,
  ],
};

export const todosHeadless: ApplicationManifest = {
  id: "todos.headless",
  features: [headlessShellFeature, todos, todosStatusFeature, todosSpecs],
};

export const contactsHeadless: ApplicationManifest = {
  id: "contacts.headless",
  features: [headlessShellFeature, contacts, contactsSpecs],
};

export interface Running {
  readonly context: Context;
  readonly slots: KernelSlots;
  readonly commands: KernelCommands;
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
    commands: getCommands(context),
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
