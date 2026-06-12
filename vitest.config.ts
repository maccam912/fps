import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: { alias: { "@shared": resolve(__dirname, "src/shared") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.omlx.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: "threads",
  },
});
