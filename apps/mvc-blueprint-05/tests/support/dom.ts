/** Browser helpers for the e2e suites (real DOM, real React). */
import { contactsStandalone, todosStandalone, workbenchReact } from "../../src/apps/index.ts";
import { ROOT_KEY } from "../../src/bundles/shell.react/index.tsx";
import {
  type ApplicationManifest,
  application,
  type Context,
  createLogger,
  type FeatureManifest,
  getStore,
  type LogRecord,
  type Store,
  setLogger,
} from "../../src/kernel/index.ts";

export { contactsStandalone, todosStandalone, workbenchReact };

export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
export async function waitFor(
  predicate: () => boolean,
  what = "condition",
  ms = 2000,
): Promise<void> {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > ms) throw new Error(`waitFor timed out: ${what}`);
    await flush();
  }
}

export interface Running {
  host: HTMLElement;
  context: Context;
  store: Store;
  logs: LogRecord[];
  errors(): LogRecord[];
  stop(): Promise<void>;
}

export async function run(
  manifest: ApplicationManifest,
  inject: Record<string, unknown> = {},
): Promise<Running> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const logs: LogRecord[] = [];
  const context: Context = { ...inject, [ROOT_KEY]: host };
  setLogger(
    context,
    createLogger((r) => logs.push(r)),
  );
  const stop = await application(manifest)(context);
  return {
    host,
    context,
    store: getStore(context),
    logs,
    errors: () => logs.filter((l) => l.level === "error"),
    async stop() {
      await stop?.();
      host.remove();
    },
  };
}

export const without = (manifest: ApplicationManifest, ...ids: string[]): ApplicationManifest => ({
  ...manifest,
  features: manifest.features.filter((f) => !ids.includes(f.id)),
});
export const withoutBundle = (
  manifest: ApplicationManifest,
  bundle: string,
): ApplicationManifest => ({
  ...manifest,
  features: manifest.features.map(
    (f): FeatureManifest => ({ ...f, bundles: f.bundles.filter((b) => b.id !== bundle) }),
  ),
});

export const all = <E extends Element = HTMLElement>(scope: ParentNode, selector: string): E[] => [
  ...scope.querySelectorAll<E>(selector),
];
export const text = (el: Element | null | undefined) => el?.textContent?.trim() ?? "";
export function button(scope: ParentNode, name: string): HTMLButtonElement {
  const b = all<HTMLButtonElement>(scope, "button").find(
    (x) => x.textContent?.trim() === name || x.getAttribute("aria-label") === name,
  );
  if (!b) throw new Error(`no button "${name}"`);
  return b;
}
export const hasButton = (scope: ParentNode, name: string) =>
  all<HTMLButtonElement>(scope, "button").some((x) => x.textContent?.trim() === name);
export function typeInto(input: Element | null | undefined, value: string): void {
  if (!(input instanceof HTMLInputElement)) throw new Error("typeInto: not an input");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
export const input = (scope: ParentNode, label: string) =>
  scope.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
export const panel = (scope: ParentNode, id: string) =>
  scope.querySelector<HTMLElement>(`[data-panel="${id}"]`);
export const header = (scope: ParentNode) => all(scope, "[data-header-item]").map(text);
export const toasts = (scope: ParentNode) => all(scope, "[role=status] span").map(text);
export const menuGroups = (scope: ParentNode) =>
  all(scope, "nav[aria-label='Main menu'] summary").map(text);
export function menu(scope: ParentNode, label: string): HTMLButtonElement {
  const item = all<HTMLButtonElement>(scope, "[role=menuitem]").find((b) => text(b) === label);
  if (!item) throw new Error(`no menu item "${label}"`);
  return item;
}
export function tab(scope: ParentNode, title: string): void {
  button(scope, title).click();
}
export const rows = (scope: ParentNode) =>
  all(scope, "ul[aria-label=Todos] li").map((li) => {
    const box = li.querySelector<HTMLInputElement>("input[type=checkbox]");
    return `${box?.checked ? "x" : " "} ${text(li.querySelector("button"))}`;
  });
export function clickTodo(scope: ParentNode, title: string, ctrl = false): void {
  const b = all(scope, "ul[aria-label=Todos] li button").find((x) => text(x) === title);
  if (!b) throw new Error(`no todo "${title}"`);
  b.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: ctrl }));
}
