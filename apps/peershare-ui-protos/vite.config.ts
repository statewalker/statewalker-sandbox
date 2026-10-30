import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Storybook's react-vite builder merges this config, so Tailwind and the
// `source` export condition apply to stories exactly as they do to the apps.
export default defineConfig({
  resolve: {
    conditions: ["source", "browser", "import", "module", "default"],
  },
  plugins: [react(), tailwindcss()],
});
