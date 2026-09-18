import { startApp } from "../../src/apps/start.js";
import { setNotificationTimeout } from "../../src/bundles/shell/api/index.js";
import { setReactRoot } from "../../src/bundles/shell/api/react.js";
import type { Context } from "../../src/kernel/context.js";
import type { ApplicationManifest } from "../../src/kernel/loader.js";
import { getIntentLog } from "../../src/kernel/log.js";
import { createLogger, setLogger } from "../../src/kernel/logger.js";

export const flush = () => new Promise<void>((r) => setTimeout(r, 0));
export async function waitFor(predicate: () => boolean, what = "condition", ms = 1500) {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await flush();
  }
}
export const all = <E extends Element = HTMLElement>(scope: ParentNode, sel: string) => [
  ...scope.querySelectorAll<E>(sel),
];
export const button = (scope: ParentNode, name: string) =>
  all<HTMLButtonElement>(scope, "button").find(
    (b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name,
  );
export async function click(scope: ParentNode, name: string, init?: MouseEventInit) {
  await waitFor(
    () => Boolean(button(scope, name) && !button(scope, name)?.disabled),
    `enabled "${name}"`,
  );
  button(scope, name)?.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init }));
  await flush();
}
export function typeInto(input: Element | null | undefined, value: string) {
  if (!(input instanceof HTMLInputElement)) throw new Error("typeInto: not an input");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
export const input = (scope: ParentNode, label: string) =>
  scope.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
export const text = (el: Element | null | undefined) =>
  el?.textContent?.replace(/\s+/g, " ").trim() ?? "";

/** Mounts an application in a fresh element. */
export async function mount(manifest: ApplicationManifest, setup?: (c: Context) => void) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const logger = createLogger({ quiet: true });
  const app = await startApp(manifest, host, (context) => {
    setLogger(context, logger);
    setNotificationTimeout(context, 60_000);
    setup?.(context);
  });
  await waitFor(() => host.querySelector(".shell") !== null, "the shell");
  return {
    ...app,
    host,
    logger,
    log: getIntentLog(app.context),
    errors: () => logger.entries().filter((e) => e.level === "error"),
    async unmount() {
      await app.stop();
      host.remove();
    },
  };
}
export { setReactRoot };
