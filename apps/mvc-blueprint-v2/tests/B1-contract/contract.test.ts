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
