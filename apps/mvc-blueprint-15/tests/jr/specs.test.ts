import { type JrView, jrViewsSlot } from "@b/shell/api/jr";
import { type Spec, validateSpec } from "@json-render/core";
import { catalog, modelStore } from "@kit/jr";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Running, start, workbenchHeadless } from "../support/harness.js";

/**
 * Every spec contributed to `ui.jr:views`: valid against the catalog, and consistent with its
 * model binding — every pointer it reads exists, every pointer it binds is a writable form field,
 * every action it invokes is a handler, every literal `submit` ref is an action of the view.
 * A spec is data; this suite is what type-checking is for code.
 */
let r: Running;
let views: [string, JrView<never>][];
beforeAll(async () => {
  r = await start(workbenchHeadless);
  views = [...r.slots.getSnapshot(jrViewsSlot)];
});
afterAll(() => r.stop());

/** A model stub: any `getX` returns [], any `onX` a no-op subscription, anything else a stub action. */
const stubModel = (): never =>
  new Proxy(
    {},
    {
      get: (_t, key) =>
        typeof key !== "string"
          ? undefined
          : key.startsWith("on")
            ? () => () => {}
            : key.startsWith("get")
              ? () => []
              : {
                  getState: () => ({ label: key, enabled: true, running: false }),
                  onStateUpdate: () => () => {},
                  submit() {},
                },
    },
  ) as never;

/** Walks a spec's props / params / conditions for `$state`, `$bindState`, `on` bindings. */
function refsOf(spec: Spec) {
  const reads: string[] = [];
  const binds: string[] = [];
  const invokes: { action: string; ref?: unknown }[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v === null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.$state === "string") reads.push(o.$state);
    if (typeof o.$bindState === "string") binds.push(o.$bindState);
    if (typeof o.$template === "string")
      for (const m of o.$template.matchAll(/\$\{(\/[^}]+)\}/g)) reads.push(m[1] as string);
    for (const x of Object.values(o)) walk(x);
  };
  for (const el of Object.values(spec.elements)) {
    walk(el.props);
    walk(el.visible);
    if (el.repeat) reads.push((el.repeat as { statePath: string }).statePath);
    for (const b of Object.values(el.on ?? {}).flat()) {
      invokes.push({ action: b.action, ref: b.params?.ref });
      walk(b.params);
    }
  }
  return { reads, binds, invokes };
}

describe("specs: valid against the catalog, consistent with their binding", () => {
  it("covers every view kind of the benchmark (8)", () => {
    expect(views.map(([k]) => k).sort()).toEqual([
      "contacts:details",
      "contacts:editor",
      "contacts:list",
      "hello:panel",
      "todos:clear-completed",
      "todos:editor",
      "todos:list",
      "todos:rename",
    ]);
  });

  it("each spec validates against the catalog and structurally", () => {
    for (const [kind, view] of views) {
      const result = catalog.validate(view.spec);
      expect(result.success, `${kind}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
      expect(validateSpec(view.spec).issues, kind).toEqual([]);
    }
  });

  it("each spec reads, binds and invokes only what its binding offers", () => {
    for (const [kind, view] of views) {
      const binding = view.bind(stubModel());
      const store = modelStore(binding, () => {});
      const keys = Object.keys(store.state.getSnapshot());
      const { reads, binds, invokes } = refsOf(view.spec);
      for (const p of reads) expect(keys, `${kind} reads ${p}`).toContain(p.split("/")[1]);
      for (const p of binds)
        expect(Object.keys(binding.writes ?? {}), `${kind} binds ${p}`).toContain(p);
      for (const i of invokes) {
        expect(Object.keys(store.handlers), `${kind} invokes ${i.action}`).toContain(i.action);
        if (i.action === "submit" && typeof i.ref === "string")
          expect(Object.keys(binding.actions ?? {}), `${kind} submits ${i.ref}`).toContain(i.ref);
      }
    }
  });

  describe("negative controls", () => {
    it("an unknown component is rejected by the catalog", () => {
      const bad = { root: "a", elements: { a: { type: "Marquee", props: {}, children: [] } } };
      const result = catalog.validate(bad);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["elements", "a", "type"]);
    });

    it("FINDING: bad props are NOT rejected — with more than one component, the schema's props are record<string, unknown>", () => {
      // core/src/schema.ts, `case "propsOf"`: one props schema per catalog, not per element type.
      const bad = {
        root: "b",
        elements: { b: { type: "Button", props: { action: 5 }, children: [] } },
      };
      expect(catalog.validate(bad).success).toBe(true);
    });

    it("a spec binding a presentation path is caught by the consistency check", () => {
      const [, list] = views.find(([k]) => k === "todos:list") as [string, JrView<never>];
      const spec = structuredClone(list.spec) as Spec;
      (spec.elements.newTitle as { props: Record<string, unknown> }).props.value = {
        $bindState: "/outcome",
      };
      const { binds } = refsOf(spec);
      const writable = Object.keys(list.bind(stubModel()).writes ?? {});
      expect(binds.filter((p) => !writable.includes(p))).toEqual(["/outcome"]);
    });
  });
});
