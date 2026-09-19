import type { HelloView } from "@p5/hello/api";
import { panelsSlot } from "@p5/shell/api";
import { type ActionState, type Context, getSlots, loggerAdapter } from "@p5/kernel";
import { createCommitAction } from "@p5/kit-commit";
import { createForm } from "@p5/kit-form";
import { createValue } from "@p5/kit-model";
import { describe, expect, it } from "vitest";
import { createCollectionModel } from "../../packages/bundles/todos.core/collection.model.js";
import { createListModel } from "../../packages/bundles/todos.list/list.model.js";
import { activateAlone } from "../support/activate.js";
import { newRecordingLogger } from "../support/logging.js";
import { modelContract } from "./model-contract.js";
import { plainAction, plainForm, plainPresentation } from "./plain-models.js";

// ── presentation ─────────────────────────────────────────────────────────────────────────────
modelContract("presentation · todos:collection todos (kit, signals)", {
  make() {
    const m = createCollectionModel();
    let n = 0;
    return {
      read: m.view.getTodos,
      subscribe: m.view.onTodosUpdate,
      change: () => m.control.publishTodos([{ id: `t${++n}`, title: `todo ${n}`, done: false }]),
      changeEqual: () => m.control.publishTodos(m.view.getTodos().map((t) => ({ ...t }))),
      dispose: m.dispose,
    };
  },
});

modelContract("presentation · todos:collection counts, a derived group (kit)", {
  make() {
    const m = createCollectionModel();
    let n = 0;
    return {
      read: m.view.getCounts,
      subscribe: m.view.onCountsUpdate,
      change: () =>
        m.control.publishTodos(
          Array.from({ length: ++n }, (_, i) => ({ id: `t${i}`, title: "x", done: false })),
        ),
      changeEqual: () =>
        m.control.publishTodos(m.view.getTodos().map((t) => ({ ...t, title: `${t.title}!` }))),
      dispose: m.dispose,
    };
  },
});

modelContract("presentation · createValue (kit)", {
  make() {
    const m = createValue({ text: "0" });
    let n = 0;
    return {
      read: m.get,
      subscribe: m.on,
      change: () => m.set({ text: String(++n) }),
      changeEqual: () => m.set({ ...m.get() }),
      dispose: m.dispose,
    };
  },
});

modelContract("presentation · hand-rolled", {
  make() {
    const m = plainPresentation({ count: 0 });
    return {
      read: m.view.get,
      subscribe: m.view.on,
      change: () => m.control.publish({ count: m.view.get().count + 1 }),
      changeEqual: () => m.control.publish({ ...m.view.get() }),
      dispose: m.dispose,
    };
  },
});

// ── form / input ─────────────────────────────────────────────────────────────────────────────
modelContract("form · contact editor draft (kit)", {
  make() {
    const m = createForm({ name: "Ada", email: "a@x", phone: "1" });
    let n = 0;
    return {
      read: m.view.getDraft,
      subscribe: m.view.onDraftUpdate,
      change: () => m.view.editField("name", `Ada ${++n}`),
      changeEqual: () => m.view.editField("name", m.view.getDraft().name),
      changeOther: () => m.control.reportErrors({ form: `e${++n}` }),
      dispose: m.dispose,
    };
  },
});

modelContract("form · todo editor draft (kit)", {
  make() {
    const m = createForm({ title: "Buy milk" });
    let n = 0;
    return {
      read: m.view.getDraft,
      subscribe: m.view.onDraftUpdate,
      change: () => m.view.editField("title", `t${++n}`),
      changeEqual: () => m.view.editField("title", m.view.getDraft().title),
      changeOther: () => m.control.reportErrors({ form: `e${++n}` }),
      dispose: m.dispose,
    };
  },
});

modelContract("input · todo list selection, derived from items (kit)", {
  make() {
    const m = createListModel();
    m.control.publishItems([
      { id: "a", title: "a", done: false },
      { id: "b", title: "b", done: false },
    ]);
    let flip = false;
    return {
      read: m.view.getSelection,
      subscribe: m.view.onSelectionUpdate,
      change: () => {
        flip = !flip;
        m.view.select([flip ? "a" : "b"]);
      },
      changeEqual: () => m.view.select([...m.view.getSelection()]),
      changeOther: () => m.view.setNewTitle(`x${Math.random()}`),
      dispose: m.dispose,
    };
  },
});

modelContract("form · hand-rolled", {
  make() {
    const m = plainForm({ title: "x" });
    let n = 0;
    return {
      read: m.view.getDraft,
      subscribe: m.view.onDraftUpdate,
      change: () => m.view.editField("title", `t${++n}`),
      changeEqual: () => m.view.editField("title", m.view.getDraft().title),
      changeOther: () => m.control.reportErrors({ form: `e${++n}` }),
      dispose: m.dispose,
    };
  },
});

// ── action ───────────────────────────────────────────────────────────────────────────────────
modelContract<ActionState>("action · createCommitAction state, running derived (kit)", {
  make() {
    const m = createCommitAction({ label: "Save", capture: () => undefined });
    let n = 0;
    return {
      read: m.view.getState,
      subscribe: m.view.onStateUpdate,
      change: () => m.control.update({ label: `Save ${++n}` }),
      changeEqual: () => m.control.update({ label: m.view.getState().label }),
      dispose: m.dispose,
    };
  },
});

modelContract("action · commit records group: view submits, controller settles (kit)", {
  make() {
    let n = 0;
    const m = createCommitAction({ label: "Add", queue: true, capture: () => n });
    return {
      read: m.control.getRecords,
      subscribe: m.control.onRecordsUpdate,
      change: () => {
        n++;
        m.view.submit(); // one intention: one record appended
      },
      changeEqual: () => m.control.settle(0),
      changeOther: () => m.control.update({ label: `L${++n}` }),
      dispose: m.dispose,
    };
  },
});

modelContract<ActionState>("action · hand-rolled", {
  make() {
    const m = plainAction("Save");
    let n = 0;
    return {
      read: m.view.getState,
      subscribe: m.view.onStateUpdate,
      change: () => m.control.update({ label: `Save ${++n}` }),
      changeEqual: () => m.control.update({ label: m.view.getState().label }),
      changeOther: () => m.view.submit(),
      dispose: m.dispose,
    };
  },
});

// ── the hello bundle's hand-rolled presentation, through its controller ─────────────────────
describe("presentation · hello (hand-rolled, kernel only)", () => {
  it("passes the contract points it can express through the bundle", async () => {
    const { default: hello } = await import("@p5/hello");
    const ctx: Context = {};
    loggerAdapter.set(ctx, newRecordingLogger().logger);
    const stop = await activateAlone(hello, ctx);
    const view = getSlots(ctx).getSnapshot(panelsSlot).get("hello")?.model as HelloView;
    const seen: number[] = [];
    const off = view.onCountUpdate(() => seen.push(view.getCount()));
    expect(seen).toEqual([0]); // point 1
    view.increment.submit();
    view.increment.submit();
    expect(seen).toEqual([0, 1, 2]); // points 2, 4
    off();
    off(); // idempotent
    await stop?.();
    view.increment.submit();
    expect(view.getCount()).toBe(2); // point 8
  });
});

// ── point 9: a coarse write is a patch; undefined means "leave it" ────────────────────────────
describe("point 9 · action update is a patch", () => {
  for (const [name, make] of [
    ["kit", () => createCommitAction({ label: "Go", hint: "h", capture: () => undefined })],
    ["hand-rolled", () => plainAction("Go")],
  ] as const) {
    it(`${name}: an undefined field leaves the value`, () => {
      const m = make();
      m.control.update({ hint: "h2", label: undefined });
      expect(m.view.getState()).toMatchObject({ label: "Go", hint: "h2" });
    });
  }
});
