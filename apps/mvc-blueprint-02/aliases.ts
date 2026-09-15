import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * ONE alias table for the build and both test configs. Order is load-bearing:
 * Vite matches a string alias as a prefix, so `@sys/ui` must precede `@sys`.
 */
export const alias = {
  "@sys/ui": r("./lib/sys/ui.ts"),
  "@sys": r("./lib/sys/index.ts"),
  "@signals": r("./lib/signals/deps.ts"),
  "@todo/core": r("./lib/todo/core/index.ts"),
  "@todo/models": r("./lib/todo/app/models.ts"),
  "@todo/app": r("./lib/todo/app/index.ts"),
  "@todo/ui": r("./lib/todo/ui/index.ts"),
  "@logs/app": r("./lib/logs/app/index.ts"),
  "@stats/models": r("./lib/stats/app/models.ts"),
  "@stats/app": r("./lib/stats/app/index.ts"),
  "@stats/ui/dom": r("./lib/stats/ui/dom.ts"),
  "@stats/ui/react": r("./lib/stats/ui/react.ts"),
  "@progress/models": r("./lib/progress/app/models.ts"),
  "@progress/app": r("./lib/progress/app/index.ts"),
  "@progress/ui/dom": r("./lib/progress/ui/dom.ts"),
  "@ui/react": r("./lib/ui-react/index.ts"),
  "@ui/dom": r("./lib/ui-dom/index.ts"),
};
