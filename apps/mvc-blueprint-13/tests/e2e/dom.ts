import { shellRoot } from "@p5/shell/api";
import {
  type ApplicationManifest,
  application,
  type Context,
  configAdapter,
  loggerAdapter,
} from "@p5/kernel";
import { newRecordingLogger } from "../support/logging.js";

/**
 * Technology-neutral DOM driving: the e2e scenarios see only the page, never a model, so the same
 * scenario runs against every UI technology. Waiting is by polling, never by counting ticks —
 * how many turns React needs to commit is its business; plain DOM needs none.
 */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 5));
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

export function click(el: Element | null | undefined, init: MouseEventInit = {}): void {
  if (!el) throw new Error("click: no element");
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
}

/** Types into an input the way a user does: the native setter, then an `input` event. */
export function typeInto(input: Element | null | undefined, value: string): void {
  if (!(input instanceof HTMLInputElement)) throw new Error("typeInto: not an input");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export interface Page {
  readonly root: HTMLElement;
  readonly context: Context;
  readonly errors: () => unknown[];
  stop(): Promise<void>;
}

export async function open(
  manifest: ApplicationManifest,
  services: Record<string, unknown> = {},
): Promise<Page> {
  const root = document.createElement("div");
  document.body.append(root);
  const context: Context = { ...services };
  const { logger, calls } = newRecordingLogger();
  loggerAdapter.set(context, logger);
  configAdapter.set(context, Object.freeze({ "shell:notification-timeout-ms": 60_000 }));
  shellRoot.set(context, root);
  const stop = await application(manifest)(context);
  return {
    root,
    context,
    errors: () => calls.filter((c) => c.level === "error" || c.level === "fatal"),
    async stop() {
      await stop?.();
      root.remove();
    },
  };
}
