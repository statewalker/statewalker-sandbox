import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** ONE alias table for the build and both test configs. Longer keys first: a string alias matches as a prefix. */
export const alias = {
  "@sys/signals": r("./src/lib/sys/signals/deps.ts"),
  "@sys/context": r("./src/lib/sys/context.ts"),
  "@sys/model-kit": r("./src/lib/sys/model-kit.ts"),
  "@sys/update-loop": r("./src/lib/sys/update-loop.ts"),
  "@sys/attempt": r("./src/lib/sys/attempt.ts"),
  "@sys/extension-points": r("./src/lib/sys/extension-points.ts"),
  "@sys/action/model": r("./src/lib/sys/action/action.model.ts"),
  "@sys/action": r("./src/lib/sys/action/index.ts"),
  "@todos/core": r("./src/lib/todos/core/index.ts"),
  "@todos/events": r("./src/lib/todos/todos.commands.ts"),
  "@todos/list/model": r("./src/lib/todos/list/list.model.ts"),
  "@todos/list": r("./src/lib/todos/list/index.ts"),
  "@todos/edit/model": r("./src/lib/todos/edit/edit.model.ts"),
  "@todos/edit/commands": r("./src/lib/todos/edit/edit.commands.ts"),
  "@todos/edit": r("./src/lib/todos/edit/index.ts"),
  "@todos/clear-completed/model": r("./src/lib/todos/clear-completed/clear-completed.model.ts"),
  "@todos/clear-completed/commands": r(
    "./src/lib/todos/clear-completed/clear-completed.commands.ts",
  ),
  "@todos/clear-completed": r("./src/lib/todos/clear-completed/index.ts"),
  "@notifications/model": r("./src/lib/notifications/notifications.model.ts"),
  "@notifications/commands": r("./src/lib/notifications/notifications.commands.ts"),
  "@notifications": r("./src/lib/notifications/index.ts"),
  "@ui/host": r("./src/ui/host/index.ts"),
  "@ui/sys/action": r("./src/ui/sys/action/index.ts"),
  "@ui/todos/list": r("./src/ui/todos/list/index.ts"),
  "@ui/todos/edit": r("./src/ui/todos/edit/index.ts"),
  "@ui/todos/clear-completed": r("./src/ui/todos/clear-completed/index.ts"),
  "@ui/notifications": r("./src/ui/notifications/index.ts"),
};
