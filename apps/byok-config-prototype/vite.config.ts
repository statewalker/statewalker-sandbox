import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  // Resolve workspace packages through their `source` condition so the shadcn
  // primitives come from src (same convention as chat-mini / the nature harness).
  resolve: {
    conditions: ["source", "browser", "import", "module", "default"],
  },
  server: {
    port: 5179,
    fs: {
      allow: [fileURLToPath(new URL("../../", import.meta.url))],
    },
  },
});
