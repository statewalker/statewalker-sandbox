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
        m.control.replaceTodos([...m.control.getTodos(), { id: `t${seq}`, title: `todo ${seq}`, done: false }]);
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
      change: () => m.control.publishTotals({ created: ++n, closed: 0, reopened: 0, removed: 0, open: undefined }),
      changeEqual: () => m.control.publishTotals({ ...m.view.getTotals() }),
      changeOther: () => m.control.publishBaseline({ status: "known", total: ++n, done: 0 }),
      dispose: () => m.dispose(),
    };
  },
});
