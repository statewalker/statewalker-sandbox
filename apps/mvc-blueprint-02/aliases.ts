import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * ONE alias table for the build and both test configs. Order is load-bearing:
 * Vite matches a string alias as a prefix, so `@sys/ui` must precede `@sys`.
 */
export const alias = {
  "@sys/ui": r("./src/lib/sys/ui.ts"),
  "@sys": r("./src/lib/sys/index.ts"),
  "@signals": r("./src/lib/signals/deps.ts"),
  "@todo/core": r("./src/lib/todo/core/index.ts"),
  "@todo/models": r("./src/lib/todo/app/models.ts"),
  "@todo/app": r("./src/lib/todo/app/index.ts"),
  "@todo/ui": r("./src/lib/todo/ui/index.ts"),
  "@logs/app": r("./src/lib/logs/app/index.ts"),
  "@stats/models": r("./src/lib/stats/app/models.ts"),
  "@stats/app": r("./src/lib/stats/app/index.ts"),
  "@stats/ui/dom": r("./src/lib/stats/ui/dom.ts"),
  "@stats/ui/react": r("./src/lib/stats/ui/react.ts"),
  "@progress/models": r("./src/lib/progress/app/models.ts"),
  "@progress/app": r("./src/lib/progress/app/index.ts"),
  "@progress/ui/dom": r("./src/lib/progress/ui/dom.ts"),
  "@ui/react": r("./src/lib/ui-react/index.ts"),
  "@ui/dom": r("./src/lib/ui-dom/index.ts"),
};
