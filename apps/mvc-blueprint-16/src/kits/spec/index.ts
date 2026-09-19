import type { Expr, Handler, ViewSpec } from "@b/shell/api/spec";
import type { ActionView, KernelSlots, KeyedSlotDeclaration } from "@kernel";

/**
 * The technology-neutral half of every spec interpreter: name resolution, validation, expression
 * evaluation and handler dispatch. No DOM, no UI library. Interpreters supply how a group is read
 * (a cached snapshot, a signal) and what the triggering event carried.
 */

// biome-ignore lint/suspicious/noExplicitAny: a view model is looked up by name
export type AnyModel = any;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** `"draft.title"` → `["draft", ["title"]]`. */
export const splitPath = (path: string): [string, string[]] => {
  const [group, ...fields] = path.split(".");
  return [group as string, fields];
};
export const getterOf = (group: string) => `get${cap(group)}`;
export const subscriberOf = (group: string) => `on${cap(group)}Update`;

/** Reads a group's current value, once: `getX()`. */
export const readGroup = (model: AnyModel, group: string): unknown => model[getterOf(group)]();
/** The group's subscribe, or `undefined` for a constant group (a getter with no `onXUpdate`). */
export function subscribeOf(
  model: AnyModel,
  group: string,
): ((listener: () => void) => () => void) | undefined {
  const sub = model[subscriberOf(group)];
  return typeof sub === "function" ? sub : undefined;
}

// ── validation: a spec that names what the model does not offer fails loudly ────────────────
export class SpecError extends Error {}

const NODE_SHAPES = [
  ["el", "attrs", "on", "children"],
  ["text"],
  ["each", "children"],
  ["when", "children"],
  ["action"],
  ["actions", "label"],
];
const EXPR_OPS = ["read", "item", "event", "concat", "eq", "includes", "toggle", "if"];
const EVENTS = ["click", "input", "change", "submit"];
const TAGS = ["div", "p", "span", "ul", "li", "form", "input", "dl", "dt", "dd"];
const NOT_AN_INTENT = /^get[A-Z]|^on[A-Z].*Update$/;

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

function fail(at: string, message: string): never {
  throw new SpecError(`spec ${at}: ${message}`);
}

function checkGroup(model: AnyModel, group: string, at: string): void {
  if (typeof model[getterOf(group)] !== "function") fail(at, `the model has no group "${group}"`);
}

function checkAction(model: AnyModel, name: string, at: string): void {
  const a = model[name] as ActionView | undefined;
  if (!isObj(a) || typeof a.submit !== "function" || typeof a.getState !== "function")
    fail(at, `"${name}" is not an action of the model`);
}

function checkExpr(e: unknown, model: AnyModel, at: string): void {
  if (e === null || ["string", "number", "boolean"].includes(typeof e)) return;
  if (Array.isArray(e)) {
    for (const [i, x] of e.entries()) checkExpr(x, model, `${at}[${i}]`);
    return;
  }
  if (!isObj(e)) fail(at, "not an expression");
  const keys = Object.keys(e);
  const op = keys[0] as string;
  if (keys.length !== 1 || !EXPR_OPS.includes(op)) fail(at, `unknown expression {${keys}}`);
  if (op === "read") checkGroup(model, splitPath(String(e.read))[0], at);
  else if (op === "event" && !["value", "checked", "extend"].includes(String(e.event)))
    fail(at, `unknown event field "${e.event}"`);
  else if (op !== "item" && op !== "event") checkExpr(e[op], model, `${at}.${op}`);
}

function checkHandler(h: unknown, model: AnyModel, at: string): void {
  if (!isObj(h)) fail(at, "not a handler");
  const keys = Object.keys(h).sort().join(",");
  if (keys === "submit") {
    checkAction(model, String(h.submit), at);
    return;
  }
  if (keys !== "intent" && keys !== "args,intent")
    fail(at, `a handler is {intent, args?} or {submit}, not {${keys}}`);
  const name = String(h.intent);
  if (NOT_AN_INTENT.test(name) || typeof model[name] !== "function")
    fail(at, `"${name}" is not an intent of the model`);
  checkExpr(h.args ?? [], model, `${at}.args`);
}

function checkNode(n: unknown, model: AnyModel, at: string): void {
  if (typeof n === "string") return;
  if (!isObj(n)) fail(at, "not a node");
  const keys = Object.keys(n);
  const shape = NODE_SHAPES.find((s) => keys.includes(s[0] as string));
  if (!shape || keys.some((k) => !shape.includes(k))) fail(at, `unknown node {${keys}}`);
  for (const [i, c] of ((n.children as unknown[]) ?? []).entries())
    checkNode(c, model, `${at}/${i}`);
  if ("el" in n) {
    if (!TAGS.includes(String(n.el))) fail(at, `unknown tag "${n.el}"`);
    for (const [k, v] of Object.entries(n.attrs ?? {})) checkExpr(v, model, `${at}@${k}`);
    for (const [ev, hs] of Object.entries(n.on ?? {})) {
      if (!EVENTS.includes(ev)) fail(at, `unknown event "${ev}"`);
      for (const [i, h] of [hs].flat().entries()) checkHandler(h, model, `${at}!${ev}[${i}]`);
    }
  } else if ("text" in n) checkExpr(n.text, model, at);
  else if ("each" in n) checkExpr(n.each, model, at);
  else if ("when" in n) checkExpr(n.when, model, at);
  else if ("action" in n) checkAction(model, String(n.action), at);
  else checkGroup(model, String(n.actions), at);
}

/** Throws a `SpecError` naming the first node that uses the grammar wrongly or names nothing. */
export function validate(spec: ViewSpec, model: AnyModel): void {
  checkNode(spec.root, model, "root");
}

// ── static analysis ─────────────────────────────────────────────────────────────────────────
/** The groups an expression, node or whole spec reads — each subscribed once per mount. */
export function groupsOf(x: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(x)) for (const y of x) groupsOf(y, out);
  else if (isObj(x)) {
    if (typeof x.read === "string") out.add(splitPath(x.read)[0]);
    if (typeof x.actions === "string") out.add(x.actions);
    for (const v of Object.values(x)) groupsOf(v, out);
  }
  return out;
}

// ── evaluation ──────────────────────────────────────────────────────────────────────────────
export interface EventData {
  readonly value?: string;
  readonly checked?: boolean;
  readonly extend?: boolean;
}
export interface Scope {
  /** The group's current value (interpreter-owned: a cached snapshot or a signal). */
  read(group: string): unknown;
  readonly item?: unknown;
  readonly event?: EventData;
}

const at = (value: unknown, fields: readonly string[]) =>
  fields.reduce<unknown>(
    (v, f) => (v == null ? undefined : (v as Record<string, unknown>)[f]),
    value,
  );

export function evaluate(e: Expr, s: Scope): unknown {
  if (!isObj(e)) return Array.isArray(e) ? e.map((x) => evaluate(x, s)) : e;
  if ("read" in e) {
    const [group, fields] = splitPath(e.read);
    return at(s.read(group), fields);
  }
  if ("item" in e) return e.item === "." ? s.item : at(s.item, e.item.split("."));
  if ("event" in e) return s.event?.[e.event];
  if ("concat" in e) return e.concat.map((x) => text(evaluate(x, s))).join("");
  if ("eq" in e) return evaluate(e.eq[0], s) === evaluate(e.eq[1], s);
  if ("includes" in e)
    return ((evaluate(e.includes[0], s) as unknown[]) ?? []).includes(evaluate(e.includes[1], s));
  if ("toggle" in e) {
    const list = (evaluate(e.toggle[0], s) as unknown[]) ?? [];
    const v = evaluate(e.toggle[1], s);
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  }
  const [cond, then, otherwise = null] = e.if;
  return evaluate(evaluate(cond, s) ? then : otherwise, s);
}

export const text = (v: unknown): string => (v == null || v === false ? "" : String(v));

/** Runs a node's handlers in order, in this tick; each argument is evaluated when its handler runs. */
export function dispatch(handlers: Handler | readonly Handler[], model: AnyModel, s: Scope): void {
  for (const h of [handlers].flat() as Handler[]) {
    if ("submit" in h) (model[h.submit] as ActionView).submit();
    else model[h.intent](...(h.args ?? []).map((a) => evaluate(a, s)));
  }
}

// ── the interpreters' extension-point glue ──────────────────────────────────────────────────

/**
 * Mirrors one keyed slot into another through `convert`: each source entry is registered under
 * the same id, re-registered when it is replaced, withdrawn when it is withdrawn. Returns the
 * cleanup (stops observing, withdraws everything).
 */
export function mirror<S, T>(
  slots: Pick<KernelSlots, "observe" | "register">,
  from: KeyedSlotDeclaration<S>,
  to: KeyedSlotDeclaration<T>,
  convert: (source: S) => T,
): () => void {
  const live = new Map<string, { source: S; withdraw: () => void }>();
  const off = slots.observe(from, (entries) => {
    for (const [id, entry] of live) {
      if (entries.get(id) === entry.source) continue;
      entry.withdraw();
      live.delete(id);
    }
    for (const [id, source] of entries) {
      if (!live.has(id))
        live.set(id, { source, withdraw: slots.register(to, id, convert(source)) });
    }
  });
  return () => {
    off();
    for (const entry of live.values()) entry.withdraw();
    live.clear();
  };
}
