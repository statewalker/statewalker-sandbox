import {
  type ApplicationManifest,
  application,
  type BundleManifest,
  type Context,
  loggerAdapter,
  resolveFeatures,
  without,
} from "@kernel";
import { describe, expect, it } from "vitest";
import { newRecordingLogger } from "../support/logging.js";

function recorder() {
  const events: string[] = [];
  const bundle = (
    id: string,
    opts: { failActivate?: boolean; failCleanup?: boolean } = {},
  ): BundleManifest => ({
    id,
    activator: async () => {
      events.push(`+${id}`);
      if (opts.failActivate) throw new Error(`${id} failed`);
      return async () => {
        events.push(`-${id}`);
        if (opts.failCleanup) throw new Error(`${id} cleanup failed`);
      };
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

  it("a lazy activator is loaded by the loader", async () => {
    const { events, bundle } = recorder();
    const lazy = bundle("lazy");
    const app: ApplicationManifest = {
      id: "a",
      features: [
        {
          id: "f",
          bundles: [{ id: "lazy", lazy: true, activator: async () => lazy.activator as never }],
        },
      ],
    };
    const { context } = ctxWithLogger();
    await application(app)(context);
    expect(events).toEqual(["+lazy"]);
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
        { id: "o", bundles: [bundle("o1"), { id: "inner", activator: application(inner) }] },
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
