import type { ActionContribution, ActionView } from "@kernel";

/**
 * THE plain-DOM binding: a `subscribe` loop over one model group. `render(value)` runs at once
 * (contract point 1) and on every change, synchronously. Returns the unsubscribe.
 */
export function bind<T>(
  read: () => T,
  subscribe: (listener: () => void) => () => void,
  render: (value: T) => void,
): () => void {
  return subscribe(() => render(read()));
}

type Attrs = Record<string, string | boolean | undefined | ((event: Event) => void)>;

/** A tiny element builder: `h("button", { type: "button", onclick: … }, "Save")`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (typeof value === "function") el.addEventListener(name.replace(/^on/, ""), value);
    else if (value === true) el.setAttribute(name, "");
    else if (typeof value === "string") el.setAttribute(name, value);
  }
  el.append(...children);
  return el;
}

/** A disposer list: `own(fn)` collects, `dispose()` runs them in reverse. */
export function newScope() {
  const disposers: (() => void)[] = [];
  return {
    own<T extends () => void>(dispose: T): T {
      disposers.push(dispose);
      return dispose;
    },
    dispose() {
      while (disposers.length > 0) disposers.pop()?.();
    },
  };
}

/** Any action as a button, kept in sync with its state. */
export function actionButton(action: ActionView, attrs: Attrs = {}) {
  const el = h("button", {
    type: "button",
    class: "rounded border px-3 py-1 text-sm disabled:opacity-50",
    ...attrs,
    onclick: () => action.submit(),
  });
  const dispose = bind(action.getState, action.onStateUpdate, (s) => {
    el.textContent = s.label;
    el.disabled = !s.enabled || s.running;
    el.setAttribute("aria-busy", String(s.running));
    if (s.hint) el.title = s.hint;
  });
  return { el, dispose };
}

/** A list of contributed actions as a toolbar; re-rendered when the list changes. */
export function actionBar(
  read: () => readonly ActionContribution[],
  subscribe: (listener: () => void) => () => void,
  label: string,
) {
  const el = h("div", { role: "toolbar", "aria-label": label, class: "flex flex-wrap gap-2" });
  const inner = newScope();
  const off = bind(read, subscribe, (items) => {
    inner.dispose();
    el.replaceChildren(
      ...items.map((c) => {
        const b = actionButton(c.action);
        inner.own(b.dispose);
        return b.el;
      }),
    );
  });
  return {
    el,
    dispose: () => {
      off();
      inner.dispose();
    },
  };
}

/** Sets an input's value only when it differs (keeps the caret while the user types). */
export function setValue(input: HTMLInputElement, value: string): void {
  if (input.value !== value) input.value = value;
}
