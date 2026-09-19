import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

/** Solid's JSX: its kit, shell host and renderers; React's: everything else. */
export const SOLID = [
  /\/kits\/solid\//,
  /\/bundles\/[^/]+\.solid\//,
  /\/bundles\/shell\/api\/solid\//,
];

/** `@p5/*` resolves through node_modules: every kernel, kit and bundle is a linked package (D13). */
export default defineConfig({
  plugins: [react({ exclude: SOLID }), solid({ include: SOLID }), tailwindcss()],
  server: { fs: { allow: [fileURLToPath(new URL("../../", import.meta.url))] } },
});
