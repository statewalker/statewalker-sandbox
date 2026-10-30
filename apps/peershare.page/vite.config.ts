import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** One page, two routes: `/peer-share` (the Sharer) and `/peer-share/invite` (a Guest). */
export default defineConfig({
  resolve: { conditions: ["source", "browser", "import", "module", "default"] },
  plugins: [react(), tailwindcss()],
  build: { rollupOptions: { input: resolve(import.meta.dirname, "index.html") } },
});
