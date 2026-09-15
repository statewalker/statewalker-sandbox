import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

/** A real event-loop turn — React commits and store updates land asynchronously. */
export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Polls rather than counting fixed ticks: how many turns React needs is an implementation detail. */
export async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await flush();
  }
}

/** A fresh element under `document.body`, for a suite to mount into. */
export function createHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

/** Renders `element` into a fresh host; `unmount()` removes both. */
export function render(element: ReactNode): { host: HTMLElement; root: Root; unmount(): void } {
  const host = createHost();
  const root = createRoot(host);
  root.render(element);
  return {
    host,
    root,
    unmount() {
      root.unmount();
      host.remove();
    },
  };
}

/** Every element under `scope` matching `selector`, as an array. */
export const all = <E extends Element = HTMLElement>(scope: ParentNode, selector: string): E[] => [
  ...scope.querySelectorAll<E>(selector),
];

/** The first button under `scope` whose visible text or aria-label is exactly `name`. */
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
