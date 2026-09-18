import { describe, expect, it } from "vitest";
import {
  ActorSystem,
  application,
  contribute,
  definePoint,
  type LogEntry,
  ownPoints,
  resolveFeatures,
  without,
} from "../../src/kernel/index.js";

const point = definePoint<{ label: string }>("test:items", "owner");
const setup = () => {
  const logs: LogEntry[] = [];
  const system = new ActorSystem({ logSink: (e) => logs.push(e) });
  const owner = () =>
    system.spawn("owner", (ctx) => {
      const points = ownPoints(ctx, [point]);
      return (msg, env) => void points.handle(msg, env);
    });
  const labels = () => (system.streams.get(point.key) ?? []).map((c) => c.value.label);
  return { system, logs, owner, labels };
};

describe("extension points as owner state", () => {
  it("a contributor that starts BEFORE the owner is seen once the owner starts", () => {
    const { system, owner, labels } = setup();
    system.spawn("early", (ctx) => {
      contribute(ctx, point, "early", { label: "early" });
      return () => {};
    });
    expect(labels()).toEqual([]);
    owner();
    expect(labels()).toEqual(["early"]);
  });

  it("an update replaces in place; withdraw removes", () => {
    const { system, owner, labels } = setup();
    owner();
    system.spawn<string>("c", (ctx) => {
      const a = contribute(ctx, point, "a", { label: "a1" });
      contribute(ctx, point, "b", { label: "b" });
      return (m) => (m === "update" ? a.update({ label: "a2" }) : a.withdraw());
    });
    expect(labels()).toEqual(["a1", "b"]);
    system.send("c", "update");
    expect(labels()).toEqual(["a2", "b"]);
    system.send("c", "withdraw");
    expect(labels()).toEqual(["b"]);
  });

  it("a stopped contributor's entries vanish (the owner watches it)", () => {
    const { system, owner, labels } = setup();
    owner();
    system.spawn("c", (ctx) => {
      contribute(ctx, point, "c", { label: "c" });
      return () => {};
    });
    expect(labels()).toEqual(["c"]);
    system.stop("c");
    expect(labels()).toEqual([]);
  });

  it("an owner restart gets every contribution again", () => {
    const { system, owner, labels } = setup();
    owner();
    system.spawn("c", (ctx) => {
      contribute(ctx, point, "c", { label: "c" });
      return () => {};
    });
    system.stop("owner");
    expect(system.streams.get(point.key)).toBeUndefined();
    owner();
    expect(labels()).toEqual(["c"]);
  });

  it("a second contributor claiming the same id is refused loudly", () => {
    const { system, owner, labels, logs } = setup();
    owner();
    for (const who of ["x", "y"])
      system.spawn(who, (ctx) => {
        contribute(ctx, point, "same", { label: who });
        return () => {};
      });
    expect(labels()).toEqual(["x"]);
    expect(logs.some((l) => l.level === "error" && l.message.includes("tried to replace"))).toBe(
      true,
    );
  });
});

describe("loader", () => {
  const b = (id: string, log: string[]) => ({
    id,
    behavior: (ctx: { onStop(cb: () => void): void }) => {
      log.push(`start ${id}`);
      ctx.onStop(() => log.push(`stop ${id}`));
      return () => {};
    },
  });

  it("activates required features first, bundles in order; cleanup reverses", async () => {
    const log: string[] = [];
    const system = new ActorSystem({ logSink: () => {} });
    const stop = await application({
      id: "app",
      features: [
        { id: "b", requires: ["a"], bundles: [b("b1", log)] },
        { id: "a", bundles: [b("a1", log), b("a2", log)] },
      ],
    })(system);
    expect(log).toEqual(["start a1", "start a2", "start b1"]);
    await stop();
    expect(log.slice(3)).toEqual(["stop b1", "stop a2", "stop a1"]);
    expect(system.addresses()).toEqual([]);
  });

  it("a missing requirement or a cycle is an error before anything activates", () => {
    expect(() =>
      resolveFeatures({ id: "x", features: [{ id: "a", requires: ["z"], bundles: [] }] }),
    ).toThrow(/requires "z"/);
    expect(() =>
      resolveFeatures({
        id: "x",
        features: [
          { id: "a", requires: ["b"], bundles: [] },
          { id: "b", requires: ["a"], bundles: [] },
        ],
      }),
    ).toThrow(/cycle/);
  });

  it("a failing activator rolls back what was activated, then rethrows", async () => {
    const log: string[] = [];
    const system = new ActorSystem({ logSink: () => {} });
    const bad = {
      id: "bad",
      behavior: () => {
        throw new Error("nope");
      },
    };
    await expect(
      application({ id: "app", features: [{ id: "f", bundles: [b("ok", log), bad] }] })(system),
    ).rejects.toThrow("nope");
    expect(log).toEqual(["start ok", "stop ok"]);
    expect(system.addresses()).toEqual([]);
  });

  it("lazy bundles load through the manifest", async () => {
    const log: string[] = [];
    const system = new ActorSystem({ logSink: () => {} });
    await application({
      id: "app",
      features: [
        {
          id: "f",
          bundles: [{ id: "lazy", behavior: { load: async () => b("lazy", log).behavior } }],
        },
      ],
    })(system);
    expect(log).toEqual(["start lazy"]);
  });

  it("without() drops a feature and everything that requires it", () => {
    const { manifest, dropped } = without(
      {
        id: "w",
        features: [
          { id: "a", bundles: [] },
          { id: "b", requires: ["a"], bundles: [] },
          { id: "c", bundles: [] },
        ],
      },
      "a",
    );
    expect(dropped).toEqual(["a", "b"]);
    expect(manifest.features.map((f) => f.id)).toEqual(["c"]);
  });
});
