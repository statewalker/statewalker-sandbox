import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { alias } from "./aliases.js";

/** Three UI technologies in one build: Svelte (`.svelte`), Solid (`.tsx`), Vue (render functions in `.ts`, no plugin). */
export default defineConfig({
  plugins: [svelte(), solid(), tailwindcss()],
  resolve: { alias },
  // Vue's esm-bundler build expects these compile-time flags.
  define: {
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
  },
  server: { fs: { allow: [fileURLToPath(new URL("../../", import.meta.url))] } },
});
