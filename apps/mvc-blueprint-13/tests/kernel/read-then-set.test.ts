import { todoApiAdapter } from "@p5/todos/api";
import { MemTodoApi, activate as todosCore } from "@p5/todos.core";
import {
  type ApplicationManifest,
  application,
  type Context,
  getLogger,
  isProvided,
  loggerAdapter,
  newAdapter,
  plan,
  wasRead,
} from "@p5/kernel";
import { describe, expect, it } from "vitest";
import { newRecordingLogger } from "../support/logging.js";

describe("read-then-set", () => {
  it("setting a key after it was read throws; before, it overrides", () => {
    const service = newAdapter<string>("test:service", () => "default");
    const early: Context = {};
    service.set(early, "host");
    expect(service.get(early)).toBe("host");

    const late: Context = {};
    expect(service.get(late)).toBe("default");
    expect(() => service.set(late, "host")).toThrow(/test:service was already read/);
  });

  it("an optional read (absent) counts as a read; isProvided does not", () => {
    const service = newAdapter<string>("test:optional");
    const ctx: Context = {};
    expect(isProvided(ctx, service.key)).toBe(false);
    expect(wasRead(ctx, service.key)).toBe(false);
    expect(service.find(ctx)).toBeUndefined();
    expect(() => service.set(ctx, "late")).toThrow(/already read/);
  });

  it("a kernel service with a factory resolves on {} and is one instance", () => {
    const ctx: Context = {};
    expect(getLogger(ctx)).toBe(getLogger(ctx));
    expect(() => loggerAdapter.set(ctx, newRecordingLogger().logger)).toThrow(/sys:logger/);
  });

  it("a bundle service without a factory throws when unset (no silent default)", () => {
    expect(() => todoApiAdapter.get({})).toThrow(/todos:api/);
  });

  it("the loader rejects, before activation, a provider listed after a consumer that reads its key", () => {
    const consumer = async () => {};
    const manifest: ApplicationManifest = {
      id: "t",
      features: [
        {
          id: "f",
          bundles: [
            { id: "consumer", activator: consumer, optional: ["todos:api"] },
            { id: "todos.core", activator: todosCore, provides: ["todos:api"] },
          ],
        },
      ],
    };
    expect(() => plan(manifest, {})).toThrow(/"todos.core" provides todos:api after "consumer"/);
    // The host already set it: the provider's set is skipped, so the order is harmless.
    expect(() => plan(manifest, { "todos:api": new MemTodoApi() })).not.toThrow();
  });

  it("at runtime the guard catches an undeclared early read: the provider's set throws, the loader rolls back", async () => {
    const { logger } = newRecordingLogger();
    const ctx: Context = {};
    loggerAdapter.set(ctx, logger);
    const sneaky = async (c: Context) => {
      todoApiAdapter.find(c); // an undeclared optional read
    };
    const manifest: ApplicationManifest = {
      id: "t",
      features: [
        {
          id: "f",
          bundles: [
            { id: "sneaky", activator: sneaky },
            { id: "todos.core", activator: todosCore, provides: ["todos:api"] },
          ],
        },
      ],
    };
    await expect(application(manifest)(ctx)).rejects.toThrow(/todos:api was already read/);
  });

  it("a required key nothing provides is an error before anything activates", () => {
    let activated = false;
    const manifest: ApplicationManifest = {
      id: "t",
      features: [
        {
          id: "f",
          bundles: [
            {
              id: "needs-root",
              requires: ["shell:root"],
              activator: async () => {
                activated = true;
              },
            },
          ],
        },
      ],
    };
    expect(() => plan(manifest, {})).toThrow(/requires shell:root, which nothing provides/);
    expect(activated).toBe(false);
  });
});
