import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { alias } from "./aliases.js";

/** Two interpreters in one build: plain DOM (`.ts`) and Solid (`.tsx`). */
export default defineConfig({
  plugins: [solid(), tailwindcss()],
  resolve: { alias },
  server: { fs: { allow: [fileURLToPath(new URL("../../", import.meta.url))] } },
});
