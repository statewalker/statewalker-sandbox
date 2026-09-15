import { createTodoListModel } from "../../src/lib/todos/list/list.model.impl.js";
import type { Todo } from "../../src/lib/todos/list/list.model.js";
import { modelContract } from "./model-contract.js";

modelContract<readonly Todo[]>("todos.list · visible (signals)", {
  make() {
    const m = createTodoListModel();
    let n = 0;
    return {
      read: m.view.getVisible,
      subscribe: m.view.onVisibleUpdate,
      change: () => {
        n++;
        m.control.replaceItems([{ id: `t${n}`, title: `todo ${n}`, done: false }]);
      },
      changeEqual: () => m.control.replaceItems(m.view.getItems().map((t) => ({ ...t }))),
      changeOther: () => m.view.setNewTitle(`draft ${++n}`),
      dispose: m.dispose,
    };
  },
});
