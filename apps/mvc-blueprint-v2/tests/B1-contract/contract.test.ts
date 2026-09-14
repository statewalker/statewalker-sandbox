import { createProgressBarModel } from "@progress/app";
import type { OperationProgress, RunningOperation } from "@sys";
import { StatsModel } from "@stats/app";
import { createTodoListModel } from "@todo/app";
import { modelContract } from "./model-contract.js";

let seq = 0;

modelContract("todo list · visible (signals)", {
  make() {
    const m = createTodoListModel();
    return {
      read: () => m.view.getVisible(),
      subscribe: (listener) => m.view.onVisibleUpdate(listener),
      change: () => {
        seq++;
        m.control.replaceTodos([
          ...m.control.getTodos(),
          { id: `t${seq}`, title: `todo ${seq}`, done: false },
        ]);
      },
      changeEqual: () => m.control.replaceTodos([...m.control.getTodos()]),
      changeOther: () => m.control.reportOutcome(`outcome ${++seq}`),
      dispose: () => m.dispose(),
    };
  },
});

modelContract("stats · totals (BaseClass)", {
  make() {
    const m = new StatsModel();
    let n = 0;
    return {
      read: () => m.view.getTotals(),
      subscribe: (listener) => m.view.onTotalsUpdate(listener),
      change: () =>
        m.control.publishTotals({
          created: ++n,
          closed: 0,
          reopened: 0,
          removed: 0,
          open: undefined,
        }),
      changeEqual: () => m.control.publishTotals({ ...m.view.getTotals() }),
      changeOther: () => m.control.publishBaseline({ status: "known", total: ++n, done: 0 }),
      dispose: () => m.dispose(),
    };
  },
});

function fakeOperation() {
  let progress: OperationProgress = { label: "work", done: 0, total: 10 };
  const listeners = new Set<() => void>();
  const operation: RunningOperation = {
    getProgress: () => progress,
    onProgressUpdate: (l) => {
      listeners.add(l);
      l();
      return () => listeners.delete(l);
    },
  };
  return {
    operation,
    set(done: number) {
      progress = { ...progress, done };
      for (const l of [...listeners]) l();
    },
  };
}

modelContract("progress · bar (plain listener set)", {
  make() {
    const source = fakeOperation();
    const m = createProgressBarModel(source.operation);
    let done = 0;
    return {
      read: () => m.view.getBar(),
      subscribe: (listener) => m.view.onBarUpdate(listener),
      change: () => source.set(++done),
      changeEqual: () => source.set(done),
      dispose: () => m.dispose(),
    };
  },
});
