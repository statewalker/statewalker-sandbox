import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { alias } from "./aliases.js";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias, conditions: ["source", "browser", "import", "module", "default"] },
  server: { fs: { allow: [fileURLToPath(new URL("../../", import.meta.url))] } },
});
