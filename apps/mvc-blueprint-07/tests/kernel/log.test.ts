import { describe, expect, it } from "vitest";
import {
  createIntentLog,
  defineEvent,
  defineIntent,
  IntentError,
  type LogRecord,
} from "../../src/kernel/log.js";
import { createLogger } from "../../src/kernel/logger.js";
import { tick } from "../support/headless.js";

const ping = defineIntent<{ n: number }, number>("t:ping");
const pong = defineIntent<{ n: number }>("t:pong");
const bump = defineEvent<{ by: number }>("t:bump");
const maybe = defineIntent<void>("t:maybe", "optional");

const setup = (retain?: number) => {
  const logger = createLogger({ quiet: true });
  const core = createIntentLog({ logger, retain });
  return { core, logger, a: core.open("a"), b: core.open("b") };
};
const brief = (r: LogRecord) =>
  r.kind === "intent" ? `${r.type}#${r.seq}` : `✓${r.type}#${r.cause}`;

describe("ordering", () => {
  it("every projection sees every record in seq order, even when a handler appends mid-dispatch", () => {
    const { a, b } = setup();
    const seenA: string[] = [];
    const seenB: string[] = [];
    // handler of ping appends pong synchronously — during ping's dispatch
    a.handle(ping, ({ payload, seq }) => {
      a.append(pong, { n: payload.n }, { cause: seq });
      return payload.n;
    });
    b.handle(pong, () => undefined);
    a.project((r) => seenA.push(brief(r)));
    b.project((r) => seenB.push(brief(r)));
    a.append(ping, { n: 1 });
    expect(seenA).toEqual(seenB);
    const seqs = seenA.map((s) => Number(s.split("#")[1]));
    expect(seenA).toEqual(["t:ping#1", "t:pong#2", "✓t:ping#1", "✓t:pong#2"]);
    expect(seqs.length).toBe(4);
  });

  it("the outer append returns only after the queue it started has drained", () => {
    const { a } = setup();
    const seen: string[] = [];
    a.handle(ping, ({ payload }) => payload.n);
    a.project((r) => seen.push(brief(r)));
    a.append(ping, { n: 1 });
    expect(seen).toEqual(["t:ping#1", "✓t:ping#1"]);
  });

  it("a projection may not append", () => {
    const { a, logger } = setup();
    a.project((r) => {
      if (r.type === bump.id) a.append(bump, { by: 1 });
    });
    a.append(bump, { by: 1 });
    expect(a.since(0)).toHaveLength(1);
    expect(logger.entries().find((e) => e.level === "error")?.detail).toBeInstanceOf(Error);
  });
});

describe("outcomes", () => {
  it("the handler's return value becomes an outcome record; request resolves with it", async () => {
    const { a } = setup();
    a.handle(ping, async ({ payload }) => payload.n * 2);
    await expect(a.request(ping, { n: 21 })).resolves.toBe(42);
    const outcome = a.since(0).find((r) => r.kind === "outcome");
    expect(outcome).toMatchObject({ ok: true, value: 42, cause: 1, origin: "a" });
  });

  it("a throw becomes a failed outcome; request rejects with IntentError", async () => {
    const { a, logger } = setup();
    a.handle(ping, async () => {
      throw new Error("nope");
    });
    const error = await a.request(ping, { n: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(IntentError);
    expect(error.message).toBe("nope");
    expect(logger.entries().filter((e) => e.level === "error")).toEqual([]); // a failure is state, not a wiring error
  });

  it("a required intent with no handler fails loudly; an optional one settles ok", async () => {
    const { a, logger } = setup();
    await expect(a.request(ping, { n: 1 })).rejects.toThrow("no handler for t:ping");
    expect(logger.entries().filter((e) => e.level === "error")).toHaveLength(1);
    await expect(a.request(maybe, undefined)).resolves.toBeUndefined();
  });

  it("events have no handler and no outcome", async () => {
    const { a } = setup();
    expect(() => a.handle(bump, () => undefined)).toThrow("is an event");
    const record = a.append(bump, { by: 1 });
    expect(a.isPending(record.seq)).toBe(false);
    await expect(a.outcome(record)).rejects.toThrow("no outcome");
  });

  it("an intent type has exactly one handler", () => {
    const { a, b } = setup();
    a.handle(ping, () => 1);
    expect(() => b.handle(ping, () => 2)).toThrow("already has a handler (a); b is a second");
  });

  it("a payload is captured at append: cloned and frozen", () => {
    const { a } = setup();
    const draft = { by: 1 };
    const record = a.append(bump, draft);
    draft.by = 99;
    expect(record.payload).toEqual({ by: 1 });
    expect(Object.isFrozen(record.payload)).toBe(true);
  });
});

describe("scopes (dispose)", () => {
  it("close unregisters handlers and projections, fails in-flight intents, refuses appends", async () => {
    const { core, a, b } = setup();
    let release: (v: number) => void = () => {};
    b.handle(ping, () => new Promise<number>((r) => (release = r)));
    let folded = 0;
    b.project(() => folded++);
    const pending = a.request(ping, { n: 1 });
    const before = folded;
    b.close();
    await expect(pending).rejects.toThrow("abandoned: b stopped");
    release(5); // resolves late: ignored, no second outcome
    await tick();
    expect(a.since(0).filter((r) => r.kind === "outcome")).toHaveLength(1);
    expect(folded).toBe(before); // b's projection saw nothing after close
    expect(() => b.append(bump, { by: 1 })).toThrow("b is stopped");
    expect(core.stats()).toMatchObject({ handlers: 0, openScopes: ["a"] });
  });

  it("a handler's continuation after its scope closed cannot append", async () => {
    const { a, b } = setup();
    let tried: unknown;
    b.handle(ping, async () => {
      await tick();
      try {
        b.append(pong, { n: 1 });
      } catch (error) {
        tried = error;
      }
      return 1;
    });
    const p = a.request(ping, { n: 1 }).catch(() => "failed");
    b.close();
    expect(await p).toBe("failed");
    await tick(5);
    expect((tried as Error).message).toMatch("b is stopped");
    expect(a.since(0).some((r) => r.type === pong.id)).toBe(false);
  });
});

describe("late subscribers (replay)", () => {
  it("a projection registered late sees nothing past unless it asks to replay", () => {
    const { a, b } = setup();
    a.append(bump, { by: 1 });
    a.append(bump, { by: 2 });
    const live: number[] = [];
    const replayed: number[] = [];
    b.project((r) => r.kind === "intent" && live.push((r.payload as { by: number }).by));
    b.project((r) => r.kind === "intent" && replayed.push((r.payload as { by: number }).by), {
      replay: true,
    });
    a.append(bump, { by: 3 });
    expect(live).toEqual([3]);
    expect(replayed).toEqual([1, 2, 3]);
  });

  it("a projection registered during a dispatch sees the record being dispatched exactly once", () => {
    const { a, b } = setup();
    const seen: number[] = [];
    b.handle(ping, ({ payload }) => {
      b.project((r) => seen.push(r.seq), { replay: true });
      b.append(pong, { n: payload.n });
      return 0;
    });
    a.handle(pong, () => undefined);
    a.append(ping, { n: 1 });
    // ping#1 (replayed) then pong#2, ✓ping#3, ✓pong#4 live — no duplicates, in order
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it("handlers never replay: a handler registered after the intent does not run it", async () => {
    const { a, b } = setup();
    const record = a.append(maybe, undefined); // optional: settles ok at once with no handler
    let ran = false;
    b.handle(maybe, () => {
      ran = true;
    });
    await a.outcome(record);
    expect(ran).toBe(false);
  });
});

describe("growth and compaction", () => {
  it("retain bounds the log", () => {
    const { core, a } = setup(10);
    for (let i = 0; i < 100; i++) a.append(bump, { by: i });
    expect(core.stats().appended).toBe(100);
    expect(core.stats().retained).toBeLessThanOrEqual(20);
  });

  it("a pending intent is a watermark: nothing after it is dropped, so a stuck intent pins the log", async () => {
    const { core, a } = setup(10);
    let release = () => {};
    a.handle(pong, () => new Promise<void>((r) => (release = r)));
    a.append(bump, { by: -1 });
    const held = a.append(pong, { n: 0 });
    for (let i = 0; i < 100; i++) a.append(bump, { by: i });
    expect(core.stats().retained).toBe(101); // only the record before the watermark went
    expect(core.records()[0]).toBe(held);
    // a handler's optimistic-concurrency read still sees everything since its cause
    expect(a.since(held.seq)).toHaveLength(100);
    release();
    await core.idle();
    a.append(bump, { by: 100 });
    expect(core.stats().retained).toBeLessThanOrEqual(20);
  });

  it("compact(keep) drops settled records only", () => {
    const { core, a } = setup();
    a.handle(ping, ({ payload }) => payload.n);
    for (let i = 0; i < 5; i++) a.append(ping, { n: i });
    expect(core.records()).toHaveLength(10);
    expect(core.compact(4)).toBe(6);
    expect(core.records().map((r) => r.seq)).toEqual([7, 8, 9, 10]);
  });
});
