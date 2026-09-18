/**
 * The headless test shell: runs an application on a fresh ActorSystem and reads the `shell`
 * actor's streams the way a host would. It drives the app ONLY as a view could — by sending view
 * messages to a view's inbox and dispatching action descriptions.
 */
import { dialogs, header, menu, notifications, panels } from "../../src/bundles/shell/api/index.js";
import {
  type ActionDesc,
  type ActionItem,
  ActorSystem,
  type ApplicationManifest,
  application,
  type LogEntry,
} from "../../src/kernel/index.js";

export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await tick();
  }
}

export interface Harness {
  readonly system: ActorSystem;
  readonly logs: LogEntry[];
  errors(): LogEntry[];
  stop(): Promise<void>;
  panelIds(): string[];
  dialogIds(): string[];
  /** The state a renderer of this panel/dialog would receive. */
  view<S>(id: string): S | undefined;
  /** What a renderer's `send` does. */
  send(id: string, msg: unknown): void;
  /** What a host's `dispatch` does. */
  dispatch(action: ActionDesc | undefined): void;
  menuAction(label: string): ActionDesc | undefined;
  menuGroups(): string[];
  headerTexts(): string[];
  notes(): { message: string; tone: string; dismiss: ActionDesc }[];
}

export const findAction = (items: readonly ActionItem[] | undefined, label: string) =>
  items?.find((i) => i.action.label === label)?.action;

export async function start(
  manifest: ApplicationManifest,
  options: { cloneCheck?: boolean; system?: ActorSystem } = {},
): Promise<Harness> {
  const logs: LogEntry[] = [];
  const system =
    options.system ??
    new ActorSystem({ logSink: (e) => logs.push(e), cloneCheck: options.cloneCheck });
  const stop = await application(manifest)(system);
  const port = system.port("test-shell");
  const ref = (id: string) =>
    (port.get(panels.key) ?? []).find((p) => p.id === id)?.value ??
    (port.get(dialogs.key) ?? []).find((d) => d.id === id)?.value;
  const h: Harness = {
    system,
    logs,
    errors: () => logs.filter((l) => l.level === "error"),
    stop,
    panelIds: () => (port.get(panels.key) ?? []).map((p) => p.id),
    dialogIds: () => (port.get(dialogs.key) ?? []).map((d) => d.id),
    view: <S>(id: string) => {
      const r = ref(id);
      return r ? (port.get(r.stream) as S | undefined) : undefined;
    },
    send: (id, msg) => {
      const r = ref(id);
      if (!r) throw new Error(`no view "${id}"`);
      port.send(r.inbox, msg);
    },
    dispatch: (action) => {
      if (!action) throw new Error("no such action");
      if (action.enabled) port.send(action.to, action.msg);
    },
    menuAction: (label) =>
      (port.get(menu.key) ?? []).find((m) => m.value.action.label === label)?.value.action,
    menuGroups: () => [...new Set((port.get(menu.key) ?? []).map((m) => m.value.groupLabel))],
    headerTexts: () => (port.get(header.key) ?? []).map((i) => i.value.text),
    notes: () => (port.get(notifications.key) ?? []).map((n) => n.value),
  };
  return h;
}
