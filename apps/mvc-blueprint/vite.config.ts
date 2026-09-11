import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
// The SAME alias table the suites resolve through, not a copy of it: its
// order is load-bearing (the specific `@todo/app/models` and `@todo/ui/adapter`
// must precede their prefixes — see the comment there), and a second copy is a
// second place to get that wrong. `vitest.browser.config.ts` imports it too.
import { alias } from "./vitest.config.js";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias,
    // Workspace packages resolve through their `source` condition, so a kit
    // linked from a sibling repo is read from src, not from a stale dist.
    conditions: ["source", "browser", "import", "module", "default"],
  },
  server: {
    fs: {
      // The workspace root: pnpm keeps every package under its node_modules/.pnpm.
      allow: [fileURLToPath(new URL("../../", import.meta.url))],
    },
  },
});
