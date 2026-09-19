import { answer, CommandError, call, defineCommand, KernelSlots, observe } from "@p5/kernel";
import { describe, expect, it, vi } from "vitest";

const ping = defineCommand<{ n: number }, string>("t:ping");
const note = defineCommand<string, string>("t:note", { policy: "silent" });

const kind = async (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e) => (e instanceof CommandError ? e.kind : `raw:${(e as Error).message}`),
  );

describe("commands over slots: a command is a slot of handlers, a call is a dispatch", () => {
  it("a typed request gets its typed response; the answer is a contribution in the slot", async () => {
    const slots = new KernelSlots();
    const off = answer(slots, ping, async ({ payload }) => `pong ${payload.n}`);
    expect(slots.getSnapshot(ping)).toHaveLength(1); // visible like any contribution
    const r: string = await call(slots, ping, { n: 1 }).promise;
    expect(r).toBe("pong 1");
    off();
    expect(slots.getSnapshot(ping)).toHaveLength(0);
  });

  it("no answer: `required` rejects (no-handlers); `silent` resolves undefined, typed so", async () => {
    const slots = new KernelSlots();
    expect(await kind(call(slots, ping, { n: 1 }).promise)).toBe("no-handlers");
    const r: string | undefined = await call(slots, note, "x").promise;
    expect(r).toBeUndefined();
  });

  it("observers only: they run; `required` still rejects, `silent` resolves", async () => {
    const slots = new KernelSlots();
    const seen: string[] = [];
    observe(slots, ping, () => void seen.push("ping"));
    observe(slots, note, () => void seen.push("note"));
    expect(await kind(call(slots, ping, { n: 1 }).promise)).toBe("no-handlers");
    expect(await call(slots, note, "x").promise).toBeUndefined();
    expect(seen).toEqual(["ping", "note"]);
  });

  it("K1/K2 inverted: an observer never claims and sees every call, whatever the order", async () => {
    const slots = new KernelSlots();
    const ran: string[] = [];
    observe(slots, ping, () => void ran.push("early observer"));
    answer(slots, ping, async ({ payload }) => {
      ran.push("owner");
      return `owner ${payload.n}`;
    });
    observe(slots, ping, () => void ran.push("late observer"));
    expect(await call(slots, ping, { n: 2 }).promise).toBe("owner 2");
    expect(ran).toEqual(["early observer", "late observer", "owner"]);
  });

  it("the first answer present claims; a second answer never runs", async () => {
    const slots = new KernelSlots();
    const ran: string[] = [];
    answer(slots, ping, () => (ran.push("first"), "first")); // a sync answer claims too
    answer(slots, ping, () => (ran.push("second"), "second"));
    expect(await call(slots, ping, { n: 1 }).promise).toBe("first");
    expect(ran).toEqual(["first"]);
  });

  it("a throwing observer is reported and changes nothing for the caller", async () => {
    const slots = new KernelSlots();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    observe(slots, ping, () => {
      throw new Error("observer bug");
    });
    answer(slots, ping, () => "ok");
    expect(await call(slots, ping, { n: 1 }).promise).toBe("ok");
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it("a handler added during a dispatch is not called; the next call sees the slot as it is", async () => {
    const slots = new KernelSlots();
    const ran: string[] = [];
    observe(slots, note, () => {
      ran.push("a");
      if (ran.length === 1) observe(slots, note, () => void ran.push("late"));
    });
    await call(slots, note, "x").promise;
    expect(ran).toEqual(["a"]);
    ran.length = 0;
    await call(slots, note, "y").promise;
    expect(ran).toEqual(["a", "late"]);
  });

  it("transient: a late answer does not receive calls made before it arrived", async () => {
    const slots = new KernelSlots();
    const early = call(slots, ping, { n: 1 });
    const earlySilent = call(slots, note, "early");
    const got: unknown[] = [];
    answer(slots, ping, async ({ payload }) => {
      got.push(payload);
      return "ok";
    });
    observe(slots, note, ({ payload }) => void got.push(payload));
    expect(await kind(early.promise)).toBe("no-handlers");
    expect(await earlySilent.promise).toBeUndefined();
    expect(got).toEqual([]);
    expect(await call(slots, ping, { n: 2 }).promise).toBe("ok");
    expect(got).toEqual([{ n: 2 }]);
  });

  it("an answer's own failure reaches the caller unchanged (thrown or rejected)", async () => {
    const slots = new KernelSlots();
    const off = answer(slots, ping, () => {
      throw new Error("sync boom");
    });
    expect(await kind(call(slots, ping, { n: 1 }).promise)).toBe("raw:sync boom");
    off();
    answer(slots, ping, async () => {
      throw new Error("Name is required");
    });
    expect(await kind(call(slots, ping, { n: 1 }).promise)).toBe("raw:Name is required");
  });

  it("the answer withdrawn while a call is pending ⇒ the call rejects (abandoned); nothing is left", async () => {
    const slots = new KernelSlots();
    let release: (v: string) => void = () => {};
    const off = answer(slots, ping, () => new Promise<string>((r) => (release = r)));
    const c = call(slots, ping, { n: 1 });
    off();
    expect(await kind(c.promise)).toBe("abandoned");
    release("too late"); // the late answer is ignored
    const left = slots.usage().filter((u) => u.contributions > 0 || u.observers > 0);
    expect(left).toEqual([]);
  });

  it("usage marks command slots so coverage does not report handlers as unobserved", () => {
    const slots = new KernelSlots();
    answer(slots, ping, async () => "x");
    expect(slots.usage()).toEqual([
      { key: "t:ping", contributions: 1, observers: 0, command: true },
    ]);
  });

  it("T1 inverted: the confusing forms do not compile (checked by `pnpm typecheck`)", () => {
    const slots = new KernelSlots();
    const unit = defineCommand<void, void>("t:unit");
    // @ts-expect-error — an observer cannot be async: it could look like a claim
    observe(slots, unit, async () => {});
    // @ts-expect-error — no priorities: order is not a mechanism
    answer(slots, unit, () => {}, { priority: 10 });
    const later = async () => {
      // @ts-expect-error — a silent command's result may be undefined
      const n: string = await call(slots, note, "x").promise;
      return n;
    };
    expect(typeof later).toBe("function");
  });
});
