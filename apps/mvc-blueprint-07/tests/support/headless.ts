import { headless, workbenchReact } from "../../src/apps/manifests.js";
import { setContactApi } from "../../src/bundles/contacts/api/index.js";
import { createMemContactApi } from "../../src/bundles/contacts.core/mem-api.js";
import {
  dialogsSlot,
  headerSlot,
  menuSlot,
  notificationsSlot,
  panelsSlot,
  setNotificationTimeout,
} from "../../src/bundles/shell/api/index.js";
import {
  setTitleValidator,
  setTodoApi,
  type TitleValidator,
} from "../../src/bundles/todos/api/index.js";
import { createMemTodoApi } from "../../src/bundles/todos.core/mem-api.js";
import type { Context } from "../../src/kernel/context.js";
import { type ApplicationManifest, application } from "../../src/kernel/loader.js";
import { getIntentLog } from "../../src/kernel/log.js";
import { createLogger, setLogger } from "../../src/kernel/logger.js";
import { getSlots } from "../../src/kernel/slots.js";

export const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

export interface Options {
  todoDelay?: number;
  contactDelay?: number;
  validator?: TitleValidator;
  notificationTimeout?: number;
  setup?: (context: Context) => void;
}

/** Starts an application headless on a fresh context with injectable apis; returns probes. */
export async function start(
  manifest: ApplicationManifest = headless(workbenchReact),
  options: Options = {},
) {
  const context: Context = {};
  const logger = createLogger({ quiet: true });
  setLogger(context, logger);
  const todoApi = createMemTodoApi({ delay: options.todoDelay });
  const contactApi = createMemContactApi({ delay: options.contactDelay });
  setTodoApi(context, todoApi);
  setContactApi(context, contactApi);
  setNotificationTimeout(context, options.notificationTimeout ?? 60_000);
  if (options.validator) setTitleValidator(context, options.validator);
  options.setup?.(context);
  const stop = (await application(manifest)(context)) ?? (async () => {});
  const slots = getSlots(context);
  const log = getIntentLog(context);
  await log.idle();
  const panel = <M>(id: string) => slots.get(panelsSlot, id)?.model as M | undefined;
  const dialog = <M>(id: string) => slots.get(dialogsSlot, id)?.model as M | undefined;
  const menu = (label: string) =>
    slots.getSnapshot(menuSlot).find((m) => m.action.getState().label === label)?.action;
  const header = () => slots.getSnapshot(headerSlot).map((h) => h.model.getState().text);
  const toasts = () => slots.getSnapshot(notificationsSlot).map((n) => n.model.getState());
  const errors = () => logger.entries().filter((e) => e.level === "error");
  return {
    context,
    slots,
    log,
    logger,
    todoApi,
    contactApi,
    stop,
    panel,
    dialog,
    menu,
    header,
    toasts,
    errors,
  };
}
export type Probe = Awaited<ReturnType<typeof start>>;
