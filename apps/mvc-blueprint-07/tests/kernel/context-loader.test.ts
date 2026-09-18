import { describe, expect, it } from "vitest";
import { type Context, defineService, useFields } from "../../src/kernel/context.js";
import { application, resolveFeatures } from "../../src/kernel/loader.js";
import { createLogger, getLogger, setLogger } from "../../src/kernel/logger.js";

describe("read-then-set", () => {
  it("setting a key after it was read throws; before, it overrides", () => {
    const [get, set] = defineService<string>("t:svc", () => "default");
    const early: Context = {};
    set(early, "host");
    expect(get(early)).toBe("host");
    const late: Context = {};
    expect(get(late)).toBe("default");
    expect(() => set(late, "host")).toThrow("t:svc was already read");
  });
  it("a service with no factory throws when unset; useFields resolves in one place", () => {
    const [get] = defineService<number>("t:none");
    expect(() => get({})).toThrow("t:none is not provided");
    const context: Context = {};
    const quiet = createLogger({ quiet: true });
    setLogger(context, quiet);
    expect(useFields({ log: getLogger })(context).log).toBe(quiet);
  });
});

describe("loader", () => {
  const trace: string[] = [];
  const bundle = (id: string, fail = false) => ({
    id,
    activator: async () => {
      if (fail) throw new Error(`${id} failed`);
      trace.push(`+${id}`);
      return () => void trace.push(`-${id}`);
    },
  });
  it("activates required features first, bundles in order; stops in reverse", async () => {
    trace.length = 0;
    const app = {
      id: "app",
      features: [
        { id: "b", requires: ["a"], bundles: [bundle("b1"), bundle("b2")] },
        { id: "a", bundles: [bundle("a1")] },
      ],
    };
    const stop = await application(app)({});
    await stop?.();
    expect(trace).toEqual(["+a1", "+b1", "+b2", "-b2", "-b1", "-a1"]);
  });
  it("a missing requirement or a cycle fails before anything activates", () => {
    expect(() =>
      resolveFeatures({ id: "x", features: [{ id: "a", requires: ["z"], bundles: [] }] }),
    ).toThrow("requires z");
    expect(() =>
      resolveFeatures({
        id: "x",
        features: [
          { id: "a", requires: ["b"], bundles: [] },
          { id: "b", requires: ["a"], bundles: [] },
        ],
      }),
    ).toThrow("cycle");
  });
  it("a throwing activator rolls back what was activated, then rethrows", async () => {
    trace.length = 0;
    const app = {
      id: "app",
      features: [{ id: "f", bundles: [bundle("ok"), bundle("bad", true)] }],
    };
    await expect(application(app)({})).rejects.toThrow("bad failed");
    expect(trace).toEqual(["+ok", "-ok"]);
  });
});
