import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** `@p5/*` resolves through node_modules: every kernel, kit and bundle is a linked package (D13). */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { fs: { allow: [fileURLToPath(new URL("../../", import.meta.url))] } },
});
