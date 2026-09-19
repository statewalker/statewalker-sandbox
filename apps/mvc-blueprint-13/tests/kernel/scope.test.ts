import {
  answer,
  type ApplicationManifest,
  KernelSlots,
  application,
  type Context,
  CommandError,
  call,
  defineCommand,
  getSlots,
  loggerAdapter,
  newScope,
  type Scope,
} from "@p5/kernel";
import { createCommitAction, describeError, drainCommits, on } from "@p5/kit-commit";
import { describe, expect, it } from "vitest";
import { newRecordingLogger } from "../support/logging.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const later = <T>(value: T, ms = 5) => new Promise<T>((r) => setTimeout(() => r(value), ms));
const silent = { error: () => {} };
const own = (scope: Scope, log: { error: (...a: unknown[]) => void } = silent) => ({
  scope,
  slots: new KernelSlots(),
  log,
});

describe("kernel scope (K §4.1.4)", () => {
  it("closes children first (newest first), then its own disposers in reverse", async () => {
    const events: string[] = [];
    const root = newScope();
    root.defer(() => void events.push("root 1"));
    const a = root.child();
    a.defer(() => void events.push("a"));
    const b = root.child();
    b.defer(() => void events.push("b"));
    root.defer(() => void events.push("root 2"));
    await root.close();
    expect(events).toEqual(["b", "a", "root 2", "root 1"]);
    expect([root.closed, a.closed, b.closed]).toEqual([true, true, true]);
  });

  it("task: settles while open; after close the continuation never runs", async () => {
    const s = newScope();
    expect(await s.task(later("ok"))).toBe("ok");
    await expect(s.task(Promise.reject(new Error("no")))).rejects.toThrow("no");
    let resumed = false;
    void (async () => {
      await s.task(later("late", 10));
      resumed = true;
    })();
    await s.close();
    await later(null, 30);
    expect(resumed).toBe(false);
  });

  it("task hands the scope's abort signal to work that accepts one", async () => {
    const s = newScope();
    let seen: AbortSignal | undefined;
    void s.task(async (signal) => {
      seen = signal;
      return 1;
    });
    await s.close();
    expect(seen?.aborted).toBe(true);
  });

  it("release runs a disposer early, once; defer after close runs at once", async () => {
    const s = newScope();
    let n = 0;
    const release = s.defer(() => void n++);
    release();
    release();
    await s.close();
    expect(n).toBe(1);
    s.defer(() => void n++);
    expect(n).toBe(2);
  });

  it("close is idempotent; a failing disposer does not stop the others and is reported", async () => {
    const s = newScope();
    const events: string[] = [];
    s.defer(() => void events.push("first"));
    s.defer(() => {
      throw new Error("boom");
    });
    s.defer(() => void events.push("last"));
    await expect(s.close()).rejects.toThrow("boom");
    await expect(s.close()).rejects.toThrow("boom");
    expect(events).toEqual(["last", "first"]);
  });

  it("the loader hands each activation its bundle scope and closes them in reverse", async () => {
    const events: string[] = [];
    const scopes: Scope[] = [];
    const bundle = (id: string) => ({
      id,
      activator: async (_: Context, scope: Scope) => {
        scopes.push(scope);
        scope.defer(() => void events.push(`-${id}`));
      },
    });
    const app: ApplicationManifest = {
      id: "a",
      features: [{ id: "f", bundles: [bundle("x"), bundle("y")] }],
    };
    const context: Context = {};
    loggerAdapter.set(context, newRecordingLogger().logger);
    const stop = await application(app)(context);
    expect(scopes.map((s) => s.closed)).toEqual([false, false]);
    await stop?.();
    expect(events).toEqual(["-y", "-x"]);
  });

  it("closing the answering scope rejects the claimed call as `abandoned` (D7), read as 'not completed'", async () => {
    const context: Context = {};
    const slots = getSlots(context);
    const cmd = defineCommand<void, number>("x:slow");
    const owner = newScope();
    owner.defer(answer(slots, cmd, "test", () => owner.task(later(1, 50))));
    const c = call(slots, cmd, undefined);
    await owner.close();
    const error = await c.promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).kind).toBe("abandoned");
    expect(describeError(error)).toBe("not completed");
  });
});

describe("drainCommits in scopes (K §4.4–4.5)", () => {
  it("handles records one at a time in submit order across actions, settling each", async () => {
    const bundle = newScope();
    const a = createCommitAction({ label: "A", queue: true, capture: () => "a" });
    const b = createCommitAction({ label: "B", queue: true, capture: () => "b" });
    const seen: string[] = [];
    drainCommits(
      own(bundle),
      on(a.control, async (v, { task }) => {
        seen.push(`${v}+`);
        await task(later(null));
        seen.push(`${v}-`);
      }),
      on(b.control, (v) => void seen.push(v)),
    );
    b.view.submit();
    a.view.submit();
    b.view.submit();
    expect(a.view.getState().running).toBe(true); // in the submit's own tick
    await later(null, 30);
    expect(seen).toEqual(["b", "a+", "a-", "b"]);
    expect(a.view.getState().running).toBe(false);
    expect(b.view.getState().running).toBe(false);
  });

  it("settles a record whose handler threw, and logs it", async () => {
    const bundle = newScope();
    const a = createCommitAction({ label: "A", capture: () => 1 });
    const errors: unknown[] = [];
    drainCommits(
      own(bundle, { error: (...args: unknown[]) => void errors.push(args) }),
      on(a.control, () => {
        throw new Error("bad");
      }),
    );
    a.view.submit();
    await flush();
    expect(a.view.getState().running).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it("a session's records outlive the session: handled in the bundle scope", async () => {
    const bundle = newScope();
    const session = bundle.child();
    const a = createCommitAction({ label: "A", capture: () => "v" });
    session.defer(() => a.dispose());
    const outcomes: string[] = [];
    drainCommits(
      { ...own(bundle), session },
      on(a.control, async (v, { task }) => {
        await task(later(null));
        outcomes.push(`done ${v}`);
      }),
    );
    a.view.submit();
    await session.close(); // before the drain even started
    await later(null, 30);
    expect(outcomes).toEqual(["done v"]);
  });

  it("closing the bundle drops the drain: an in-flight continuation and queued records never run", async () => {
    const bundle = newScope();
    const a = createCommitAction({ label: "Add", queue: true, capture: () => 0 });
    bundle.defer(() => a.dispose());
    const started: number[] = [];
    const finished: number[] = [];
    let n = 0;
    drainCommits(
      own(bundle),
      on(a.control, async (_, { task }) => {
        const me = ++n;
        started.push(me);
        await task(later(null, 10));
        finished.push(me);
      }),
    );
    a.view.submit();
    a.view.submit();
    a.view.submit();
    await flush();
    await bundle.close();
    await later(null, 50);
    expect(started).toEqual([1]);
    expect(finished).toEqual([]);
  });
});
