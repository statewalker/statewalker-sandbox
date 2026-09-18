/** Browser helpers: start an application into a fresh DOM host; query it like a user. */
import type { ApplicationManifest, LogEntry } from "../../src/kernel/index.js";
import { ActorSystem, application } from "../../src/kernel/index.js";

export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await flush();
  }
}

export const all = <E extends Element = HTMLElement>(scope: ParentNode, selector: string): E[] => [
  ...scope.querySelectorAll<E>(selector),
];

export function button(scope: ParentNode, name: string): HTMLButtonElement | undefined {
  return all<HTMLButtonElement>(scope, "button").find(
    (b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name,
  );
}

/** Types into a React-controlled input: the native setter, then the `input` event React listens to. */
export function typeInto(input: Element | null | undefined, value: string): void {
  if (!(input instanceof HTMLInputElement)) throw new Error("typeInto: not an input");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export interface RunningApp {
  readonly root: HTMLElement;
  readonly system: ActorSystem;
  readonly logs: LogEntry[];
  errors(): LogEntry[];
  stop(): Promise<void>;
}

export async function run(make: (root: HTMLElement) => ApplicationManifest): Promise<RunningApp> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const logs: LogEntry[] = [];
  const system = new ActorSystem({ logSink: (e) => logs.push(e) });
  const stop = await application(make(root))(system);
  return {
    root,
    system,
    logs,
    errors: () => logs.filter((l) => l.level === "error"),
    async stop() {
      await stop();
      root.remove();
    },
  };
}

/** Page-object style queries over the React shell. */
export const ui = (root: HTMLElement) => ({
  titles: () => all(root, "[data-todo] span").map((s) => s.textContent),
  row: (title: string) => all(root, "[data-todo]").find((li) => li.textContent?.includes(title)),
  panel: (id: string) => root.querySelector<HTMLElement>(`[data-panel="${id}"]`),
  dialog: () => root.querySelector<HTMLElement>('[role="dialog"]'),
  header: () => all(root, "[data-header-item]").map((h) => h.textContent),
  menuGroups: () => all(root, "[data-menu-group] > summary").map((s) => s.textContent),
  menuItem: (label: string) =>
    all<HTMLButtonElement>(root, '[role="menuitem"]').find((b) => b.textContent === label),
  toasts: () => all(root, "[data-notification] [role]").map((t) => t.textContent ?? ""),
  tab: (title: string) =>
    all<HTMLButtonElement>(root, '[role="tab"]').find((t) => t.textContent === title),
  contact: (name: string) =>
    all<HTMLButtonElement>(root, "[data-contact]").find((b) => b.textContent === name),
});
