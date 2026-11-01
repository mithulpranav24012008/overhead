import { defineConfig } from "vite";
// satellite.js also ships WebAssembly builds this page doesn't use, and they need a modern target to get through the bundler.
export default defineConfig({
  base: "./",
  build: { target: "es2022", chunkSizeWarningLimit: 1400, assetsInlineLimit: 0 },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  worker: { format: "es" },
  server: { port: 5310, strictPort: true },
  preview: { port: 5310, strictPort: true },
});
