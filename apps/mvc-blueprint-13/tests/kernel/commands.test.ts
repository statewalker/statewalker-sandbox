import {
  answer,
  type Call,
  CommandError,
  call,
  callsSlot,
  defineCommand,
  KernelSlots,
} from "@p5/kernel";
import { describe, expect, it } from "vitest";

const ping = defineCommand<{ n: number }, string>("t:ping");
const note = defineCommand<string, string | undefined>("t:note", { policy: "silent" });

const kind = async (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e) => (e instanceof CommandError ? e.kind : `raw:${(e as Error).message}`),
  );

describe("commands over slots: a command is a slot of handlers, a call is a dispatch", () => {
  it("a typed request gets its typed response; the handler is a contribution in the slot", async () => {
    const slots = new KernelSlots();
    const off = answer(slots, ping, async ({ payload }) => `pong ${payload.n}`);
    expect(slots.getSnapshot(ping)).toHaveLength(1); // visible like any contribution
    const r: string = await call(slots, ping, { n: 1 }).promise;
    expect(r).toBe("pong 1");
    off();
    expect(slots.getSnapshot(ping)).toHaveLength(0);
  });

  it("no handler: `required` rejects (no-handlers); `silent` resolves undefined", async () => {
    const slots = new KernelSlots();
    expect(await kind(call(slots, ping, { n: 1 }).promise)).toBe("no-handlers");
    expect(await call(slots, note, "x").promise).toBeUndefined();
  });

  it("observers only: `required` rejects (not-claimed) after they ran; `silent` resolves", async () => {
    const slots = new KernelSlots();
    const seen: string[] = [];
    answer(slots, ping, () => void seen.push("ping"));
    answer(slots, note, () => void seen.push("note"));
    expect(await kind(call(slots, ping, { n: 1 }).promise)).toBe("not-claimed");
    expect(await call(slots, note, "x").promise).toBeUndefined();
    expect(seen).toEqual(["ping", "note"]);
  });

  it("claim: the first claimer answers and dispatch stops; observers before it still run", async () => {
    const slots = new KernelSlots();
    const ran: string[] = [];
    answer(slots, ping, () => void ran.push("observer"), { priority: 10 });
    answer(slots, ping, async () => {
      ran.push("owner");
      return "owner";
    });
    answer(slots, ping, async () => {
      ran.push("second");
      return "second";
    });
    expect(await call(slots, ping, { n: 1 }).promise).toBe("owner");
    expect(ran).toEqual(["observer", "owner"]);
  });

  it("claim with `true`: the handler settles the call itself, later", async () => {
    const slots = new KernelSlots();
    let held: Call<{ n: number }, string> | undefined;
    answer(slots, ping, (c) => {
      held = c;
      return true;
    });
    const c = call(slots, ping, { n: 2 });
    expect(slots.getSnapshot(callsSlot).size).toBe(1);
    held?.resolve("later");
    held?.resolve("ignored");
    expect(await c.promise).toBe("later");
    expect(slots.getSnapshot(callsSlot).size).toBe(0);
  });

  it("priority order: higher first; equal priorities in arrival order", async () => {
    const slots = new KernelSlots();
    const ran: string[] = [];
    const obs = (id: string, priority?: number) =>
      answer(slots, note, () => void ran.push(id), { priority });
    obs("a");
    obs("b", 5);
    obs("c");
    obs("d", -1);
    obs("e", 5);
    await call(slots, note, "x").promise;
    expect(ran).toEqual(["b", "e", "a", "c", "d"]);
  });

  it("a handler withdrawn during a dispatch is skipped; one added during it is not called", async () => {
    const slots = new KernelSlots();
    const ran: string[] = [];
    let offB: () => void = () => {};
    answer(
      slots,
      note,
      () => {
        ran.push("a");
        offB();
        answer(slots, note, () => void ran.push("late"));
      },
      { priority: 1 },
    );
    offB = answer(slots, note, () => void ran.push("b"));
    await call(slots, note, "x").promise;
    expect(ran).toEqual(["a"]);
    // The next call sees the slot as it is now.
    ran.length = 0;
    await call(slots, note, "y").promise;
    expect(ran).toEqual(["a", "late"]);
  });

  it("transient: a late handler does not receive calls made before it arrived", async () => {
    const slots = new KernelSlots();
    const early = call(slots, ping, { n: 1 });
    const earlySilent = call(slots, note, "early");
    const got: unknown[] = [];
    answer(slots, ping, async ({ payload }) => {
      got.push(payload);
      return "ok";
    });
    answer(slots, note, ({ payload }) => void got.push(payload));
    expect(await kind(early.promise)).toBe("no-handlers");
    expect(await earlySilent.promise).toBeUndefined();
    expect(got).toEqual([]);
    expect(await call(slots, ping, { n: 2 }).promise).toBe("ok");
    expect(got).toEqual([{ n: 2 }]);
  });

  it("a handler's own failure reaches the caller unchanged (thrown or rejected)", async () => {
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

  it("the claimer withdrawn while a call is pending ⇒ the call rejects (abandoned); nothing is left", async () => {
    const slots = new KernelSlots();
    let release: (v: string) => void = () => {};
    const off = answer(slots, ping, () => new Promise<string>((r) => (release = r)));
    const c = call(slots, ping, { n: 1 });
    expect([...slots.getSnapshot(callsSlot).values()].map((p) => p.key)).toEqual(["t:ping"]);
    off();
    expect(await kind(c.promise)).toBe("abandoned");
    release("too late"); // the late answer is ignored
    const left = slots.usage().filter((u) => u.contributions > 0 || u.observers > 0);
    expect(left).toEqual([]);
  });

  it("in-flight calls are state: `running` for a command is derivable from `sys:calls`", async () => {
    const slots = new KernelSlots();
    const runs: boolean[] = [];
    slots.observe(callsSlot, (calls) =>
      runs.push([...calls.values()].some((p) => p.key === ping.key)),
    );
    answer(slots, ping, async () => "ok");
    await call(slots, ping, { n: 1 }).promise;
    expect(runs).toEqual([false, true, false]);
  });

  it("usage marks command slots so coverage does not report handlers as unobserved", () => {
    const slots = new KernelSlots();
    answer(slots, ping, async () => "x");
    expect(slots.usage()).toEqual([
      { key: "t:ping", contributions: 1, observers: 0, command: true },
    ]);
  });
});
