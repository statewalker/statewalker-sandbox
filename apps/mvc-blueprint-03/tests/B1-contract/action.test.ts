import { type ActionState, createAction, watchSubmits } from "@sys/action";
import { signal } from "@sys/signals";
import { describe, expect, it, vi } from "vitest";
import { modelContract } from "./model-contract.js";

modelContract<ActionState>("action · state (signals)", {
  make() {
    const action = createAction({ label: "Save" });
    let n = 0;
    return {
      read: action.view.getState,
      subscribe: action.view.onStateUpdate,
      change: () => action.control.update({ label: `Save ${++n}` }),
      changeEqual: () => action.control.update({ label: action.view.getState().label }),
      changeOther: () => action.view.submit(),
      dispose: action.dispose,
    };
  },
});

describe("B1 · ActionModel specifics", () => {
  it("starts idle and enabled, with the label, icon and hint it was given", () => {
    const action = createAction({ label: "Delete", icon: "trash-2", hint: "Delete the selection" });
    expect(action.view.getState()).toEqual({
      label: "Delete",
      icon: "trash-2",
      hint: "Delete the selection",
      enabled: true,
      running: false,
    });
    expect(action.control.getSubmits()).toBe(0);
  });

  it("submit raises a monotonic counter and notifies the submits channel", () => {
    const action = createAction({ label: "OK" });
    const listener = vi.fn();
    action.control.onSubmitsUpdate(listener);
    action.view.submit();
    action.view.submit();
    expect(action.control.getSubmits()).toBe(2);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("submit is ignored while disabled or running", () => {
    const action = createAction({ label: "OK", enabled: false });
    action.view.submit();
    expect(action.control.getSubmits()).toBe(0);
    action.control.update({ enabled: true, running: true });
    action.view.submit();
    expect(action.control.getSubmits()).toBe(0);
    action.control.update({ running: false });
    action.view.submit();
    expect(action.control.getSubmits()).toBe(1);
  });

  it("a `when` guard derives enabled from the owner's data, synchronously", () => {
    const selection = signal<string[]>([]);
    const action = createAction({ label: "Delete", when: () => selection().length > 0 });
    const listener = vi.fn();
    action.view.onStateUpdate(listener);
    expect(action.view.getState().enabled).toBe(false);
    selection(["a"]);
    expect(action.view.getState().enabled).toBe(true);
    action.view.submit(); // same tick as the data change
    expect(action.control.getSubmits()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("the base flag and the guard combine: both must allow", () => {
    const allowed = signal(true);
    const action = createAction({ label: "Edit", when: () => allowed() });
    action.control.update({ enabled: false });
    expect(action.view.getState().enabled).toBe(false);
    action.control.update({ enabled: true });
    allowed(false);
    expect(action.view.getState().enabled).toBe(false);
  });

  it("update is a patch: undefined fields stay, and one update notifies once", () => {
    const action = createAction({ label: "Save", icon: "save" });
    const listener = vi.fn();
    action.view.onStateUpdate(listener);
    action.control.update({ running: true, label: "Saving" });
    expect(listener).toHaveBeenCalledTimes(2);
    action.control.update({ icon: undefined });
    expect(action.view.getState()).toMatchObject({ label: "Saving", icon: "save", running: true });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("watchSubmits takes the submits made since the last take, once", () => {
    const action = createAction({ label: "Add" });
    action.view.submit();
    const watch = watchSubmits(action.control);
    expect(watch.take(), "submits before the watch are not its intents").toBe(false);
    action.view.submit();
    action.view.submit();
    expect(watch.take()).toBe(true);
    expect(watch.take()).toBe(false);
  });

  it("after dispose: submit and update are no-ops and the last state still reads", () => {
    const action = createAction({ label: "OK" });
    const listener = vi.fn();
    action.view.onStateUpdate(listener);
    action.dispose();
    action.view.submit();
    action.control.update({ label: "Changed" });
    expect(action.control.getSubmits()).toBe(0);
    expect(action.view.getState().label).toBe("OK");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(() => action.dispose()).not.toThrow();
  });
});
