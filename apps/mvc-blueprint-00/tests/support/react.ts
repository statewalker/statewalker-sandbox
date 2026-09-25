import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * DOM plumbing for the browser rungs (B5+). Nothing here knows a view, a model
 * or the bus — it mounts a React element and waits for the DOM to agree.
 */

/** A real event-loop turn — React commits and store updates land asynchronously. */
export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Polls rather than counting fixed ticks: how many turns React needs to settle
 * a commit is an implementation detail, and jittery on a cold Chromium worker.
 */
export async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await flush();
  }
}

/** A detached-from-nothing host under `document.body`, for a suite to mount into. */
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
