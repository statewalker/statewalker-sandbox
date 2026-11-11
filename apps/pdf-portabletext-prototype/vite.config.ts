import { pdfPortableText } from "@statewalker/pdf-portabletext/vite";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [pdfPortableText()],
  server: { port: 5181 },
});
