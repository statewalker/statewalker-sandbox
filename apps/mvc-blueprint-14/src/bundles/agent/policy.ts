import { type Spec, validateSpec } from "@json-render/core";
import type { AgentCatalog } from "@kit/catalog";
import type { ZodType } from "zod";

/**
 * What a generated spec may contain, beyond what `catalog.validate` checks (types and props):
 * the architecture's rules, enforced before anything renders.
 *
 * - `on`: one binding per event, a declared event, an allow-listed action (no built-in), params
 *   that are literals or reads of `/form` / `/data`, no `onSuccess` / `onError` / `confirm`
 *   (outcomes are owner state, ADR-013) — and each action bound at most once, so the action's
 *   capture is unambiguous;
 * - no `watch` (a side effect declared in the view, ADR-011);
 * - `$bindState` only onto `/form/<field>`; `$state` / `repeat` reads only under `/form` or `/data`;
 * - `state` seeds only `form`, and every bound field is seeded (checked when the stream ends).
 */

export interface PolicyContext {
  readonly catalog: AgentCatalog;
  /**
   * Component name → its props schema. `catalog.validate` does NOT check props once a catalog has
   * two or more components (json-render's `propsOf` falls back to `record(string, unknown)`), so
   * the policy parses them itself.
   */
  readonly props: ReadonlyMap<string, ZodType>;
  /** Component name → the events it declares. */
  readonly events: ReadonlyMap<string, readonly string[]>;
  /** The allow-list: action names contributed to `agent:actions`. */
  readonly actions: ReadonlySet<string>;
}

const READ_ROOT = /^\/(?:form|data)(?:\/|$)/;
const BIND = /^\/form\/[^/]+$/;
const BINDING_KEYS = new Set(["action", "params"]);

type Json = unknown;

/** Every `$state` / `$bindState` pointer in a props tree. */
function pointers(value: Json, out: { reads: string[]; binds: string[] }) {
  if (Array.isArray(value)) for (const v of value) pointers(v, out);
  else if (typeof value === "object" && value !== null) {
    const o = value as Record<string, unknown>;
    if (typeof o.$state === "string") out.reads.push(o.$state);
    if (typeof o.$bindState === "string") out.binds.push(o.$bindState);
    for (const v of Object.values(o)) pointers(v, out);
  }
  return out;
}

const zodIssues = (error: unknown): string[] => {
  const issues = (error as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  return issues
    ? issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`)
    : [String(error)];
};

/** Issues of one element, checked on its own (used while streaming). */
export function checkElement(key: string, element: Json, ctx: PolicyContext): string[] {
  const issues: string[] = [];
  const probe = ctx.catalog.validate({ root: key, elements: { [key]: element } });
  if (!probe.success) issues.push(...zodIssues(probe.error).map((m) => `${key}: ${m}`));
  if (typeof element !== "object" || element === null) return issues;
  const el = element as Record<string, unknown>;
  const propsSchema = ctx.props.get(String(el.type));
  if (propsSchema) {
    const parsed = propsSchema.safeParse(el.props ?? {});
    if (!parsed.success) issues.push(...zodIssues(parsed.error).map((m) => `${key}: props.${m}`));
  }
  if (el.watch !== undefined) issues.push(`${key}: "watch" is not allowed`);

  const { reads, binds } = pointers([el.props, el.visible], { reads: [], binds: [] });
  for (const p of reads)
    if (!READ_ROOT.test(p)) issues.push(`${key}: reads ${p} (only /form and /data)`);
  for (const p of binds) if (!BIND.test(p)) issues.push(`${key}: binds ${p} (only /form/<field>)`);
  const repeat = el.repeat as { statePath?: unknown } | undefined;
  if (repeat && !(typeof repeat.statePath === "string" && READ_ROOT.test(repeat.statePath)))
    issues.push(`${key}: repeat over ${JSON.stringify(repeat.statePath)} (only /form and /data)`);

  if (el.on !== undefined) {
    if (typeof el.on !== "object" || el.on === null) issues.push(`${key}: "on" must be an object`);
    else {
      const declared = ctx.events.get(String(el.type)) ?? [];
      for (const [event, binding] of Object.entries(el.on as Record<string, unknown>)) {
        if (!declared.includes(event))
          issues.push(`${key}: ${String(el.type)} emits no "${event}"`);
        if (typeof binding !== "object" || binding === null || Array.isArray(binding)) {
          issues.push(`${key}: on.${event} must be one binding (no action lists)`);
          continue;
        }
        const b = binding as Record<string, unknown>;
        for (const k of Object.keys(b))
          if (!BINDING_KEYS.has(k)) issues.push(`${key}: on.${event}.${k} is not allowed`);
        if (typeof b.action !== "string" || !ctx.actions.has(b.action))
          issues.push(`${key}: action ${JSON.stringify(b.action)} is not allow-listed`);
        const params = pointers(b.params ?? {}, { reads: [], binds: [] });
        for (const p of params.reads)
          if (!READ_ROOT.test(p)) issues.push(`${key}: param reads ${p}`);
        if (params.binds.length > 0) issues.push(`${key}: params cannot bind`);
      }
    }
  }
  return issues;
}

/** Issues of a partial spec while it streams: every element so far, and the state seed's shape. */
export function checkPartial(spec: Spec, ctx: PolicyContext): string[] {
  const issues: string[] = [];
  for (const [key, el] of Object.entries(spec.elements ?? {}))
    issues.push(...checkElement(key, el, ctx));
  const state = (spec as { state?: unknown }).state;
  if (state !== undefined) {
    if (typeof state !== "object" || state === null) issues.push(`state must be an object`);
    else
      for (const k of Object.keys(state))
        if (k !== "form") issues.push(`state.${k}: a spec may seed only /state/form`);
  }
  return issues;
}

/** Issues of the complete spec: the partial checks plus structure, uniqueness and seeding. */
export function checkComplete(spec: Spec, ctx: PolicyContext): string[] {
  const issues = checkPartial(spec, ctx);
  const whole = ctx.catalog.validate(spec);
  if (!whole.success) issues.push(...zodIssues(whole.error));
  for (const i of validateSpec(spec).issues)
    if (i.severity === "error") issues.push(`structure: ${i.message}`);
  const seeded = ((spec as { state?: { form?: object } }).state?.form ?? {}) as object;
  const bound = new Map<string, string>();
  for (const [key, el] of Object.entries(spec.elements ?? {})) {
    for (const p of pointers((el as { props?: unknown }).props, { reads: [], binds: [] }).binds) {
      const field = p.slice("/form/".length);
      if (!Object.hasOwn(seeded, field)) issues.push(`${key}: binds /form/${field}, never seeded`);
    }
    for (const binding of Object.values((el as { on?: object }).on ?? {})) {
      const name = (binding as { action?: string }).action ?? "";
      const other = bound.get(name);
      if (other) issues.push(`${key}: ${name} already bound by ${other}`);
      else bound.set(name, key);
    }
  }
  return [...new Set(issues)];
}
