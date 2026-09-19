import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { alias, SOLID_TSX } from "./aliases.js";

/** Two UI technologies in one build: Solid's `.tsx` by folder name, React's everywhere else. */
export default defineConfig({
  plugins: [solid({ include: SOLID_TSX }), react({ exclude: SOLID_TSX }), tailwindcss()],
  resolve: { alias },
  server: { fs: { allow: [fileURLToPath(new URL("../../", import.meta.url))] } },
});
