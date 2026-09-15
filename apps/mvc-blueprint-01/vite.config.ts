import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
// The SAME alias table the suites resolve through, not a copy of it: its
// order is load-bearing (see `aliases.ts`). Imported from its own module, so
// building the app never loads `vitest/config`.
import { alias } from "./aliases.js";

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
