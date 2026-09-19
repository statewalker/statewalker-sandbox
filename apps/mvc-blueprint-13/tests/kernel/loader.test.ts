import {
  type ApplicationManifest,
  application,
  type BundleManifest,
  type BundleModule,
  type Context,
  loggerAdapter,
  resolveFeatures,
} from "@p5/kernel";
import { without } from "../support/without.js";
import { describe, expect, it } from "vitest";
import { newRecordingLogger } from "../support/logging.js";

function recorder() {
  const events: string[] = [];
  const bundle = (
    id: string,
    opts: { failActivate?: boolean; failCleanup?: boolean } = {},
  ): BundleManifest => ({
    id,
    module: {
      default: async () => {
        events.push(`+${id}`);
        if (opts.failActivate) throw new Error(`${id} failed`);
        return async () => {
          events.push(`-${id}`);
          if (opts.failCleanup) throw new Error(`${id} cleanup failed`);
        };
      },
    },
  });
  return { events, bundle };
}

function ctxWithLogger() {
  const { logger, calls } = newRecordingLogger();
  const context: Context = {};
  loggerAdapter.set(context, logger);
  return { context, calls };
}

describe("loader", () => {
  it("activates required features first, bundles in listed order; cleans up in reverse", async () => {
    const { events, bundle } = recorder();
    const app: ApplicationManifest = {
      id: "a",
      features: [
        { id: "b", requires: ["a"], bundles: [bundle("b1"), bundle("b2")] },
        { id: "a", bundles: [bundle("a1")] },
      ],
    };
    const { context } = ctxWithLogger();
    const stop = await application(app)(context);
    expect(events).toEqual(["+a1", "+b1", "+b2"]);
    await stop?.();
    expect(events).toEqual(["+a1", "+b1", "+b2", "-b2", "-b1", "-a1"]);
  });

  it("a missing required feature or a cycle is an error before anything activates", () => {
    const { bundle, events } = recorder();
    expect(() =>
      resolveFeatures({
        id: "x",
        features: [{ id: "a", requires: ["zz"], bundles: [bundle("a")] }],
      }),
    ).toThrow(/missing feature "zz"/);
    expect(() =>
      resolveFeatures({
        id: "x",
        features: [
          { id: "a", requires: ["b"], bundles: [] },
          { id: "b", requires: ["a"], bundles: [] },
        ],
      }),
    ).toThrow(/cycle/);
    expect(events).toEqual([]);
  });

  it("a throwing activator deactivates what already activated, in reverse, then rethrows", async () => {
    const { events, bundle } = recorder();
    const app: ApplicationManifest = {
      id: "a",
      features: [
        { id: "f", bundles: [bundle("x"), bundle("y"), bundle("z", { failActivate: true })] },
      ],
    };
    const { context } = ctxWithLogger();
    await expect(application(app)(context)).rejects.toThrow("z failed");
    expect(events).toEqual(["+x", "+y", "+z", "-y", "-x"]);
  });

  it("a throwing cleanup is logged and does not stop the others", async () => {
    const { events, bundle } = recorder();
    const app: ApplicationManifest = {
      id: "a",
      features: [
        { id: "f", bundles: [bundle("x"), bundle("y", { failCleanup: true }), bundle("z")] },
      ],
    };
    const { context, calls } = ctxWithLogger();
    const stop = await application(app)(context);
    await stop?.();
    expect(events).toEqual(["+x", "+y", "+z", "-z", "-y", "-x"]);
    expect(calls.some((c) => c.level === "error" && c.args[0] === "loader:cleanup-failed")).toBe(
      true,
    );
  });

  it("an eager module (an imported namespace) activates its default export", async () => {
    const { events, bundle } = recorder();
    const ns = bundle("eager").module as BundleModule;
    const app: ApplicationManifest = {
      id: "a",
      features: [{ id: "f", bundles: [{ id: "eager", module: ns }] }],
    };
    const { context } = ctxWithLogger();
    const stop = await application(app)(context);
    await stop?.();
    expect(events).toEqual(["+eager", "-eager"]);
  });

  it("a lazy module (a function returning the namespace) is loaded by the loader, in order", async () => {
    const { events, bundle } = recorder();
    const lazy = bundle("lazy").module as BundleModule;
    const app: ApplicationManifest = {
      id: "a",
      features: [
        {
          id: "f",
          bundles: [
            bundle("before"),
            {
              id: "lazy",
              module: async () => {
                events.push("load:lazy");
                return lazy;
              },
            },
          ],
        },
      ],
    };
    const { context } = ctxWithLogger();
    await application(app)(context);
    expect(events).toEqual(["+before", "load:lazy", "+lazy"]);
  });

  it("a module without a default export activator is a clear error; what activated rolls back", async () => {
    const { events, bundle } = recorder();
    const broken = (m: unknown): ApplicationManifest => ({
      id: "a",
      features: [
        { id: "f", bundles: [bundle("x"), { id: "bad", module: m as BundleModule }, bundle("z")] },
      ],
    });
    const { context } = ctxWithLogger();
    for (const m of [{}, { default: 42 }, async () => ({ activate: async () => {} })]) {
      events.length = 0;
      await expect(application(broken(m))(context)).rejects.toThrow(
        'bundle "bad": module has no default export activator',
      );
      expect(events).toEqual(["+x", "-x"]);
    }
  });

  it("`lazy` and `activator` are gone from the manifest type", () => {
    const fn = async () => {};
    // @ts-expect-error — `lazy` was removed in P5.3: typeof tells a namespace from a lazy import
    const lazy: BundleManifest = { id: "l", lazy: true, module: { default: fn } };
    // @ts-expect-error — `activator` was replaced by `module` in P5.3
    const old: BundleManifest = { id: "o", activator: fn };
    expect([lazy.id, old.id]).toEqual(["l", "o"]);
  });

  it("an application is a controller: it activates inside another application", async () => {
    const { events, bundle } = recorder();
    const inner: ApplicationManifest = {
      id: "inner",
      features: [{ id: "i", bundles: [bundle("i1")] }],
    };
    const outer: ApplicationManifest = {
      id: "outer",
      features: [
        {
          id: "o",
          bundles: [bundle("o1"), { id: "inner", module: { default: application(inner) } }],
        },
      ],
    };
    const { context } = ctxWithLogger();
    const stop = await application(outer)(context);
    await stop?.();
    expect(events).toEqual(["+o1", "+i1", "-i1", "-o1"]);
  });

  it("without() drops a feature and everything that requires it", () => {
    const app: ApplicationManifest = {
      id: "w",
      features: [
        { id: "todos", bundles: [] },
        { id: "contacts", bundles: [] },
        { id: "todos-contacts", requires: ["todos", "contacts"], bundles: [] },
        { id: "todos.status", requires: ["todos"], bundles: [] },
      ],
    };
    const { manifest, removed } = without(app, "contacts");
    expect(manifest.features.map((f) => f.id)).toEqual(["todos", "todos.status"]);
    expect(removed.sort()).toEqual(["contacts", "todos-contacts"]);
  });
});
