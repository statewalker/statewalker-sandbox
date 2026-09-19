import { answer, defineCommand, KernelSlots, newScope } from "@p5/kernel";
import { createCommitAction, drainCommits, each, on, session } from "@p5/kit-commit";
import { newNotifier } from "@p5/kit-notify";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * P5.1 — the drain's seams, as the independent analysis probed them (W2–W5, W7, W12). Each test
 * is a probe of the analysis inverted: what it observed is now refused or impossible.
 */
const later = <T>(value: T, ms = 5) => new Promise<T>((r) => setTimeout(() => r(value), ms));
const silent = { error: () => {} };
const drainIn = (scope = newScope(), slots = new KernelSlots()) => ({ scope, slots, log: silent });

describe("P5.1 drain seams", () => {
  afterEach(() => vi.restoreAllMocks());

  it("C1 → a control is drained by one drain only: a second drain throws (W4)", () => {
    const a = createCommitAction({ label: "A", capture: () => 1 });
    const d = drainIn();
    drainCommits(
      d,
      on(a.control, () => {}),
    );
    expect(() =>
      drainCommits(
        d,
        on(a.control, () => {}),
      ),
    ).toThrow(/already drained/);
  });

  it("C2 → submit() reports whether a record was accepted (W5)", () => {
    const a = createCommitAction({ label: "A", capture: () => 1 });
    expect(a.view.submit()).toBe(true);
    expect(a.view.submit()).toBe(false); // refused: running
    const off = createCommitAction({ label: "B", enabled: false, capture: () => 1 });
    expect(off.view.submit()).toBe(false);
  });

  it("C4/C5 → a throwing or non-cloneable capture refuses and logs; it never throws into the view (W12)", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing = createCommitAction<number>({
      label: "Throws",
      capture: () => {
        throw new Error("capture bug");
      },
    });
    const uncloneable = createCommitAction({ label: "Fn", capture: () => ({ f: () => 1 }) });
    expect(throwing.view.submit()).toBe(false);
    expect(uncloneable.view.submit()).toBe(false);
    expect(throwing.control.getRecords()).toEqual([]);
    expect(uncloneable.view.getState().running).toBe(false);
    expect(logged).toHaveBeenCalledTimes(2);
  });

  it("C3/A1 → lanes: a Cancel in its own drain is handled while a Save hangs (W2)", async () => {
    const bundle = newScope();
    const editor = bundle.child();
    const save = createCommitAction({ label: "Save", capture: () => 1 });
    const cancel = createCommitAction({ label: "Cancel", capture: () => undefined });
    const d = { ...drainIn(bundle), session: editor };
    drainCommits(
      d,
      on(save.control, (_, { task }) => task(new Promise(() => {}))),
    );
    drainCommits(
      d,
      on(cancel.control, () => void editor.close()),
    );
    save.view.submit();
    await later(null);
    cancel.view.submit();
    await later(null);
    expect(editor.closed).toBe(true);
    expect(cancel.view.getState().running).toBe(false);
  });

  it("the drain's owner is explicit: a session's accepted records are handled after it closed", async () => {
    const bundle = newScope();
    const editor = bundle.child();
    const a = createCommitAction({ label: "A", capture: () => "v" });
    editor.defer(() => a.dispose());
    const seen: string[] = [];
    let signal: AbortSignal | undefined;
    drainCommits(
      { ...drainIn(bundle), session: editor },
      on(a.control, async (v, turn) => {
        signal = turn.signal;
        await turn.task(later(null));
        seen.push(v);
      }),
    );
    a.view.submit();
    await editor.close();
    await later(null, 20);
    expect(seen).toEqual(["v"]);
    expect(signal?.aborted).toBe(true); // the record's signal: its session closed
  });

  it("S1 → turn.call refuses to dispatch once the owner closed, even after a bare await (W3)", async () => {
    const slots = new KernelSlots();
    const cmd = defineCommand<void, void>("t:write");
    const writes: string[] = [];
    answer(slots, cmd, async () => void writes.push("written"));
    const bundle = newScope();
    const a = createCommitAction({ label: "A", capture: () => 1 });
    let settled = false;
    drainCommits(
      drainIn(bundle, slots),
      on(a.control, async (_, turn) => {
        await later(null, 10); // a bare await: R11 flags it; the verb still guards
        await turn.call(cmd, undefined).then(() => (settled = true));
      }),
    );
    a.view.submit();
    await later(null, 1);
    await bundle.close();
    await later(null, 30);
    expect(writes).toEqual([]);
    expect(settled).toBe(false);
  });

  it("S3 → task(fn) does not start the work on a closed scope (W7)", async () => {
    const s = newScope();
    await s.close();
    let ran = false;
    void s.task(async () => {
      ran = true;
    });
    expect(ran).toBe(false);
  });

  it("each(): a stream is consumed while the scope is open and returned when it closes (W3)", async () => {
    const s = newScope();
    const seen: number[] = [];
    let returned = false;
    async function* stream() {
      try {
        for (let i = 1; ; i++) yield await later(i, 5);
      } finally {
        returned = true;
      }
    }
    void each(s, stream(), (n) => void seen.push(n));
    await later(null, 18);
    await s.close();
    const at = seen.length;
    await later(null, 30);
    expect(at).toBeGreaterThanOrEqual(2);
    expect(seen).toHaveLength(at);
    expect(returned).toBe(true);
  });

  it("session(): a child scope built at once, resolving when it closes (W18)", async () => {
    const bundle = newScope();
    let inner: ReturnType<typeof newScope> | undefined;
    let done = false;
    const closed = session(bundle, (s) => {
      inner = s;
    }).then(() => (done = true));
    expect(inner?.closed).toBe(false);
    await inner?.close();
    await closed;
    expect(done).toBe(true);
  });

  it("N1 → the notifier keeps nothing once a notification is withdrawn (W11)", async () => {
    const slots = new KernelSlots();
    const warned: unknown[] = [];
    const notifier = newNotifier(slots, 1, { warn: (...a: unknown[]) => void warned.push(a) });
    for (let i = 0; i < 100; i++) notifier.notify({ message: `n${i}`, tone: "info" });
    notifier.fail("bad");
    expect(notifier.size).toBe(101);
    await later(null, 20);
    expect(notifier.size).toBe(0);
    expect(warned).toHaveLength(1); // fail() logs, notify() does not
  });
});
