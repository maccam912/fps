import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "src/client"),
  publicDir: resolve(__dirname, "assets"),
  resolve: {
    alias: { "@shared": resolve(__dirname, "src/shared") },
  },
  server: { port: 5173 },
  build: {
    outDir: resolve(__dirname, "dist/client"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 5000,
  },
});
