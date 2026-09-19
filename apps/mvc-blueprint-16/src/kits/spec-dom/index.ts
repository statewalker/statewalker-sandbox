import type { ElementNode, SpecNode, ViewSpec } from "@b/shell/api/spec";
import type { ActionContribution, ActionView } from "@kernel";
import { actionButton, h, newScope } from "@kit/dom";
import {
  type AnyModel,
  dispatch,
  type EventData,
  evaluate,
  groupsOf,
  readGroup,
  type Scope,
  subscribeOf,
  text,
  validate,
} from "@kit/spec";

/**
 * THE plain-DOM spec interpreter: `mountSpec(spec, host, model)` is a `DomRenderer.mount`.
 * One subscription per group the spec reads; a notification whose snapshot is `===` the cached
 * one does nothing (contract point 7); otherwise only the bindings that read that group re-run,
 * and each writes the DOM only when its value differs.
 */
type Owner = ReturnType<typeof newScope>;
interface Effect {
  readonly deps: Set<string>;
  readonly run: () => void;
  alive: boolean;
}

export function mountSpec(spec: ViewSpec, host: HTMLElement, model: AnyModel): () => void {
  validate(spec, model);
  const root = newScope();
  const cache = new Map<string, unknown>();
  const effects = new Set<Effect>();
  const read = (group: string) => cache.get(group);

  for (const group of groupsOf(spec.root)) {
    const subscribe = subscribeOf(model, group);
    const listener = () => {
      const value = readGroup(model, group);
      if (cache.has(group) && cache.get(group) === value) return;
      cache.set(group, value);
      for (const e of [...effects]) if (e.alive && e.deps.has(group)) e.run();
    };
    if (subscribe) root.own(subscribe(listener));
    if (!cache.has(group)) cache.set(group, readGroup(model, group));
  }

  /** A binding: runs now and whenever a group it reads changes, until its owner is disposed. */
  const effect = (owner: Owner, expr: unknown, run: () => void) => {
    const e: Effect = { deps: groupsOf(expr), run, alive: true };
    run();
    if (e.deps.size === 0) return;
    effects.add(e);
    owner.own(() => {
      e.alive = false;
      effects.delete(e);
    });
  };

  /** A region of `parent` between two anchors, replaced as a whole (nested regions included). */
  const region = (parent: Node, owner: Owner, build: (inner: Owner) => Node[]) => {
    const start = parent.appendChild(document.createComment(""));
    const end = parent.appendChild(document.createComment(""));
    const inner = newScope();
    owner.own(inner.dispose);
    return () => {
      inner.dispose();
      while (start.nextSibling && start.nextSibling !== end) start.nextSibling.remove();
      end.before(...build(inner));
    };
  };

  const node = (n: SpecNode, parent: Node, owner: Owner, s: Scope): void => {
    if (typeof n === "string") {
      parent.appendChild(document.createTextNode(n));
    } else if ("text" in n) {
      const t = parent.appendChild(document.createTextNode(""));
      effect(owner, n.text, () => {
        const v = text(evaluate(n.text, s));
        if (t.data !== v) t.data = v;
      });
    } else if ("el" in n) {
      parent.appendChild(element(n, owner, s));
    } else if ("each" in n) {
      const replace = region(parent, owner, (inner) =>
        ((evaluate(n.each, s) as unknown[]) ?? []).flatMap((item) =>
          fragment(n.children, inner, { read, item }),
        ),
      );
      effect(owner, n.each, replace);
    } else if ("when" in n) {
      let shown: boolean | undefined;
      const replace = region(parent, owner, (inner) =>
        shown ? fragment(n.children, inner, s) : [],
      );
      effect(owner, n.when, () => {
        const next = Boolean(evaluate(n.when, s));
        if (next === shown) return;
        shown = next;
        replace();
      });
    } else if ("action" in n) {
      const b = actionButton(model[n.action] as ActionView);
      owner.own(b.dispose);
      parent.appendChild(b.el);
    } else {
      const bar = h("div", {
        role: "toolbar",
        "aria-label": n.label,
        class: "flex flex-wrap gap-2",
      });
      parent.appendChild(bar);
      const replace = region(bar, owner, (inner) =>
        (read(n.actions) as readonly ActionContribution[]).map((c) => {
          const b = actionButton(c.action);
          inner.own(b.dispose);
          return b.el;
        }),
      );
      effect(owner, { read: n.actions }, replace);
    }
  };

  const fragment = (children: readonly SpecNode[], owner: Owner, s: Scope): Node[] => {
    const box = document.createDocumentFragment();
    for (const c of children) node(c, box, owner, s);
    return [...box.childNodes];
  };

  const element = (n: ElementNode, owner: Owner, s: Scope): HTMLElement => {
    const el = document.createElement(n.el);
    const controlled: (() => void)[] = [];
    for (const [name, expr] of Object.entries(n.attrs ?? {})) {
      const apply = () => setAttr(el, name, evaluate(expr, s));
      effect(owner, expr, apply);
      if (name === "value" || name === "checked") controlled.push(apply);
    }
    for (const [name, handlers] of Object.entries(n.on ?? {})) {
      el.addEventListener(name, (event) => {
        if (name === "submit") event.preventDefault();
        dispatch(handlers, model, { ...s, event: eventData(event) });
        for (const restore of controlled) restore();
      });
    }
    for (const c of n.children ?? []) node(c, el, owner, s);
    return el;
  };

  node(spec.root, host, root, { read });
  return () => {
    root.dispose();
    host.replaceChildren();
  };
}

function eventData(event: Event): EventData {
  const t = event.target as HTMLInputElement;
  const m = event as MouseEvent;
  return { value: t.value, checked: t.checked, extend: m.ctrlKey || m.metaKey };
}

/** Writes only on a difference: no mutation for an unchanged value. */
function setAttr(el: HTMLElement, name: string, v: unknown): void {
  const input = el as HTMLInputElement;
  if (name === "value") {
    if (input.value !== text(v)) input.value = text(v);
  } else if (name === "checked") {
    if (input.checked !== Boolean(v)) input.checked = Boolean(v);
  } else if (v == null || v === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else {
    const next = v === true ? "" : String(v);
    if (el.getAttribute(name) !== next) el.setAttribute(name, next);
  }
}
