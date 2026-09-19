import type { ElementNode, SpecNode, ViewSpec } from "@b/shell/api/spec";
import type { ActionContribution, ActionView } from "@kernel";
import { ActionBar, ActionButton, useModel } from "@kit/solid";
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
import { type Component, For, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";

/**
 * THE Solid spec interpreter: `specComponent(spec)` is a `SolidRenderer.component`. Every group
 * the spec reads becomes one accessor, made once in the component's setup (never inside JSX);
 * the spec's expressions read those accessors, so Solid tracks exactly the bindings that use a
 * group. `each` is `<For>` (by reference: an unchanged todo keeps its row), `when` is `<Show>`.
 */
export function specComponent(spec: ViewSpec): Component<{ model: AnyModel }> {
  return (props) => {
    const model = props.model;
    validate(spec, model);
    const groups = new Map<string, () => unknown>();
    for (const g of groupsOf(spec.root)) {
      const subscribe = subscribeOf(model, g);
      groups.set(
        g,
        subscribe ? useModel(() => readGroup(model, g), subscribe) : () => readGroup(model, g),
      );
    }
    const s: Scope = { read: (g) => groups.get(g)?.() };
    return <N node={spec.root} model={model} scope={s} />;
  };
}

type P = { node: SpecNode; model: AnyModel; scope: Scope };

function N(p: P): JSX.Element {
  const { node: n, model, scope: s } = p;
  if (typeof n === "string") return n;
  if ("text" in n) return <>{text(evaluate(n.text, s))}</>;
  if ("el" in n) return <El node={n} model={model} scope={s} />;
  if ("each" in n)
    return (
      <For each={(evaluate(n.each, s) as readonly unknown[]) ?? []}>
        {(item) => <Kids nodes={n.children} model={model} scope={{ read: s.read, item }} />}
      </For>
    );
  if ("when" in n)
    return (
      <Show when={Boolean(evaluate(n.when, s))}>
        <Kids nodes={n.children} model={model} scope={s} />
      </Show>
    );
  if ("action" in n) return <ActionButton action={model[n.action] as ActionView} />;
  return <ActionBar items={s.read(n.actions) as readonly ActionContribution[]} label={n.label} />;
}

function Kids(p: { nodes: readonly SpecNode[]; model: AnyModel; scope: Scope }): JSX.Element {
  return p.nodes.map((c) => <N node={c} model={p.model} scope={p.scope} />);
}

function El(p: P & { node: ElementNode }): JSX.Element {
  const { node: n, model, scope: s } = p;
  const attrs: Record<string, unknown> = {};
  for (const [name, expr] of Object.entries(n.attrs ?? {})) {
    Object.defineProperty(attrs, name, {
      enumerable: true,
      get: () => domValue(name, evaluate(expr, s)),
    });
  }
  for (const [name, handlers] of Object.entries(n.on ?? {})) {
    attrs[`on:${name}`] = (event: Event) => {
      if (name === "submit") event.preventDefault();
      dispatch(handlers, model, { ...s, event: eventData(event) });
      // Controlled: the model decides; put back what it holds now.
      const input = event.currentTarget as HTMLInputElement;
      const { value, checked } = n.attrs ?? {};
      if (value !== undefined && input.value !== text(evaluate(value, s)))
        input.value = text(evaluate(value, s));
      if (checked !== undefined && input.checked !== Boolean(evaluate(checked, s)))
        input.checked = Boolean(evaluate(checked, s));
    };
  }
  return (
    <Dynamic component={n.el} {...attrs}>
      <Kids nodes={n.children ?? []} model={model} scope={s} />
    </Dynamic>
  );
}

function eventData(event: Event): EventData {
  const t = event.target as HTMLInputElement;
  const m = event as MouseEvent;
  return { value: t.value, checked: t.checked, extend: m.ctrlKey || m.metaKey };
}

/** `value`/`checked` are properties; `true` is a present attribute, `false`/`null` an absent one. */
function domValue(name: string, v: unknown): unknown {
  if (name === "value") return text(v);
  if (name === "checked") return Boolean(v);
  return v == null || v === false ? undefined : v === true ? "" : String(v);
}
