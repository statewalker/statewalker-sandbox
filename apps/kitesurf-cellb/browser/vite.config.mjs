export default {
  build: { target: "es2022", outDir: "dist", copyPublicDir: false },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@statewalker/cellb"] },
};
