import { describe, expect, it } from "vitest";
import {
  type ActorContext,
  ActorStopped,
  ActorSystem,
  type Asks,
  defineStream,
  type LogEntry,
  NoSuchActor,
} from "../../src/kernel/index.js";
import { tick } from "../support/headless.js";

const quiet = () => {
  const logs: LogEntry[] = [];
  return { logs, system: new ActorSystem({ logSink: (e) => logs.push(e) }) };
};

describe("actors · mailbox", () => {
  it("processes messages one at a time, in send order, never re-entrantly", () => {
    const { system } = quiet();
    const seen: string[] = [];
    system.spawn<string>("a", (ctx) => (msg) => {
      seen.push(`start ${msg}`);
      if (msg === "1") ctx.send("a", "nested"); // queued, runs after this handler returns
      seen.push(`end ${msg}`);
    });
    system.send("a", "1");
    system.send("a", "2");
    expect(seen).toEqual(["start 1", "end 1", "start nested", "end nested", "start 2", "end 2"]);
  });

  it("a send from outside is fully processed — cascades included — before it returns", () => {
    const { system } = quiet();
    const log: string[] = [];
    system.spawn<string>("b", () => (m) => log.push(`b:${m}`));
    system.spawn<string>("a", (ctx) => (m) => ctx.send("b", m));
    system.send("a", "x");
    expect(log).toEqual(["b:x"]);
  });

  it("ask resolves with the reply; ask to a missing address rejects NoSuchActor", async () => {
    const { system } = quiet();
    type Msg = { n: number } & Asks<number>;
    system.spawn<Msg>("double", () => (m, env) => env.ok(m.n * 2));
    await expect(system.ask("double", { n: 21 } as Msg)).resolves.toBe(42);
    await expect(system.ask("nobody", { n: 1 })).rejects.toBeInstanceOf(NoSuchActor);
  });

  it("a tell to a missing address is a dead letter, logged below error level", () => {
    const { system, logs } = quiet();
    system.send("ghost", { type: "boo" });
    expect(system.deadLetters).toEqual([{ to: "ghost", from: undefined, msg: { type: "boo" } }]);
    expect(logs.filter((l) => l.level === "error")).toEqual([]);
  });

  it("a throwing handler is logged, fails its ask, and the actor keeps running", async () => {
    const { system, logs } = quiet();
    system.spawn<string>("f", () => (m, env) => {
      if (m === "boom") throw new Error("boom");
      env.ok(m);
    });
    await expect(system.ask("f", "boom")).rejects.toThrow("boom");
    await expect(system.ask("f", "ok")).resolves.toBe("ok");
    expect(logs.some((l) => l.level === "error")).toBe(true);
  });

  it("pipe re-enters the actor as a turn, in order with its messages", async () => {
    const { system } = quiet();
    const seen: string[] = [];
    system.spawn<string>("p", (ctx) => (m) => {
      seen.push(m);
      if (m === "go") ctx.pipe(Promise.resolve("done"), (v) => seen.push(v));
    });
    system.send("p", "go");
    system.send("p", "next");
    await tick();
    expect(seen).toEqual(["go", "next", "done"]);
  });
});

describe("actors · stop", () => {
  it("rejects the queued mailbox: asks with ActorStopped, tells become dead letters", async () => {
    const { system } = quiet();
    let asked: Promise<unknown> | undefined;
    system.spawn<string>("victim", () => () => {});
    system.spawn<string>("killer", (ctx) => () => {
      // Both land in victim's mailbox behind this handler; then victim stops before they run.
      asked = ctx.ask("victim", "q");
      ctx.send("victim", "t");
      system.stop("victim");
    });
    system.send("killer", "go");
    await expect(asked).rejects.toBeInstanceOf(ActorStopped);
    expect(system.deadLetters.map((d) => d.msg)).toEqual(["t"]);
  });

  it("rejects asks it received but had not answered", async () => {
    const { system } = quiet();
    system.spawn<string>("slow", () => () => {}); // never answers
    const p = system.ask("slow", "q");
    system.stop("slow");
    await expect(p).rejects.toBeInstanceOf(ActorStopped);
  });

  it("delivers nothing after stop: no pipe turn, no timer, no send, no publish", async () => {
    const { system } = quiet();
    const s = defineStream<number>("s");
    const effects: string[] = [];
    let ctxRef: ActorContext<string> | undefined;
    let resolveLate: (v: string) => void = () => {};
    system.spawn<string>("w", (ctx) => {
      ctxRef = ctx;
      ctx.pipe(new Promise<string>((r) => (resolveLate = r)), () => effects.push("pipe"));
      ctx.after(5, () => effects.push("timer"));
      ctx.publish(s, 1);
      return () => effects.push("msg");
    });
    system.spawn<string>("sink", () => (m) => effects.push(`sink:${m}`));
    expect(system.streams.get(s)).toBe(1);
    system.stop("w");
    expect(system.streams.get(s)).toBeUndefined(); // released
    resolveLate("late");
    ctxRef?.send("sink", "after-stop");
    ctxRef?.publish(s, 2);
    system.send("w", "hello");
    await new Promise((r) => setTimeout(r, 20));
    expect(effects).toEqual([]);
    expect(system.streams.get(s)).toBeUndefined();
    expect(system.deadLetters.map((d) => d.to)).toEqual(["w"]);
  });

  it("an address can be spawned again after stop; a second live spawn throws", () => {
    const { system } = quiet();
    system.spawn("x", () => () => {});
    expect(() => system.spawn("x", () => () => {})).toThrow(/already taken/);
    system.stop("x");
    system.spawn("x", () => () => {});
    expect(system.isAlive("x")).toBe(true);
  });

  it("watch reports presence as turns: now, then every spawn and stop", () => {
    const { system } = quiet();
    const seen: boolean[] = [];
    system.spawn("watcher", (ctx) => {
      ctx.watch("target", (alive) => seen.push(alive));
      return () => {};
    });
    system.spawn("target", () => () => {});
    system.stop("target");
    expect(seen).toEqual([false, true, false]);
  });

  it("a stream has one owner; a second publisher throws", () => {
    const { system, logs } = quiet();
    const s = defineStream<number>("owned");
    system.spawn("one", (ctx) => {
      ctx.publish(s, 1);
      return () => {};
    });
    expect(() =>
      system.spawn("two", (ctx) => {
        ctx.publish(s, 2);
        return () => {};
      }),
    ).toThrow(/owned by "one"/);
    expect(system.isAlive("two")).toBe(false); // a failed setup stops the actor
    expect(system.streams.get(s)).toBe(1);
    expect(logs.some((l) => l.level === "error" && String(l.message).includes("two"))).toBe(true);
  });
});
